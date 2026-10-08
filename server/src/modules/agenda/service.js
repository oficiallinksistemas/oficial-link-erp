'use strict';

/**
 * AGENDA — compromissos operacionais V1 (v3.4).
 * start_at/end_at: 'YYYY-MM-DD HH:MM' no horário LOCAL da empresa (todos os
 * usuários do tenant compartilham o fuso; fronteiras de dia usam
 * businessToday — nunca UTC). all_day ignora a parte de hora.
 * company_id SEMPRE da sessão.
 */

const db = require('../../database/connection');
const { badRequest, notFound, conflict } = require('../../core/errors');
const { businessToday } = require('../../core/businessDate');
const notifications = require('../notifications/service');

const STATUSES = ['scheduled', 'completed', 'canceled'];
const DT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function reqDateTime(value, field) {
  if (typeof value !== 'string' || !DT_RE.test(value)) throw badRequest(`${field} inválido (use AAAA-MM-DD HH:MM).`);
  const [datePart, timePart] = value.split(' ');
  if (!isValidDate(datePart)) throw badRequest(`${field} inválido (data inexistente).`);
  const [hh, mm] = timePart.split(':').map(Number);
  if (hh > 23 || mm > 59) throw badRequest(`${field} inválido (hora inexistente).`);
  return value;
}

const SELECT = `
  SELECT e.id, e.company_id, e.store_id, s.name AS store_name, e.title, e.description,
         e.start_at, e.end_at, e.all_day,
         e.responsible_user_id, ur.name AS responsible_name,
         e.client_id, e.task_id, e.status, e.location,
         e.created_by_user_id, uc.name AS created_by_name,
         e.completed_at, e.created_at
  FROM agenda_events e
  LEFT JOIN stores s ON s.id = e.store_id
  LEFT JOIN users ur ON ur.id = e.responsible_user_id
  JOIN users uc ON uc.id = e.created_by_user_id`;

async function getEvent(companyId, id) {
  return await db.prepare(`${SELECT} WHERE e.company_id = ? AND e.id = ?`).get(companyId, id) || null;
}

async function validateLinks(companyId, body) {
  let clientId = null; let taskId = null;
  if (body.client_id !== undefined && body.client_id !== null && body.client_id !== '') {
    clientId = Number(body.client_id);
    if (!Number.isInteger(clientId) || !await db.prepare('SELECT 1 AS x FROM customers WHERE id = ? AND company_id = ?').get(clientId, companyId)) {
      throw badRequest('Cliente não encontrado nesta empresa.');
    }
  }
  if (body.task_id !== undefined && body.task_id !== null && body.task_id !== '') {
    taskId = Number(body.task_id);
    if (!Number.isInteger(taskId) || !await db.prepare('SELECT 1 AS x FROM tasks WHERE id = ? AND company_id = ?').get(taskId, companyId)) {
      throw badRequest('Tarefa não encontrada nesta empresa.');
    }
  }
  return { clientId, taskId };
}

