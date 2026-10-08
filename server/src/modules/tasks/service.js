'use strict';

/**
 * TAREFAS — camada operacional V1 (v3.4).
 * company_id SEMPRE do contexto de sessão. Vínculos (cliente/venda/compra/
 * payable/receivable) são OPCIONAIS e validados no write, sem FK — a tarefa
 * sobrevive à desativação de módulos e à exclusão do registro de origem.
 * link_label é snapshot de contexto derivado no servidor.
 */

const db = require('../../database/connection');
const { badRequest, notFound, conflict } = require('../../core/errors');
const { businessToday } = require('../../core/businessDate');
const notifications = require('../notifications/service');

const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const STATUSES = ['pending', 'in_progress', 'completed', 'canceled'];

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const SELECT = `
  SELECT t.id, t.company_id, t.store_id, s.name AS store_name, t.title, t.description,
         t.assigned_to_user_id, ua.name AS assigned_to_name,
         t.created_by_user_id, uc.name AS created_by_name,
         t.client_id, t.sale_id, t.purchase_id, t.payable_id, t.receivable_id, t.link_label,
         t.priority, t.status, t.due_date, t.completed_at, t.created_at, t.updated_at
  FROM tasks t
  LEFT JOIN stores s ON s.id = t.store_id
  LEFT JOIN users ua ON ua.id = t.assigned_to_user_id
  JOIN users uc ON uc.id = t.created_by_user_id`;

async function getTask(companyId, id) {
  return await db.prepare(`${SELECT} WHERE t.company_id = ? AND t.id = ?`).get(companyId, id) || null;
}

async function belongsToCompany(table, companyId, id) {
  if (!Number.isInteger(id)) return false;
  return !!await db.prepare(`SELECT 1 AS x FROM ${table} WHERE id = ? AND company_id = ?`).get(id, companyId);
}

/** Snapshot de identificação do vínculo (contexto histórico). */
async function deriveLinkLabel(companyId, links) {
  if (links.client_id && await belongsToCompany('customers', companyId, links.client_id)) {
    const c = await db.prepare('SELECT name FROM customers WHERE id = ?').get(links.client_id);
    if (c) return `Cliente: ${c.name}`;
  }
  if (links.sale_id && await belongsToCompany('sales', companyId, links.sale_id)) {
    return `Venda #${links.sale_id}`;
  }
  if (links.purchase_id && await belongsToCompany('purchases', companyId, links.purchase_id)) {
    return `Compra #${links.purchase_id}`;
  }
  if (links.payable_id && await belongsToCompany('accounts_payable', companyId, links.payable_id)) {
    return `Conta a pagar #${links.payable_id}`;
  }
  if (links.receivable_id && await belongsToCompany('accounts_receivable', companyId, links.receivable_id)) {
    return `Conta a receber #${links.receivable_id}`;
  }
  return null;
}

async function validateLinks(companyId, body) {
  const links = {
    client_id: body.client_id === undefined || body.client_id === null || body.client_id === '' ? null : Number(body.client_id),
    sale_id: body.sale_id === undefined || body.sale_id === null || body.sale_id === '' ? null : Number(body.sale_id),
    purchase_id: body.purchase_id === undefined || body.purchase_id === null || body.purchase_id === '' ? null : Number(body.purchase_id),
    payable_id: body.payable_id === undefined || body.payable_id === null || body.payable_id === '' ? null : Number(body.payable_id),
    receivable_id: body.receivable_id === undefined || body.receivable_id === null || body.receivable_id === '' ? null : Number(body.receivable_id),
  };
  for (const [k, v] of Object.entries(links)) {
    if (v !== null) {
      if (!Number.isInteger(v)) throw badRequest('Vínculo inválido.');
      const table = { client_id: 'customers', sale_id: 'sales', purchase_id: 'purchases', payable_id: 'accounts_payable', receivable_id: 'accounts_receivable' }[k];
      if (!await belongsToCompany(table, companyId, v)) throw badRequest('Registro vinculado não encontrado nesta empresa.');
    }
  }
  return links;
}

