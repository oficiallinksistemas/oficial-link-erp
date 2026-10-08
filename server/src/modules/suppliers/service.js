'use strict';

/** Serviço de Fornecedores (v1.9) — mesmo padrão de Customers. */

const db = require('../../database/connection');
const { badRequest, notFound, conflict } = require('../../core/errors');

const norm = (v, max) => {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};
const normalizeDocument = (v) => String(v || '').replace(/\D/g, '').slice(0, 14);

const SQL = `SELECT id, company_id, name, document, phone, email, address, city, state, zip, notes, status, created_at, updated_at
             FROM suppliers`;

async function getScoped(companyId, id) {
  const s = await db.prepare(`${SQL} WHERE id = ? AND company_id = ?`).get(id, companyId);
  if (!s) throw notFound('Fornecedor não encontrado.');
  return s;
}

async function list(companyId, { page, perPage, offset, search, status }) {
  let where = ' WHERE company_id = ?';
  const params = [companyId];
  if (search) {
    const term = `%${String(search).slice(0, 80)}%`;
    where += ' AND (name LIKE ? OR document LIKE ?)';
    params.push(term, term);
  }
  if (status === 'active' || status === 'inactive') { where += ' AND status = ?'; params.push(status); }
  const total = (await db.prepare(`SELECT COUNT(*) AS c FROM suppliers${where}`).get(...params)).c;
  const items = await db.prepare(`${SQL}${where} ORDER BY name LIMIT ? OFFSET ?`).all(...params, perPage, offset);
  return { items, total, page, perPage };
}

function parsePayload(data, partial = false) {
  const out = {};
  if (!partial || data.name !== undefined) {
    const n = String(data.name || '').trim();
    if (n.length < 2 || n.length > 120) throw badRequest('Nome inválido (2 a 120).');
    out.name = n;
  }
  if (data.email !== undefined) {
    const e = norm(data.email, 190);
    if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw badRequest('E-mail inválido.');
    out.email = e;
  }
  if (data.document !== undefined) out.document = normalizeDocument(data.document);
  if (data.state !== undefined && data.state !== null && String(data.state).trim() !== '') {
    const raw = String(data.state).trim();
    if (!/^[A-Za-z]{2}$/.test(raw)) throw badRequest('UF inválida.');
    out.state = raw.toUpperCase();
  } else if (data.state !== undefined) out.state = null;
  for (const [f, max] of [['phone', 30], ['address', 150], ['city', 80], ['zip', 10], ['notes', 500]]) {
    if (data[f] !== undefined) out[f] = norm(data[f], max);
  }
  if (data.status !== undefined) {
    if (!['active', 'inactive'].includes(String(data.status))) throw badRequest('Status inválido.');
    out.status = String(data.status);
  }
  return out;
}

async function create(companyId, data) {
  const p = parsePayload(data);
  try {
    const id = (await db.prepare(
      `INSERT INTO suppliers (company_id, name, document, phone, email, address, city, state, zip, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(companyId, p.name, p.document ?? null, p.phone ?? null, p.email ?? null,
      p.address ?? null, p.city ?? null, p.state ?? null, p.zip ?? null, p.notes ?? null)).lastInsertRowid;
    return await getScoped(companyId, id);
  } catch (err) {
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) throw conflict('Já existe um fornecedor com este documento nesta empresa.');
    throw err;
  }
}

async function update(companyId, id, data) {
  await getScoped(companyId, id);
  const p = parsePayload(data, true);
  try {
    await db.prepare(
      `UPDATE suppliers SET name = COALESCE(?, name), document = CASE WHEN ? THEN ? ELSE document END,
         phone = CASE WHEN ? THEN ? ELSE phone END, email = CASE WHEN ? THEN ? ELSE email END,
         address = CASE WHEN ? THEN ? ELSE address END, city = CASE WHEN ? THEN ? ELSE city END,
         state = CASE WHEN ? THEN ? ELSE state END, zip = CASE WHEN ? THEN ? ELSE zip END,
         notes = CASE WHEN ? THEN ? ELSE notes END, status = COALESCE(?, status), updated_at = datetime('now')
       WHERE id = ? AND company_id = ?`
    ).run(
      p.name ?? null,
      p.document !== undefined ? 1 : 0, p.document || null,
      p.phone !== undefined ? 1 : 0, p.phone ?? null,
      p.email !== undefined ? 1 : 0, p.email ?? null,
      p.address !== undefined ? 1 : 0, p.address ?? null,
      p.city !== undefined ? 1 : 0, p.city ?? null,
      p.state !== undefined ? 1 : 0, p.state ?? null,
      p.zip !== undefined ? 1 : 0, p.zip ?? null,
      p.notes !== undefined ? 1 : 0, p.notes ?? null,
      p.status ?? null, id, companyId
    );
  } catch (err) {
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) throw conflict('Já existe um fornecedor com este documento nesta empresa.');
    throw err;
  }
  return await getScoped(companyId, id);
}

async function remove(companyId, id) {
  const s = await getScoped(companyId, id);
  const used = (await db.prepare('SELECT COUNT(*) AS c FROM purchases WHERE supplier_id = ? AND company_id = ?').get(id, companyId)).c;
  if (used > 0) throw conflict('Fornecedor possui compras e não pode ser excluído. Desative-o.');
  await db.prepare('DELETE FROM suppliers WHERE id = ? AND company_id = ?').run(id, companyId);
  return s;
}

module.exports = { list, getScoped, create, update, remove };