async function validateResponsible(companyId, userId) {
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

function normalizeTimes(body) {
  const allDay = body.all_day === true || body.all_day === 1 || body.all_day === '1' ? 1 : 0;
  const start = reqDateTime(body.start_at, 'Início');
  let end = body.end_at ? reqDateTime(body.end_at, 'Fim') : null;
  if (!allDay) {
    if (!end) throw badRequest('Informe o horário de fim (ou marque o dia inteiro).');
    if (end <= start) throw badRequest('O fim deve ser depois do início.');
  } else if (end && end.split(' ')[0] !== start.split(' ')[0]) {
    throw badRequest('Compromisso de dia inteiro deve começar e terminar no mesmo dia.');
  }
  return { allDay, start, end };
}

async function list(companyId, q) {
  await notifications.generateAgendaReminders(companyId);
  const where = ['e.company_id = ?'];
  const params = [companyId];
  if (q.from) { if (!isValidDate(q.from)) throw badRequest('Período inválido.'); where.push("substr(e.start_at, 1, 10) >= ?"); params.push(q.from); }
  if (q.to) { if (!isValidDate(q.to)) throw badRequest('Período inválido.'); where.push("substr(e.start_at, 1, 10) <= ?"); params.push(q.to); }
  if (q.status) { if (!STATUSES.includes(q.status)) throw badRequest('Status inválido.'); where.push('e.status = ?'); params.push(q.status); }
  else where.push("e.status != 'canceled'");
  if (q.responsible) { where.push('e.responsible_user_id = ?'); params.push(Number(q.responsible)); }
  const w = ` WHERE ${where.join(' AND ')}`;
  const items = await db.prepare(`${SELECT}${w} ORDER BY e.start_at ASC, e.id ASC LIMIT 500`).all(...params);
  return { items, total: items.length };
}

async function create(companyId, body, userId) {
  const title = String(body.title || '').trim();
  if (title.length < 3 || title.length > 120) throw badRequest('Título deve ter 3 a 120 caracteres.');
  const { allDay, start, end } = normalizeTimes(body);
  const description = body.description ? String(body.description).trim().slice(0, 1000) : null;
  const location = body.location ? String(body.location).trim().slice(0, 120) : null;
  const responsible = await validateResponsible(companyId, body.responsible_user_id);
  const storeId = await validateStore(companyId, body.store_id);
  const links = await validateLinks(companyId, body);
  const id = (await db.prepare(
    `INSERT INTO agenda_events (company_id, store_id, title, description, start_at, end_at,
       all_day, responsible_user_id, client_id, task_id, location, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(companyId, storeId, title, description, start, end, allDay, responsible,
    links.clientId, links.taskId, location, userId)).lastInsertRowid;
  await notifications.notifyAdmins(companyId, {
    type: 'agenda_created', title: `Novo compromisso: ${title}`,
    priority: 'normal', entityType: 'agenda_event', entityId: id,
    actionUrl: '#/agenda', dedupeKey: `agenda_created:${id}`,
  });
  return await getEvent(companyId, id);
}

async function update(companyId, id, body, userId) {
  const e = await getEvent(companyId, id);
  if (!e) throw notFound('Compromisso não encontrado.');
  if (e.status !== 'scheduled') throw conflict('Compromisso realizado/cancelado não pode ser editado.');
  const title = body.title !== undefined ? String(body.title || '').trim() : e.title;
  if (title.length < 3 || title.length > 120) throw badRequest('Título deve ter 3 a 120 caracteres.');
  const times = (body.start_at !== undefined || body.end_at !== undefined || body.all_day !== undefined)
    ? normalizeTimes({ start_at: body.start_at ?? e.start_at, end_at: body.end_at ?? e.end_at, all_day: body.all_day ?? e.all_day })
    : { allDay: e.all_day, start: e.start_at, end: e.end_at };
  const description = body.description !== undefined ? (body.description ? String(body.description).trim().slice(0, 1000) : null) : e.description;
  const location = body.location !== undefined ? (body.location ? String(body.location).trim().slice(0, 120) : null) : e.location;
  const responsible = body.responsible_user_id !== undefined ? await validateResponsible(companyId, body.responsible_user_id) : e.responsible_user_id;
  const storeId = body.store_id !== undefined ? await validateStore(companyId, body.store_id) : e.store_id;
  const links = await validateLinks(companyId, {
    client_id: body.client_id !== undefined ? body.client_id : e.client_id,
    task_id: body.task_id !== undefined ? body.task_id : e.task_id,
  });
  await db.prepare(
    `UPDATE agenda_events SET title=?, description=?, start_at=?, end_at=?, all_day=?,
       responsible_user_id=?, store_id=?, client_id=?, task_id=?, location=?,
       updated_at=datetime('now') WHERE id=? AND company_id=?`
  ).run(title, description, times.start, times.end, times.allDay, responsible, storeId,
    links.clientId, links.taskId, location, id, companyId);
  return await getEvent(companyId, id);
}

async function complete(companyId, id, userId) {
  const e = await getEvent(companyId, id);
  if (!e) throw notFound('Compromisso não encontrado.');
  if (e.status !== 'scheduled') throw conflict('Compromisso já foi realizado ou cancelado.');
  await db.prepare(
    `UPDATE agenda_events SET status='completed', completed_at=datetime('now'),
       updated_at=datetime('now') WHERE id=? AND company_id=?`
  ).run(id, companyId);
  return await getEvent(companyId, id);
}

async function cancel(companyId, id) {
  const e = await getEvent(companyId, id);
  if (!e) throw notFound('Compromisso não encontrado.');
  if (e.status !== 'scheduled') throw conflict('Compromisso já foi realizado ou cancelado.');
  await db.prepare(
    `UPDATE agenda_events SET status='canceled', canceled_at=datetime('now'),
       updated_at=datetime('now') WHERE id=? AND company_id=?`
  ).run(id, companyId);
  return await getEvent(companyId, id);
}

async function remove(companyId, id) {
  const e = await getEvent(companyId, id);
  if (!e) throw notFound('Compromisso não encontrado.');
  if (e.status === 'completed') throw conflict('Compromisso realizado não pode ser excluído (histórico preservado).');
  await db.prepare('DELETE FROM agenda_events WHERE id = ? AND company_id = ?').run(id, companyId);
}

module.exports = { STATUSES, list, create, getEvent, update, complete, cancel, remove, isValidDate };
