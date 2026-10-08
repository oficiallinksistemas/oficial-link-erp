'use strict';

/**
 * CHECKLISTS — rotinas operacionais V1 (v3.4).
 * Progresso é SEMPRE calculado no backend (SUM/COUNT) — o frontend nunca
 * envia percentual. Conclusão exige todos os itens OBRIGATÓRIOS concluídos
 * (bloqueio no servidor). Itens são linhas da execução: execuções nunca
 * compartilham estado (modelos futuros não reescrevem histórico).
 * company_id SEMPRE da sessão.
 */

const db = require('../../database/connection');
const { badRequest, notFound, conflict } = require('../../core/errors');
const notifications = require('../notifications/service');

const STATUSES = ['pending', 'in_progress', 'completed', 'canceled'];
const PROGRESS_SQL = `SELECT COUNT(*) AS total,
    SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) AS done
  FROM checklist_items WHERE checklist_id = ?`;

const SELECT = `
  SELECT cl.id, cl.company_id, cl.store_id, s.name AS store_name, cl.title, cl.description,
         cl.status, cl.assigned_to_user_id, ua.name AS assigned_to_name,
         cl.due_date, cl.template_name, cl.completed_at,
         cl.created_by_user_id, uc.name AS created_by_name, cl.created_at
  FROM checklists cl
  LEFT JOIN stores s ON s.id = cl.store_id
  LEFT JOIN users ua ON ua.id = cl.assigned_to_user_id
  JOIN users uc ON uc.id = cl.created_by_user_id`;

async function withProgress(row) {
  if (!row) return row;
  const p = await db.prepare(PROGRESS_SQL).get(row.id);
  const total = p.total || 0;
  const done = p.done || 0;
  return { ...row, items_total: total, items_done: done, progress: total ? Math.round((done / total) * 100) : 0 };
}

async function getChecklist(companyId, id) {
  const row = await db.prepare(`${SELECT} WHERE cl.company_id = ? AND cl.id = ?`).get(companyId, id);
  return await withProgress(row);
}

async function getItems(checklistId) {
  return await db.prepare(
    `SELECT id, title, description, position, required, completed, completed_at
     FROM checklist_items WHERE checklist_id = ? ORDER BY position ASC, id ASC`
  ).all(checklistId);
}

async function validateAssignee(companyId, userId) {
  if (userId === null || userId === undefined || userId === '') return null;
  const n = Number(userId);
  if (!Number.isInteger(n) || !await db.prepare('SELECT 1 AS x FROM users WHERE id = ? AND company_id = ? AND status = \'active\'').get(n, companyId)) {
    throw badRequest('Responsável não encontrado nesta empresa.');
  }
  return n;
}

async function validateStore(companyId, storeId) {
  if (storeId === null || storeId === undefined || storeId === '') return null;
  const n = Number(storeId);
  if (!Number.isInteger(n) || !await db.prepare('SELECT 1 AS x FROM stores WHERE id = ? AND company_id = ?').get(n, companyId)) {
    throw badRequest('Loja não encontrada nesta empresa.');
  }
  return n;
}

function validateDueDate(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw badRequest('Prazo inválido (AAAA-MM-DD).');
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (!(dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d)) throw badRequest('Prazo inválido.');
  return value;
}

function validateItemsInput(items) {
  if (!Array.isArray(items) || items.length < 1) throw badRequest('Informe ao menos 1 item.');
  if (items.length > 50) throw badRequest('Máximo de 50 itens por checklist.');
  return items.map((it, i) => {
    const title = String(it.title || '').trim();
    if (title.length < 2 || title.length > 140) throw badRequest(`Item ${i + 1}: título inválido.`);
    return {
      title,
      description: it.description ? String(it.description).trim().slice(0, 400) : null,
      position: Number.isInteger(Number(it.position)) ? Number(it.position) : i + 1,
      required: it.required === true || it.required === 1 || it.required === '1' ? 1 : 0,
    };
  });
}

