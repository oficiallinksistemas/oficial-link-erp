'use strict';

/**
 * NOTIFICAÇÕES — infraestrutura operacional da empresa (v3.4).
 *
 * - Deduplicação obrigatória: UNIQUE (company_id, user_id, dedupe_key) +
 *   INSERT OR IGNORE → gerar o mesmo evento N vezes nunca cria spam.
 * - Módulo é infraestrutura: notify() VERIFICA a ativação do módulo e
 *   simplesmente não insere quando desligado — a operação que originou o
 *   evento NUNCA quebra por causa de notificações. Falhas internas são
 *   engolidas (logged em dev) para nunca derrubar a operação principal.
 * - action_url só aceita rotas internas ('#/...' ou '/...') — nunca
 *   javascript:, protocol-relative ou URL externa.
 * - company_id SEMPRE informado pelo gerador (que o deriva de contexto
 *   seguro — nunca de parâmetro de cliente).
 */

const db = require('../../database/connection');
const { badRequest } = require('../../core/errors');
const { businessToday } = require('../../core/businessDate');

const TYPES = Object.freeze([
  'task_assigned', 'task_due', 'task_overdue',
  'agenda_created', 'agenda_reminder',
  'checklist_assigned', 'checklist_due', 'checklist_overdue',
  'financial_overdue', 'target_reached', 'system',
]);

const ACTION_URL_RE = /^#\/[a-z0-9\-_/]*$/i;

async function notificationsActive(companyId) {
  return !!await db.prepare(
    'SELECT 1 AS x FROM company_modules WHERE company_id = ? AND module_slug = ? AND status = ?'
  ).get(companyId, 'notifications', 'active');
}

async function isActiveCompanyUser(userId, companyId) {
  const u = await db.prepare(
    `SELECT u.id FROM users u JOIN companies c ON c.id = u.company_id
     WHERE u.id = ? AND u.company_id = ? AND u.status = 'active' AND c.status = 'active'`
  ).get(userId, companyId);
  return !!u;
}

/**
 * Cria notificação (idempotente por dedupe_key). Silenciosa quando o
 * módulo está desativado ou o destinatário é inválido. Nunca lança erro
 * para o chamador — notificação não pode derrubar a operação principal.
 */
