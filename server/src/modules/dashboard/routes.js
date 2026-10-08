'use strict';

/**
 * Dashboard inicial — indicadores enxutos e expansíveis.
 * Estrutura preparada para receber vendas, metas, tarefas etc. no futuro.
 */

const express = require('express');
const db = require('../../database/connection');
const { ok } = require('../../core/http');
const { requirePermission, tenantId } = require('../../middlewares/auth');

const router = express.Router();

router.get('/summary', requirePermission('dashboard.view'), async (req, res) => {
  const companyId = tenantId(req);

  if (companyId === null) {
    // Visão de plataforma (Master)
    const companies = (await db.prepare(`SELECT COUNT(*) AS c FROM companies`).get()).c;
    const activeCompanies = (await db.prepare(`SELECT COUNT(*) AS c FROM companies WHERE status = 'active'`).get()).c;
    const users = (await db.prepare(`SELECT COUNT(*) AS c FROM users WHERE company_id IS NOT NULL`).get()).c;
    const recent = await db.prepare(
      `SELECT a.action, a.entity, a.created_at, u.name AS user_name, c.name AS company_name
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN companies c ON c.id = a.company_id
       ORDER BY a.id DESC LIMIT 6`
    ).all();
    return ok(res, {
      scope: 'platform',
      cards: [
        { key: 'companies_total', label: 'Empresas cadastradas', value: companies },
        { key: 'companies_active', label: 'Empresas ativas', value: activeCompanies },
        { key: 'users_total', label: 'Usuários das empresas', value: users },
        { key: 'stores_total', label: 'Lojas no total', value: (await db.prepare('SELECT COUNT(*) AS c FROM stores').get()).c },
      ],
      recent_activity: recent,
    });
  }

  // Visão de empresa (tenant) — TODAS as consultas filtradas por companyId
  const storesTotal = (await db.prepare('SELECT COUNT(*) AS c FROM stores WHERE company_id = ?').get(companyId)).c;
  const storesActive = (await db.prepare(`SELECT COUNT(*) AS c FROM stores WHERE company_id = ? AND status = 'active'`).get(companyId)).c;
  const usersTotal = (await db.prepare('SELECT COUNT(*) AS c FROM users WHERE company_id = ?').get(companyId)).c;
  const usersActive = (await db.prepare(`SELECT COUNT(*) AS c FROM users WHERE company_id = ? AND status = 'active'`).get(companyId)).c;
  const recent = await db.prepare(
    `SELECT a.action, a.entity, a.created_at, u.name AS user_name
     FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.company_id = ? ORDER BY a.id DESC LIMIT 6`
  ).all(companyId);

  // Cards de Vendas — somente quando o módulo está ativo para a empresa
  const cards = [
    { key: 'stores_active', label: 'Lojas ativas', value: storesActive, hint: `${storesTotal} no total` },
    { key: 'users_active', label: 'Usuários ativos', value: usersActive, hint: `${usersTotal} cadastrados` },
    { key: 'my_role', label: 'Sua função', value: req.auth.role.name, hint: 'permissões conforme o perfil' },
    { key: 'last_login', label: 'Último acesso', value: req.auth.user.lastLoginAt || '—', hint: 'desta conta' },
  ];
  const { isModuleActive } = require('../../core/modules');
  if (await isModuleActive(companyId, 'sales')) {
    const sm = await require('../sales/service').monthSummary(companyId);
    const brl = (cents) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    cards.push({ key: 'sales_month_count', label: 'Vendas no mês', value: String(sm.count), hint: 'registros ativos' });
    cards.push({ key: 'sales_month_total', label: 'Total vendido no mês', value: brl(sm.total_cents), hint: 'vendas ativas' });
  }
  if (await isModuleActive(companyId, 'targets')) {
    const tm = await require('../targets/service').monthSummary(companyId);
    const brl = (cents) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    cards.push({
      key: 'targets_month',
      label: 'Metas do mês',
      value: tm.count ? `${tm.count} meta(s)` : '—',
      hint: tm.count ? `meta total ${brl(tm.target_cents)}` : 'nenhuma meta ativa no período',
    });
  }
  if (await isModuleActive(companyId, 'ranking')) {
    const leader = await require('../ranking/service').monthLeader(companyId);
    cards.push({
      key: 'ranking_leader',
      label: 'Líder do mês',
      value: leader ? leader.name : '—',
      hint: leader ? `${(leader.total_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} vendidos` : 'sem vendas no mês',
    });
  }
  if (await isModuleActive(companyId, 'receivables')) {
    const rs = await require('../receivables/service').summary(companyId);
    const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    cards.push({ key: 'receivables_open', label: 'A receber', value: brl(rs.open_cents), hint: `${rs.open_count} título(s) em aberto` });
    cards.push({ key: 'receivables_overdue', label: 'Recebíveis vencidos', value: brl(rs.overdue_cents), hint: `${rs.overdue_count} título(s)` });
  }

  // Bloco operacional V1 (v3.4) — cada pedaço só existe se o módulo estiver
  // ativo. Integração OPCIONAL: falha em qualquer pedaço não derruba o
  // dashboard (try por bloco) e nenhum módulo antigo depende desses dados.
  const operations = {};
  try {
    const { businessToday } = require('../../core/businessDate');
    const today = await businessToday(companyId);
    if (await isModuleActive(companyId, 'tasks')) {
      operations.tasks_overdue = await db.prepare(
        `SELECT t.id, t.title, t.due_date FROM tasks t
         WHERE t.company_id = ? AND t.status IN ('pending','in_progress')
           AND t.due_date IS NOT NULL AND t.due_date < ?
         ORDER BY t.due_date ASC LIMIT 5`).all(companyId, today);
      operations.tasks_today = await db.prepare(
        `SELECT t.id, t.title, t.due_date FROM tasks t
         WHERE t.company_id = ? AND t.status IN ('pending','in_progress') AND t.due_date = ?
         ORDER BY t.id ASC LIMIT 5`).all(companyId, today);
    }
    if (await isModuleActive(companyId, 'agenda')) {
      await require('../notifications/service').generateAgendaReminders(companyId);
      operations.agenda_today = await db.prepare(
        `SELECT e.id, e.title, e.start_at, e.end_at, e.all_day FROM agenda_events e
         WHERE e.company_id = ? AND e.status = 'scheduled' AND substr(e.start_at, 1, 10) = ?
         ORDER BY e.start_at ASC LIMIT 5`).all(companyId, today);
    }
    if (await isModuleActive(companyId, 'checklists')) {
      operations.checklists_pending = await db.prepare(
        `SELECT cl.id, cl.title, cl.due_date,
           (SELECT COUNT(*) FROM checklist_items i WHERE i.checklist_id = cl.id) AS items_total,
           (SELECT COUNT(*) FROM checklist_items i WHERE i.checklist_id = cl.id AND i.completed = 1) AS items_done
         FROM checklists cl
         WHERE cl.company_id = ? AND cl.status IN ('pending','in_progress')
         ORDER BY CASE WHEN cl.due_date IS NULL THEN 1 ELSE 0 END, cl.due_date ASC LIMIT 5`).all(companyId);
    }
    if (await isModuleActive(companyId, 'notifications')) {
      const nsvc = require('../notifications/service');
      operations.notifications_unread = await nsvc.unreadCount(req.auth.user.id);
    }
  } catch { /* bloco operacional indisponível — dashboard segue sem ele */ }

  return ok(res, {
    scope: 'company',
    company: req.auth.company,
    my_store: req.auth.store,
    cards,
    operations,
    recent_activity: recent,
  });
});

module.exports = router;
