'use strict';

/**
 * Serviço de Clientes (v1.5) — módulo próprio, completo e multiempresa.
 *
 * - company_id SEMPRE da sessão; todo acesso por escopo (anti-IDOR).
 * - CPF/CNPJ (document) normalizado (somente dígitos), único por empresa.
 * - Exclusão SÓ quando o cliente não possui vendas; caso contrário 409 —
 *   preserva histórico (preferir desativação, status active/inactive).
 * - Vendas NUNCA são apagadas nem alteradas na desativação.
 * - Histórico de vendas é DERIVADO de `sales` (sem tabela duplicada).
 */

const db = require('../../database/connection');
const { badRequest, notFound, conflict } = require('../../core/errors');

// ---------------------------------------------------------------------------
// Normalização/validação
// ---------------------------------------------------------------------------

const normalizeDocument = (v) => String(v || '').replace(/\D/g, '').slice(0, 14);

const normalizeEmail = (v) => String(v || '').trim().toLowerCase().slice(0, 190);

function optClean(value, max) {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

const CUSTOMER_SQL = `
  SELECT id, company_id, name, phone, email, document,
         address, number, complement, district, city, state, zip,
         notes, status, created_at, updated_at
  FROM customers
`;

async function getScoped(companyId, id) {
  const c = await db.prepare(`${CUSTOMER_SQL} WHERE id = ? AND company_id = ?`).get(id, companyId);
  if (!c) throw notFound('Cliente não encontrado.');
  return c;
}

async function list(companyId, { page, perPage, offset, search, status }) {
  let where = ' WHERE company_id = ?';
  const params = [companyId];
  if (search) {
    const term = `%${String(search).slice(0, 80)}%`;
    where += ' AND (name LIKE ? OR phone LIKE ? OR email LIKE ? OR document LIKE ?)';
    params.push(term, term, term, term);
  }
  if (status === 'active' || status === 'inactive') {
    where += ' AND status = ?';
    params.push(status);
  }
  const total = (await db.prepare(`SELECT COUNT(*) AS c FROM customers${where}`).get(...params)).c;
  const items = await db.prepare(
    `${CUSTOMER_SQL}${where} ORDER BY name LIMIT ? OFFSET ?`
  ).all(...params, perPage, offset);
  return { items, total, page, perPage };
}

/**
 * Detalhe do cliente:
 * - sales_history: ÚLTIMAS 10 vendas (derivado de `sales`, sem tabela extra);
 * - sales_count: COUNT(*) de TODAS as vendas do cliente na empresa (nunca o
 *   tamanho do histórico truncado) — consulta isolada, com índice
 *   ix_sales_company_customer, sem N+1.
 */
async function detail(companyId, id) {
  const customer = await getScoped(companyId, id);
  const sales = await db.prepare(
    `SELECT s.id, s.amount_cents, s.sold_at, s.status, st.name AS store_name, u.name AS seller_name
     FROM sales s
     JOIN stores st ON st.id = s.store_id
     JOIN users u ON u.id = s.seller_id
     WHERE s.customer_id = ? AND s.company_id = ?
     ORDER BY s.sold_at DESC, s.id DESC LIMIT 10`
  ).all(id, companyId);
  return { ...customer, sales_history: sales, sales_count: await countSales(companyId, id) };
}

async function countSales(companyId, id) {
  return (await db.prepare('SELECT COUNT(*) AS c FROM sales WHERE customer_id = ? AND company_id = ?').get(id, companyId)).c;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

async function create(companyId, data) {
  const name = String(data.name || '').trim();
  if (name.length < 2) throw badRequest('Nome é obrigatório (mínimo 2 caracteres).');
  if (name.length > 120) throw badRequest('Nome muito longo.');

  const email = optClean(data.email, 190);
  if (email && !validEmail(email)) throw badRequest('E-mail inválido.');

  const document = normalizeDocument(data.document);
  const phone = optClean(data.phone, 30);

  const fields = {
    address: optClean(data.address, 150), number: optClean(data.number, 20),
    complement: optClean(data.complement, 80), district: optClean(data.district, 80),
    city: optClean(data.city, 80), zip: optClean(data.zip, 10), notes: optClean(data.notes, 500),
  };
  // UF validada ANTES de qualquer truncamento ('XX9' não pode virar 'XX')
  if (data.state !== undefined && data.state !== null && String(data.state).trim() !== '') {
    const raw = String(data.state).trim();
    if (!/^[A-Za-z]{2}$/.test(raw)) throw badRequest('UF inválida.');
    fields.state = raw.toUpperCase();
  } else {
    fields.state = optClean(data.state, 2);
  }

  let id;
  try {
    id = (await db.prepare(
      `INSERT INTO customers (company_id, name, phone, email, document, address, number,
                              complement, district, city, state, zip, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      companyId, name, phone ?? null, email ?? null, document || null,
      fields.address ?? null, fields.number ?? null, fields.complement ?? null,
      fields.district ?? null, fields.city ?? null, fields.state ?? null,
      fields.zip ?? null, fields.notes ?? null
    )).lastInsertRowid;
  } catch (err) {
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
      throw conflict('Já existe um cliente com este CPF/CNPJ nesta empresa.');
    }
    throw err;
  }
  return await getScoped(companyId, id);
}

async function update(companyId, id, data) {
  await getScoped(companyId, id); // escopo antes de alterar (anti-IDOR)

  const name = data.name !== undefined ? String(data.name || '').trim() : undefined;
  if (name !== undefined && (name.length < 2 || name.length > 120)) {
    throw badRequest('Nome inválido (2 a 120 caracteres).');
  }
  const email = data.email !== undefined ? optClean(data.email, 190) : undefined;
  if (email && !validEmail(email)) throw badRequest('E-mail inválido.');
  const document = data.document !== undefined ? normalizeDocument(data.document) : undefined;
  const status = data.status !== undefined ? String(data.status) : undefined;
  if (status !== undefined && !['active', 'inactive'].includes(status)) {
    throw badRequest('Status inválido.');
  }

  const simple = ['phone', 'address', 'number', 'complement', 'district', 'city', 'state', 'zip', 'notes'];
  const values = {};
  for (const f of simple) {
    if (data[f] !== undefined) values[f] = optClean(data[f], f === 'notes' ? 500 : 150);
  }
  // Backend é autoridade: normaliza a UF ANTES de validar (create já faz;
  // PATCH agora também — "ma" → "MA")
  if (values.state) values.state = values.state.toUpperCase();
  if (values.state && !/^[A-Z]{2}$/.test(values.state)) throw badRequest('UF inválida.');

  try {
    await db.prepare(
      `UPDATE customers SET
         name = COALESCE(?, name),
         phone = CASE WHEN ? THEN ? ELSE phone END,
         email = CASE WHEN ? THEN ? ELSE email END,
         document = CASE WHEN ? THEN ? ELSE document END,
         address = CASE WHEN ? THEN ? ELSE address END,
         number = CASE WHEN ? THEN ? ELSE number END,
         complement = CASE WHEN ? THEN ? ELSE complement END,
         district = CASE WHEN ? THEN ? ELSE district END,
         city = CASE WHEN ? THEN ? ELSE city END,
         state = CASE WHEN ? THEN ? ELSE state END,
         zip = CASE WHEN ? THEN ? ELSE zip END,
         notes = CASE WHEN ? THEN ? ELSE notes END,
         status = COALESCE(?, status),
         updated_at = datetime('now')
       WHERE id = ? AND company_id = ?`
    ).run(
      name ?? null,
      data.phone !== undefined ? 1 : 0, values.phone ?? null,
      data.email !== undefined ? 1 : 0, email ?? null,
      data.document !== undefined ? 1 : 0, document || null,
      data.address !== undefined ? 1 : 0, values.address ?? null,
      data.number !== undefined ? 1 : 0, values.number ?? null,
      data.complement !== undefined ? 1 : 0, values.complement ?? null,
      data.district !== undefined ? 1 : 0, values.district ?? null,
      data.city !== undefined ? 1 : 0, values.city ?? null,
      data.state !== undefined ? 1 : 0, values.state ?? null,
      data.zip !== undefined ? 1 : 0, values.zip ?? null,
      data.notes !== undefined ? 1 : 0, values.notes ?? null,
      status ?? null, id, companyId
    );
  } catch (err) {
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
      throw conflict('Já existe um cliente com este CPF/CNPJ nesta empresa.');
    }
    throw err;
  }
  return await getScoped(companyId, id);
}

/**
 * Exclusão: SOMENTE sem vendas associadas (preserva histórico e FKs).
 * Cliente com vendas → 409 (use a desativação).
 */
async function remove(companyId, id) {
  const customer = await getScoped(companyId, id);
  if (await countSales(companyId, id) > 0) {
    throw conflict('Este cliente possui vendas associadas e não pode ser excluído. Desative-o para manter o histórico.');
  }
  await db.prepare('DELETE FROM customers WHERE id = ? AND company_id = ?').run(id, companyId);
  return customer;
}

module.exports = { list, getScoped, detail, create, update, remove, normalizeDocument };