async function notify({ companyId, userId, type, title, message, priority = 'normal', entityType, entityId, actionUrl, dedupeKey }) {
  try {
    if (!TYPES.includes(type)) return;
    if (!Number.isInteger(companyId) || !Number.isInteger(userId)) return;
    if (!await notificationsActive(companyId)) return;
    if (!await isActiveCompanyUser(userId, companyId)) return;
    const t = String(title || '').trim().slice(0, 140);
    if (!t) return;
    const msg = message ? String(message).trim().slice(0, 400) : null;
    const pr = ['low', 'normal', 'high', 'urgent'].includes(priority) ? priority : 'normal';
    let url = null;
    if (actionUrl) {
      const s = String(actionUrl).trim();
      if (ACTION_URL_RE.test(s)) url = s.slice(0, 200);
    }
    const key = String(dedupeKey || `${type}:${entityType || ''}:${entityId ?? ''}`).slice(0, 120);
    await db.prepare(
      `INSERT OR IGNORE INTO notifications
         (company_id, user_id, type, title, message, priority, entity_type, entity_id, action_url, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(companyId, userId, type, t, msg, pr, entityType || null, entityId ?? null, url, key);
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') console.error('[notifications]', err.message);
  }
}

// ---------------------------------------------------------------------------
// Consultas da central
// ---------------------------------------------------------------------------
async function unreadCount(userId) {
  return (await db.prepare(
    'SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL'
  ).get(userId)).c;
}

async function list({ userId, read, type, page, perPage }) {
  const where = ['n.user_id = ?'];
  const params = [userId];
  if (read === 'unread') where.push('n.read_at IS NULL');
  if (read === 'read') where.push('n.read_at IS NOT NULL');
  if (type) { if (!TYPES.includes(type)) throw badRequest('Tipo inválido.'); where.push('n.type = ?'); params.push(type); }
  const w = ` WHERE ${where.join(' AND ')}`;
  const total = (await db.prepare(`SELECT COUNT(*) AS c FROM notifications n${w}`).get(...params)).c;
  const items = await db.prepare(
    `SELECT n.id, n.type, n.title, n.message, n.priority, n.read_at, n.created_at,
            n.entity_type, n.entity_id, n.action_url
     FROM notifications n${w} ORDER BY n.id DESC LIMIT ? OFFSET ?`
  ).all(...params, perPage, perPage * (page - 1));
  return { items, total };
}

async function recent(userId, limit = 6) {
  return await db.prepare(
    `SELECT id, type, title, message, priority, read_at, action_url
     FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?`
  ).all(userId, limit);
}

async function markRead(id, userId) {
  const n = await db.prepare('SELECT id FROM notifications WHERE id = ? AND user_id = ?').get(id, userId);
  if (!n) return false;
  // UPDATE único — atômico por si só (tx desnecessária).
  await db.prepare(
    'UPDATE notifications SET read_at = datetime(\'now\') WHERE id = ? AND user_id = ? AND read_at IS NULL'
  ).run(id, userId);
  return true;
}

async function markAllRead(userId) {
  return (await db.prepare(
    'UPDATE notifications SET read_at = datetime(\'now\') WHERE user_id = ? AND read_at IS NULL'
  ).run(userId)).changes;
}

// ---------------------------------------------------------------------------
// Geradores (deduplicados; chamados em leituras dos módulos de origem)
// ---------------------------------------------------------------------------

/** Tarefas pending/in_progress vencidas → uma notificação por tarefa.
 *  Chamado nas leituras de tarefas DA EMPRESA DO CONTEXTO (fuso exato). */
async function txGenTaskOverdue(companyId, today) {
  const rows = await db.prepare(
    `SELECT t.id, t.title, t.assigned_to_user_id
     FROM tasks t WHERE t.company_id = ? AND t.status IN ('pending','in_progress')
       AND t.due_date IS NOT NULL AND t.due_date < ? AND t.assigned_to_user_id IS NOT NULL`
  ).all(companyId, today);
  for (const r of rows) {
    notify({
      companyId, userId: r.assigned_to_user_id, type: 'task_overdue',
      title: `Tarefa atrasada: ${r.title}`,
      message: 'Esta tarefa passou do prazo.',
      priority: 'high', entityType: 'task', entityId: r.id,
      actionUrl: '#/tarefas', dedupeKey: `task_overdue:${r.id}`,
    });
  }
}

async function generateTaskOverdue(companyId) { await txGenTaskOverdue(companyId, await businessToday(companyId)); }

/** Compromissos de hoje (ou já passados do dia corrente) ainda não
 *  realizados → lembrete por evento/dia para os admins. */
async function txGenAgendaReminders(companyId, today) {
  const rows = await db.prepare(
    `SELECT id, title, substr(start_at, 1, 10) AS day
     FROM agenda_events WHERE company_id = ? AND status = 'scheduled'
       AND substr(start_at, 1, 10) <= ?`
  ).all(companyId, today);
  for (const r of rows) {
    notifyAdmins(companyId, {
      type: 'agenda_reminder', title: `Compromisso ${r.day === today ? 'hoje' : 'pendente'}: ${r.title}`,
      priority: 'normal', entityType: 'agenda_event', entityId: r.id,
      actionUrl: '#/agenda', dedupeKey: `agenda_reminder:${r.id}:${r.day}`,
    });
  }
}

async function generateAgendaReminders(companyId) { await txGenAgendaReminders(companyId, await businessToday(companyId)); }

/** Checklists pending/in_progress vencidos → uma notificação por checklist. */
async function txGenChecklistDue(companyId, today) {
  const rows = await db.prepare(
    `SELECT id, title, assigned_to_user_id
     FROM checklists WHERE company_id = ? AND status IN ('pending','in_progress')
       AND due_date IS NOT NULL AND due_date < ? AND assigned_to_user_id IS NOT NULL`
  ).all(companyId, today);
  for (const r of rows) {
    notify({
      companyId, userId: r.assigned_to_user_id, type: 'checklist_overdue',
      title: `Checklist atrasado: ${r.title}`, priority: 'high',
      entityType: 'checklist', entityId: r.id, actionUrl: '#/checklists',
      dedupeKey: `checklist_overdue:${r.id}`,
    });
  }
}

async function generateChecklistDue(companyId) { await txGenChecklistDue(companyId, await businessToday(companyId)); }

/** Títulos financeiros vencidos (payables/receivables) → admins, 1x por título.
 *  Integração OPCIONAL: lê as tabelas sem tocar nos módulos de origem. */
async function txGenFinancialOverdue(companyId, today) {
  const pay = await db.prepare(
    `SELECT ap.id, ap.description FROM accounts_payable ap
     WHERE ap.company_id = ? AND ap.status = 'open' AND ap.due_date < ?`
  ).all(companyId, today);
  const rec = await db.prepare(
    `SELECT ar.id, ar.description FROM accounts_receivable ar
     WHERE ar.company_id = ? AND ar.status = 'open' AND ar.due_date < ?`
  ).all(companyId, today);
  for (const r of pay) notifyAdmins(companyId, {
    type: 'financial_overdue', title: `Título vencido: ${r.description || `#${r.id}`}`,
    priority: 'high', entityType: 'payable', entityId: r.id,
    actionUrl: '#/contas-a-pagar', dedupeKey: `financial_overdue:payable:${r.id}`,
  });
  for (const r of rec) notifyAdmins(companyId, {
    type: 'financial_overdue', title: `Recebimento vencido: ${r.description || `#${r.id}`}`,
    priority: 'high', entityType: 'receivable', entityId: r.id,
    actionUrl: '#/contas-a-receber', dedupeKey: `financial_overdue:receivable:${r.id}`,
  });
}

async function generateFinancialOverdue(companyId) { await txGenFinancialOverdue(companyId, await businessToday(companyId)); }

/** Usuários admin ativos da empresa (destino de notificações coletivas). */
async function notifyAdmins(companyId, payload) {
  const admins = await db.prepare(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.company_id = ? AND u.status = 'active' AND r.slug = 'company_admin'`
  ).all(companyId);
  for (const a of admins) await notify({ companyId, userId: a.id, ...payload });
}

module.exports = {
  TYPES, notify, unreadCount, list, recent, markRead, markAllRead,
  generateTaskOverdue, generateAgendaReminders, generateChecklistDue, generateFinancialOverdue,
  notifyAdmins,
};