async function validateAssignee(companyId, userId) {
  if (userId === null || userId === undefined || userId === '') return null;
  const n = Number(userId);
  if (!Number.isInteger(n)) throw badRequest('Responsável inválido.');
  const u = await db.prepare('SELECT id FROM users WHERE id = ? AND company_id = ? AND status = \'active\'').get(n, companyId);
  if (!u) throw badRequest('Responsável não encontrado nesta empresa.');
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

async function list(companyId, q) {
  await notifications.generateTaskOverdue(companyId);
  const today = await businessToday(companyId);
  const where = ['t.company_id = ?'];
  const params = [companyId];
  if (q.search) { where.push('(t.title LIKE ? OR t.description LIKE ?)'); params.push(`%${q.search}%`, `%${q.search}%`); }
  if (q.status) { if (!STATUSES.includes(q.status)) throw badRequest('Status inválido.'); where.push('t.status = ?'); params.push(q.status); }
  if (q.priority) { if (!PRIORITIES.includes(q.priority)) throw badRequest('Prioridade inválida.'); where.push('t.priority = ?'); params.push(q.priority); }
  if (q.assigned_to) { where.push('t.assigned_to_user_id = ?'); params.push(Number(q.assigned_to)); }
  if (q.store_id) { where.push('t.store_id = ?'); params.push(Number(q.store_id)); }
  if (q.due_from) { where.push('t.due_date >= ?'); params.push(q.due_from); }
  if (q.due_to) { where.push('t.due_date <= ?'); params.push(q.due_to); }
  if (q.overdue === '1') { where.push(`t.status IN ('pending','in_progress') AND t.due_date IS NOT NULL AND t.due_date < ?`); params.push(today); }
  if (q.mine === '1') { where.push('t.assigned_to_user_id = ?'); params.push(q.userId); }
  const w = ` WHERE ${where.join(' AND ')}`;
  const total = (await db.prepare(`SELECT COUNT(*) AS c FROM tasks t${w}`).get(...params)).c;
  const items = await db.prepare(`${SELECT}${w}
     ORDER BY CASE t.status WHEN 'pending' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END,
              CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END, t.due_date ASC, t.id DESC
     LIMIT ? OFFSET ?`).all(...params, q.perPage, q.perPage * (q.page - 1));
  const enriched = items.map((t) => ({
    ...t,
    overdue: ['pending', 'in_progress'].includes(t.status) && t.due_date !== null && t.due_date < today,
    due_today: ['pending', 'in_progress'].includes(t.status) && t.due_date === today,
  }));
  return { items: enriched, total };
}

async function create(companyId, body, userId) {
  const title = String(body.title || '').trim();
  if (title.length < 3 || title.length > 120) throw badRequest('Título deve ter 3 a 120 caracteres.');
  const description = body.description ? String(body.description).trim().slice(0, 1000) : null;
  const priority = body.priority === undefined || body.priority === null
    ? 'medium'
    : (PRIORITIES.includes(body.priority) ? body.priority : (() => { throw badRequest('Prioridade inválida.'); })());
  const status = body.status === undefined || body.status === null
    ? 'pending'
    : (['pending', 'in_progress'].includes(body.status) ? body.status : (() => { throw badRequest('Status inválido.'); })());
  const due_date = body.due_date ? (isValidDate(body.due_date) ? body.due_date : (() => { throw badRequest('Prazo inválido (AAAA-MM-DD).'); })()) : null;
  const assigned = await validateAssignee(companyId, body.assigned_to_user_id);
  const storeId = await validateStore(companyId, body.store_id);
  const links = await validateLinks(companyId, body);
  const linkLabel = await deriveLinkLabel(companyId, links);
  const id = (await db.prepare(
    `INSERT INTO tasks (company_id, store_id, title, description, assigned_to_user_id,
       created_by_user_id, client_id, sale_id, purchase_id, payable_id, receivable_id,
       link_label, priority, status, due_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(companyId, storeId, title, description, assigned, userId,
    links.client_id, links.sale_id, links.purchase_id, links.payable_id, links.receivable_id,
    linkLabel, priority, status, due_date)).lastInsertRowid;
  if (assigned && assigned !== userId) {
    await notifications.notify({
      companyId, userId: assigned, type: 'task_assigned',
      title: `Nova tarefa: ${title}`, message: description,
      priority: priority === 'urgent' ? 'high' : 'normal',
      entityType: 'task', entityId: id, actionUrl: '#/tarefas',
      dedupeKey: `task_assigned:${id}`,
    });
  }
  return await getTask(companyId, id);
}

async function update(companyId, id, body, userId) {
  const t = await getTask(companyId, id);
  if (!t) throw notFound('Tarefa não encontrada.');
  if (t.status === 'completed' || t.status === 'canceled') throw conflict('Tarefa concluída/cancelada não pode ser editada (reabra ou cancele).');
  const title = body.title !== undefined ? String(body.title || '').trim() : t.title;
  if (title.length < 3 || title.length > 120) throw badRequest('Título deve ter 3 a 120 caracteres.');
  const description = body.description !== undefined ? (body.description ? String(body.description).trim().slice(0, 1000) : null) : t.description;
  const priority = body.priority !== undefined ? (PRIORITIES.includes(body.priority) ? body.priority : (() => { throw badRequest('Prioridade inválida.'); })()) : t.priority;
  const status = body.status !== undefined
    ? (['pending', 'in_progress', 'canceled'].includes(body.status) ? body.status : (() => { throw badRequest('Status inválido.'); })())
    : t.status;
  if (status === 'canceled' && t.status !== 'canceled') {
    await db.prepare(
      "UPDATE tasks SET canceled_at = datetime('now'), canceled_by_user_id = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(userId, id);
  }
  let due_date = t.due_date;
  if (body.due_date !== undefined) {
    due_date = body.due_date ? (isValidDate(body.due_date) ? body.due_date : (() => { throw badRequest('Prazo inválido (AAAA-MM-DD).'); })()) : null;
  }
  const prevAssignee = t.assigned_to_user_id;
  const assigned = body.assigned_to_user_id !== undefined ? await validateAssignee(companyId, body.assigned_to_user_id) : t.assigned_to_user_id;
  const storeId = body.store_id !== undefined ? await validateStore(companyId, body.store_id) : t.store_id;
  const links = await validateLinks(companyId, {
    client_id: body.client_id !== undefined ? body.client_id : t.client_id,
    sale_id: body.sale_id !== undefined ? body.sale_id : t.sale_id,
    purchase_id: body.purchase_id !== undefined ? body.purchase_id : t.purchase_id,
    payable_id: body.payable_id !== undefined ? body.payable_id : t.payable_id,
    receivable_id: body.receivable_id !== undefined ? body.receivable_id : t.receivable_id,
  });
  const linkLabel = await deriveLinkLabel(companyId, links);
  await db.prepare(
    `UPDATE tasks SET title=?, description=?, priority=?, status=?, due_date=?,
       assigned_to_user_id=?, store_id=?, client_id=?, sale_id=?, purchase_id=?,
       payable_id=?, receivable_id=?, link_label=?, updated_at=datetime('now')
     WHERE id=? AND company_id=?`
  ).run(title, description, priority, status, due_date, assigned, storeId,
    links.client_id, links.sale_id, links.purchase_id, links.payable_id, links.receivable_id,
    linkLabel, id, companyId);
  if (assigned && assigned !== prevAssignee && assigned !== userId) {
    await notifications.notify({
      companyId, userId: assigned, type: 'task_assigned',
      title: `Tarefa atribuída a você: ${title}`,
      priority: priority === 'urgent' ? 'high' : 'normal',
      entityType: 'task', entityId: id, actionUrl: '#/tarefas',
      dedupeKey: `task_assigned:${id}:${assigned}`,
    });
  }
  return await getTask(companyId, id);
}

// UPDATE condicional único — atômico por si só (tx desnecessária).
// Idempotente: status já final → changes 0 → 409.
async function txComplete(companyId, id, userId) {
  const r = await db.prepare(
    `UPDATE tasks SET status='completed', completed_at=datetime('now'),
       completed_by_user_id=?, updated_at=datetime('now')
     WHERE id=? AND company_id=? AND status IN ('pending','in_progress')`
  ).run(userId, id, companyId);
  return r.changes;
}

async function complete(companyId, id, userId) {
  const t = await getTask(companyId, id);
  if (!t) throw notFound('Tarefa não encontrada.');
  if (t.status === 'completed') throw conflict('Tarefa já está concluída.');
  if (t.status === 'canceled') throw conflict('Tarefa cancelada não pode ser concluída.');
  if (await txComplete(companyId, id, userId) !== 1) throw conflict('Não foi possível concluir.');
  const done = await getTask(companyId, id);
  if (done.created_by_user_id !== userId) {
    await notifications.notify({
      companyId, userId: done.created_by_user_id, type: 'system',
      title: `Tarefa concluída: ${done.title}`,
      entityType: 'task', entityId: id, actionUrl: '#/tarefas',
      dedupeKey: `task_done:${id}`,
    });
  }
  return done;
}

async function reopen(companyId, id, userId) {
  const t = await getTask(companyId, id);
  if (!t) throw notFound('Tarefa não encontrada.');
  if (t.status !== 'completed') throw conflict('Somente tarefa concluída pode ser reaberta.');
  await db.prepare(
    `UPDATE tasks SET status='pending', completed_at=NULL, completed_by_user_id=NULL,
       updated_at=datetime('now') WHERE id=? AND company_id=?`
  ).run(id, companyId);
  return await getTask(companyId, id);
}

async function remove(companyId, id) {
  const t = await getTask(companyId, id);
  if (!t) throw notFound('Tarefa não encontrada.');
  if (t.status === 'completed') throw conflict('Tarefa concluída não pode ser excluída (histórico preservado).');
  await db.prepare('DELETE FROM tasks WHERE id = ? AND company_id = ?').run(id, companyId);
}

module.exports = { PRIORITIES, STATUSES, list, create, getTask, update, complete, reopen, remove, isValidDate };