async function txCreate(companyId, data, items, userId) {
  // Guard-first: INSERT da checklist (id de referência) e itens em batch
  // atômico (mesma ordem semântica da transação original).
  const id = (await db.prepare(
    `INSERT INTO checklists (company_id, store_id, title, description, status,
       assigned_to_user_id, due_date, template_name, created_by_user_id)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
  ).run(companyId, data.storeId, data.title, data.description, data.assigned, data.due,
    data.templateName, userId)).lastInsertRowid;
  await db.batch(items.map((it) => ({
    sql: 'INSERT INTO checklist_items (checklist_id, title, description, position, required) VALUES (?, ?, ?, ?, ?)',
    params: [id, it.title, it.description, it.position, it.required],
  })));
  return id;
}

async function create(companyId, body, userId) {
  const title = String(body.title || '').trim();
  if (title.length < 3 || title.length > 120) throw badRequest('Título deve ter 3 a 120 caracteres.');
  const description = body.description ? String(body.description).trim().slice(0, 1000) : null;
  const items = validateItemsInput(body.items);
  const assigned = await validateAssignee(companyId, body.assigned_to_user_id);
  const storeId = await validateStore(companyId, body.store_id);
  const due = validateDueDate(body.due_date);
  const templateName = body.template ? String(body.template).trim().slice(0, 80) : null;
  const id = await txCreate(companyId, { title, description, assigned, storeId, due, templateName }, items, userId);
  if (assigned && assigned !== userId) {
    await notifications.notify({
      companyId, userId: assigned, type: 'checklist_assigned',
      title: `Checklist atribuído a você: ${title}`,
      entityType: 'checklist', entityId: id, actionUrl: '#/checklists',
      dedupeKey: `checklist_assigned:${id}`,
    });
  }
  const cl = await getChecklist(companyId, id);
  cl.items = await getItems(id);
  return cl;
}

async function list(companyId, q) {
  await notifications.generateChecklistDue(companyId);
  const where = ['cl.company_id = ?'];
  const params = [companyId];
  if (q.search) { where.push('(cl.title LIKE ? OR cl.description LIKE ?)'); params.push(`%${q.search}%`, `%${q.search}%`); }
  if (q.status) { if (!STATUSES.includes(q.status)) throw badRequest('Status inválido.'); where.push('cl.status = ?'); params.push(q.status); }
  if (q.assigned_to) { where.push('cl.assigned_to_user_id = ?'); params.push(Number(q.assigned_to)); }
  const w = ` WHERE ${where.join(' AND ')}`;
  const total = (await db.prepare(`SELECT COUNT(*) AS c FROM checklists cl${w}`).get(...params)).c;
  const items = await db.prepare(`${SELECT}${w}
     ORDER BY CASE cl.status WHEN 'pending' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END,
              CASE WHEN cl.due_date IS NULL THEN 1 ELSE 0 END, cl.due_date ASC, cl.id DESC
     LIMIT ? OFFSET ?`).all(...params, q.perPage, q.perPage * (q.page - 1));
  return { items: items.map(withProgress), total };
}

async function getWithItems(companyId, id) {
  const cl = await getChecklist(companyId, id);
  if (!cl) throw notFound('Checklist não encontrado.');
  cl.items = await getItems(id);
  return cl;
}

async function updateMeta(companyId, id, body, userId) {
  const cl = await getChecklist(companyId, id);
  if (!cl) throw notFound('Checklist não encontrado.');
  if (['completed', 'canceled'].includes(cl.status)) throw conflict('Checklist concluído/cancelado não pode ser editado.');
  const title = body.title !== undefined ? String(body.title || '').trim() : cl.title;
  if (title.length < 3 || title.length > 120) throw badRequest('Título deve ter 3 a 120 caracteres.');
  const description = body.description !== undefined ? (body.description ? String(body.description).trim().slice(0, 1000) : null) : cl.description;
  const status = body.status !== undefined ? (STATUSES.includes(body.status) && body.status !== 'completed' ? body.status : (() => { throw badRequest('Status inválido (use complete para concluir).'); })()) : cl.status;
  const assigned = body.assigned_to_user_id !== undefined ? await validateAssignee(companyId, body.assigned_to_user_id) : cl.assigned_to_user_id;
  const storeId = body.store_id !== undefined ? await validateStore(companyId, body.store_id) : cl.store_id;
  const due = body.due_date !== undefined ? validateDueDate(body.due_date) : cl.due_date;
  await db.prepare(
    `UPDATE checklists SET title=?, description=?, status=?, assigned_to_user_id=?,
       store_id=?, due_date=?, updated_at=datetime('now') WHERE id=? AND company_id=?`
  ).run(title, description, status, assigned, storeId, due, id, companyId);
  return await getWithItems(companyId, id);
}

async function addItem(companyId, id, body, userId) {
  const cl = await getChecklist(companyId, id);
  if (!cl) throw notFound('Checklist não encontrado.');
  if (['completed', 'canceled'].includes(cl.status)) throw conflict('Checklist concluído/cancelado não pode ser editado.');
  const title = String(body.title || '').trim();
  if (title.length < 2 || title.length > 140) throw badRequest('Título do item inválido.');
  const count = (await db.prepare('SELECT COUNT(*) AS c FROM checklist_items WHERE checklist_id = ?').get(id)).c;
  if (count >= 50) throw badRequest('Máximo de 50 itens por checklist.');
  const maxPos = (await db.prepare('SELECT COALESCE(MAX(position), 0) AS m FROM checklist_items WHERE checklist_id = ?').get(id)).m;
  await db.prepare(
    'INSERT INTO checklist_items (checklist_id, title, description, position, required) VALUES (?, ?, ?, ?, ?)'
  ).run(id, title, body.description ? String(body.description).trim().slice(0, 400) : null,
    Number.isInteger(Number(body.position)) ? Number(body.position) : maxPos + 1,
    body.required === true || body.required === 1 || body.required === '1' ? 1 : 0);
  await db.prepare("UPDATE checklists SET status = CASE WHEN status = 'pending' THEN 'in_progress' ELSE status END, updated_at=datetime('now') WHERE id = ?").run(id);
  return await getWithItems(companyId, id);
}

async function removeItem(companyId, id, itemId, userId) {
  const cl = await getChecklist(companyId, id);
  if (!cl) throw notFound('Checklist não encontrado.');
  if (['completed', 'canceled'].includes(cl.status)) throw conflict('Checklist concluído/cancelado não pode ser editado.');
  const item = await db.prepare('SELECT id FROM checklist_items WHERE id = ? AND checklist_id = ?').get(itemId, id);
  if (!item) throw notFound('Item não encontrado.');
  await db.prepare('DELETE FROM checklist_items WHERE id = ? AND checklist_id = ?').run(itemId, id);
  return await getWithItems(companyId, id);
}

async function txSetItem(id, itemId, completed, userId) {
  // Dois UPDATEs em batch atômico (idempotente por natureza)
  await db.prepare(
    `UPDATE checklist_items SET completed=?, completed_at=CASE WHEN ?=1 THEN datetime('now') ELSE NULL END,
       completed_by_user_id=? WHERE id=? AND checklist_id=?`
  ).run(completed, completed, completed ? userId : null, itemId, id);
  await db.prepare(
    `UPDATE checklists SET status = CASE WHEN (SELECT COUNT(*) FROM checklist_items WHERE checklist_id = ? AND completed = 0) = 0
       THEN status ELSE 'in_progress' END, updated_at=datetime('now') WHERE id = ?`
  ).run(id, id);
}

async function setItem(companyId, id, itemId, completed, userId) {
  const cl = await getChecklist(companyId, id);
  if (!cl) throw notFound('Checklist não encontrado.');
  if (['completed', 'canceled'].includes(cl.status)) throw conflict('Checklist concluído/cancelado não pode ser alterado.');
  const item = await db.prepare('SELECT id FROM checklist_items WHERE id = ? AND checklist_id = ?').get(itemId, id);
  if (!item) throw notFound('Item não encontrado.');
  await txSetItem(id, itemId, completed ? 1 : 0, userId);
  return await getWithItems(companyId, id);
}

async function complete(companyId, id, userId) {
  const cl = await getChecklist(companyId, id);
  if (!cl) throw notFound('Checklist não encontrado.');
  if (cl.status === 'completed') throw conflict('Checklist já está concluído.');
  if (cl.status === 'canceled') throw conflict('Checklist cancelado não pode ser concluído.');
  const missing = (await db.prepare(
    'SELECT COUNT(*) AS c FROM checklist_items WHERE checklist_id = ? AND required = 1 AND completed = 0'
  ).get(id)).c;
  if (missing > 0) throw conflict(`Ainda há ${missing} item(ns) obrigatório(s) pendente(s).`);
  await db.prepare(
    `UPDATE checklists SET status='completed', completed_at=datetime('now'),
       completed_by_user_id=?, updated_at=datetime('now') WHERE id=? AND company_id=?`
  ).run(userId, id, companyId);
  return await getWithItems(companyId, id);
}

async function cancel(companyId, id, userId) {
  const cl = await getChecklist(companyId, id);
  if (!cl) throw notFound('Checklist não encontrado.');
  if (cl.status === 'completed') throw conflict('Checklist concluído não pode ser cancelado (histórico).');
  if (cl.status === 'canceled') throw conflict('Checklist já está cancelado.');
  await db.prepare(
    `UPDATE checklists SET status='canceled', canceled_at=datetime('now'),
       canceled_by_user_id=?, updated_at=datetime('now') WHERE id=? AND company_id=?`
  ).run(userId, id, companyId);
  return await getWithItems(companyId, id);
}

async function remove(companyId, id) {
  const cl = await getChecklist(companyId, id);
  if (!cl) throw notFound('Checklist não encontrado.');
  if (cl.status === 'completed') throw conflict('Checklist concluído não pode ser excluído (histórico preservado).');
  await db.prepare('DELETE FROM checklists WHERE id = ? AND company_id = ?').run(id, companyId);
}

module.exports = { STATUSES, list, create, getWithItems, updateMeta, addItem, removeItem, setItem, complete, cancel, remove };
