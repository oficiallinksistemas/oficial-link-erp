'use strict';

/**
 * Transferências entre lojas (v1.9) — entidade do módulo Estoque.
 * Concluir: SAÍDA na origem + ENTRADA no destino (reference_type 'transfer')
 * na MESMA transação. Atômica (qualquer item sem saldo falha tudo) e
 * idempotente (dupla conclusão/cancelamento → 409). Mesma loja → 400;
 * lojas de outra empresa → 400.
 */

const db = require('../../database/connection');
const { badRequest, notFound, conflict } = require('../../core/errors');
const stock = require('./service');

async function assertStore(companyId, id, field) {
  const s = await db.prepare(`SELECT id FROM stores WHERE id = ? AND company_id = ? AND status = 'active'`).get(id, companyId);
  if (!s) throw badRequest(`${field} inválida para esta empresa.`);
  return s.id;
}

async function resolveItems(companyId, items) {
  if (!Array.isArray(items) || items.length === 0) throw badRequest('Informe ao menos um item.');
  const merged = new Map();
  for (const raw of items) {
    const pid = Number(raw?.product_id);
    const qty = Number(raw?.quantity);
    if (!Number.isInteger(pid)) throw badRequest('Item com produto inválido.');
    if (!Number.isInteger(qty) || qty <= 0) throw badRequest('Quantidade inválida.');
    merged.set(pid, (merged.get(pid) || 0) + qty);
  }
  const out = [];
  for (const [pid, qty] of merged) {
    const p = await db.prepare(`SELECT id, name, sku FROM products WHERE id = ? AND company_id = ? AND status = 'active'`).get(pid, companyId);
    if (!p) throw badRequest('Produto inválido para esta empresa.');
    out.push({ product: p, quantity: qty });
  }
  return out;
}

const SQL = `
  SELECT t.*, fs.name AS from_store_name, ts.name AS to_store_name, u.name AS created_by_name
  FROM stock_transfers t
  JOIN stores fs ON fs.id = t.from_store_id
  JOIN stores ts ON ts.id = t.to_store_id
  JOIN users u ON u.id = t.created_by
`;

async function getScoped(companyId, id) {
  const t = await db.prepare(`${SQL} WHERE t.id = ? AND t.company_id = ?`).get(id, companyId);
  if (!t) throw notFound('Transferência não encontrada.');
  t.items = await db.prepare(
    `SELECT id, product_id, product_name, product_sku, quantity FROM stock_transfer_items
     WHERE transfer_id = ? AND company_id = ? ORDER BY id`
  ).all(id, companyId);
  return t;
}

async function list(companyId, { page, perPage, offset, status }) {
  let where = ' WHERE t.company_id = ?';
  const params = [companyId];
  if (status && ['pending', 'completed', 'canceled'].includes(status)) { where += ' AND t.status = ?'; params.push(status); }
  const total = (await db.prepare(`SELECT COUNT(*) AS c FROM stock_transfers t${where}`).get(...params)).c;
  const items = await db.prepare(`${SQL}${where} ORDER BY t.id DESC LIMIT ? OFFSET ?`).all(...params, perPage, offset);
  return { items, total, page, perPage };
}

async function create(companyId, actorId, data) {
  const fromId = await assertStore(companyId, Number(data.from_store_id), 'Loja de origem');
  const toId = await assertStore(companyId, Number(data.to_store_id), 'Loja de destino');
  if (fromId === toId) throw badRequest('A loja de destino deve ser diferente da origem.');
  const items = await resolveItems(companyId, data.items);
  const note = data.note ? String(data.note).slice(0, 300) : null;

  // Guard-first: INSERT da transferência (id de referência) e itens em
  // batch atômico (mesma ordem semântica da transação original).
  const id = (await db.prepare(
    `INSERT INTO stock_transfers (company_id, from_store_id, to_store_id, note, created_by) VALUES (?, ?, ?, ?, ?)`
  ).run(companyId, fromId, toId, note, actorId)).lastInsertRowid;
  await db.batch(items.map((it) => ({
    sql: 'INSERT INTO stock_transfer_items (company_id, transfer_id, product_id, product_name, product_sku, quantity) VALUES (?, ?, ?, ?, ?, ?)',
    params: [companyId, id, it.product.id, it.product.name, it.product.sku, it.quantity],
  })));
  return await getScoped(companyId, id);
}

async function complete(companyId, id, actorId) {
  const t = await getScoped(companyId, id);
  if (t.status === 'completed') throw conflict('Transferência já concluída.');
  if (t.status === 'canceled') throw conflict('Transferência cancelada não pode ser concluída.');
  const items = t.items.filter((it) => it.product_id !== null);

  // pré-checagem com mensagem clara (a transação revalida atomicamente)
  for (const it of items) {
    const available = await stock.currentBalance(companyId, t.from_store_id, it.product_id);
    if (available < it.quantity) {
      const e = conflict(`Estoque insuficiente para "${it.product_name}" na loja de origem (disponível ${available}, solicitado ${it.quantity}).`);
      e.code = 'INSUFFICIENT_STOCK';
      throw e;
    }
  }

  // Guard-first (padrão D1-ready): UPDATE condicional (idempotente — dupla
  // conclusão → 409 via changes === 0) ANTES do par de movimentações.
  // Origem primeiro (pode falhar por saldo) — origem sem saldo = 409 e
  // destino nunca recebe (mesma ordem semântica da transação original).
  const info = await db.prepare(
    `UPDATE stock_transfers SET status = 'completed', completed_at = datetime('now'), completed_by = ?, updated_at = datetime('now')
     WHERE id = ? AND company_id = ? AND status = 'pending'`
  ).run(actorId, id, companyId);
  if (info.changes === 0) throw conflict('Transferência já concluída.');
  for (const it of items) {
    await stock.applyMovement(companyId, t.from_store_id, it.product_id, 'EXIT', it.quantity, 'transfer', id, actorId, `Transferência #${id} →`);
    await stock.applyMovement(companyId, t.to_store_id, it.product_id, 'ENTRY', it.quantity, 'transfer', id, actorId, `Transferência #${id} ←`);
  }
  return await getScoped(companyId, id);
}

async function cancel(companyId, id, reason, actorId) {
  const t = await getScoped(companyId, id);
  if (t.status !== 'pending') throw conflict('Somente transferências pendentes podem ser canceladas.');
  const r = String(reason || '').trim();
  if (r.length < 3) throw badRequest('Informe o motivo.');
  await db.prepare(
    `UPDATE stock_transfers SET status = 'canceled', canceled_at = datetime('now'), cancel_reason = ?, updated_at = datetime('now')
     WHERE id = ? AND company_id = ? AND status = 'pending'`
  ).run(r.slice(0, 300), id, companyId);
  return await getScoped(companyId, id);
}

module.exports = { list, getScoped, create, complete, cancel };
