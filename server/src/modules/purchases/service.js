'use strict';

/**
 * Compras (v1.9) — FORNECEDOR → COMPRA → ITENS → ESTOQUE.
 * - draft: itens editáveis, sem estoque. received: entrada no estoque (ENTRY
 *   por item, reference_type='purchase') na MESMA transação — recebimento
 *   atômico e idempotente (duplo → 409). canceled: draft livre; received
 *   cancela com SAÍDA por item (estorno) — também transacional.
 * - Snapshot de nome/sku/unidade/custo — histórico inviolável. Total
 *   calculado pelo backend em centavos. Custo NÃO altera products.cost_cents
 *   (último custo/custo médio são políticas futuras documentadas).
 */

const db = require('../../database/connection');
const { badRequest, notFound, conflict } = require('../../core/errors');
const stock = require('../stock/service');

async function assertSupplier(companyId, id) {
  const s = await db.prepare(`SELECT id FROM suppliers WHERE id = ? AND company_id = ? AND status = 'active'`).get(id, companyId);
  if (!s) throw badRequest('Fornecedor inválido para esta empresa.');
  return s.id;
}

async function resolveItems(companyId, items) {
  if (!Array.isArray(items) || items.length === 0) throw badRequest('Informe ao menos um item.');
  const merged = new Map();
  for (const raw of items) {
    const pid = Number(raw?.product_id);
    const qty = Number(raw?.quantity);
    if (!Number.isInteger(pid)) throw badRequest('Item com produto inválido.');
    if (!Number.isInteger(qty) || qty <= 0) throw badRequest('Quantidade inválida (inteiro maior que zero).');
    merged.set(pid, (merged.get(pid) || 0) + qty);
  }
  const out = [];
  for (const [pid, qty] of merged) {
    const p = await db.prepare(`SELECT id, name, sku, unit, cost_cents FROM products WHERE id = ? AND company_id = ? AND status = 'active'`).get(pid, companyId);
    if (!p) throw badRequest('Produto inválido para esta empresa.');
    let unitCost = rawCost(rawByPid(items, pid));
    if (unitCost === null) unitCost = p.cost_cents;
    if (!unitCost || unitCost <= 0) throw badRequest(`Informe o custo de "${p.name}" (produto sem custo cadastral).`);
    out.push({ product: p, quantity: qty, unit_cost_cents: unitCost, subtotal_cents: unitCost * qty });
  }
  return out;
}
// helper: recupera o raw do primeiro item do produto (para unit_cost opcional)
function rawByPid(items, pid) { return items.find((r) => Number(r.product_id) === pid); }
function rawCost(raw) {
  if (raw?.unit_cost === undefined || raw?.unit_cost === null || raw?.unit_cost === '') return null;
  const n = Number(String(raw.unit_cost).includes(',') ? String(raw.unit_cost).replace(/\./g, '').replace(',', '.') : raw.unit_cost);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

const SQL = `
  SELECT pc.*, s.name AS supplier_name, st.name AS store_name, u.name AS created_by_name
  FROM purchases pc
  JOIN suppliers s ON s.id = pc.supplier_id
  JOIN stores st ON st.id = pc.store_id
  JOIN users u ON u.id = pc.created_by
`;

async function getScoped(companyId, id) {
  const p = await db.prepare(`${SQL} WHERE pc.id = ? AND pc.company_id = ?`).get(id, companyId);
  if (!p) throw notFound('Compra não encontrada.');
  p.items = await db.prepare(
    `SELECT id, product_id, product_name, product_sku, product_unit, unit_cost_cents, quantity, subtotal_cents
     FROM purchase_items WHERE purchase_id = ? AND company_id = ? ORDER BY id`
  ).all(id, companyId);
  return p;
}

async function list(companyId, { page, perPage, offset, status, store_id, supplier_id, from, to }) {
  let where = ' WHERE pc.company_id = ?';
  const params = [companyId];
  if (status && ['draft', 'received', 'canceled'].includes(status)) { where += ' AND pc.status = ?'; params.push(status); }
  if (store_id) { where += ' AND pc.store_id = ?'; params.push(store_id); }
  if (supplier_id) { where += ' AND pc.supplier_id = ?'; params.push(supplier_id); }
  if (from) { where += ' AND date(pc.purchase_date) >= date(?)'; params.push(String(from).slice(0, 10)); }
  if (to) { where += ' AND date(pc.purchase_date) <= date(?)'; params.push(String(to).slice(0, 10)); }
  const total = (await db.prepare(`SELECT COUNT(*) AS c FROM purchases pc${where}`).get(...params)).c;
  const items = await db.prepare(`${SQL}${where} ORDER BY pc.purchase_date DESC, pc.id DESC LIMIT ? OFFSET ?`)
    .all(...params, perPage, offset);
  return { items, total, page, perPage };
}

async function create(companyId, actorId, data) {
  const storeId = await stock.assertStoreInCompany(companyId, data.store_id);
  const supplierId = await assertSupplier(companyId, Number(data.supplier_id));
  const date = String(data.purchase_date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('Data da compra inválida.');
  const items = await resolveItems(companyId, data.items);
  const total = items.reduce((acc, it) => acc + it.subtotal_cents, 0);
  const note = data.note ? String(data.note).slice(0, 300) : null;

  // Guard-first: INSERT da compra (id de referência) + itens em batch
  // atômico (mesma ordem semântica da transação original).
  const id = (await db.prepare(
    `INSERT INTO purchases (company_id, store_id, supplier_id, purchase_date, total_cents, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(companyId, storeId, supplierId, date, total, note, actorId)).lastInsertRowid;
  await db.batch(items.map((it) => ({
    sql: 'INSERT INTO purchase_items (company_id, purchase_id, product_id, product_name, product_sku, product_unit, unit_cost_cents, quantity, subtotal_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    params: [companyId, id, it.product.id, it.product.name, it.product.sku, it.product.unit, it.unit_cost_cents, it.quantity, it.subtotal_cents],
  })));
  return await getScoped(companyId, id);
}

/** Edição SOMENTE em rascunho (itens substituídos inteiramente). */
async function update(companyId, id, data) {
  const current = await getScoped(companyId, id);
  if (current.status !== 'draft') throw conflict('Somente compras em rascunho podem ser editadas.');
  const items = data.items !== undefined ? await resolveItems(companyId, data.items) : null;
  const date = data.purchase_date !== undefined ? String(data.purchase_date).slice(0, 10) : undefined;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('Data inválida.');
  const note = data.note !== undefined ? (data.note ? String(data.note).slice(0, 300) : null) : undefined;
  const total = items ? items.reduce((acc, it) => acc + it.subtotal_cents, 0) : undefined;

  // Guard-first (mesma semântica da transação original): DELETE + UPDATE +
  // INSERTs dos novos itens em batch atômico.
  if (items) {
    await db.prepare('DELETE FROM purchase_items WHERE purchase_id = ? AND company_id = ?').run(id, companyId);
  }
  await db.prepare(
    `UPDATE purchases SET purchase_date = COALESCE(?, purchase_date), total_cents = COALESCE(?, total_cents),
       note = CASE WHEN ? THEN ? ELSE note END, updated_at = datetime('now')
     WHERE id = ? AND company_id = ?`
  ).run(date ?? null, total ?? null, note !== undefined ? 1 : 0, note ?? null, id, companyId);
  if (items) {
    await db.batch(items.map((it) => ({
      sql: 'INSERT INTO purchase_items (company_id, purchase_id, product_id, product_name, product_sku, product_unit, unit_cost_cents, quantity, subtotal_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      params: [companyId, id, it.product.id, it.product.name, it.product.sku, it.product.unit, it.unit_cost_cents, it.quantity, it.subtotal_cents],
    })));
  }
  return await getScoped(companyId, id);
}

/** Recebimento/estorno exigem Stock ATIVO (geram movimentação). Draft pode
 * existir sem Stock; concluir não. Nada persiste se o módulo estiver off. */
async function requireStockActive(companyId) {
  const { isModuleActive } = require('../../core/modules');
  const { ApiError } = require('../../core/errors');
  if (!(await isModuleActive(companyId, 'stock'))) {
    throw new ApiError(403, 'MODULE_INACTIVE', 'O módulo de estoque está inativo para esta empresa.');
  }
}

/** Recebimento: status + ENTRY por item na MESMA transação. Idempotente. */
async function receive(companyId, id, actorId) {
  const current = await getScoped(companyId, id);
  if (current.status === 'received') throw conflict('Compra já recebida.');
  if (current.status === 'canceled') throw conflict('Compra cancelada não pode ser recebida.');
  await requireStockActive(companyId);
  const items = current.items.filter((it) => it.product_id !== null);

  // Guard-first (padrão D1-ready): UPDATE condicional (idempotente — duplo
  // recebimento → 409 via changes === 0) ANTES do estoque e do título.
  // Título permanece idempotente por UNIQUE(company_id, purchase_id).
  const info = await db.prepare(
    `UPDATE purchases SET status = 'received', received_at = datetime('now'), received_by = ?, updated_at = datetime('now')
     WHERE id = ? AND company_id = ? AND status = 'draft'`
  ).run(actorId, id, companyId);
  if (info.changes === 0) throw conflict('Compra já recebida.');
  for (const it of items) {
    await stock.applyMovement(companyId, current.store_id, it.product_id, 'ENTRY', it.quantity, 'purchase', id, actorId, `Compra #${id}`);
  }
  // Contas a Pagar (v2.0): compra recebida gera título. Idempotente por
  // UNIQUE(company_id, purchase_id). Se o módulo payables estiver inativo
  // para a empresa, a compra segue sem título.
  const { isModuleActive } = require('../../core/modules');
  if (await isModuleActive(companyId, 'payables')) {
    await require('../payables/service').createFromPurchase(companyId, current, actorId);
  }
  return await getScoped(companyId, id);
}

/** Cancelamento: draft → simples; received → SAÍDA por item (estorno). */
async function cancel(companyId, id, reason, actorId) {
  const current = await getScoped(companyId, id);
  if (current.status === 'canceled') throw conflict('Compra já cancelada.');
  const r = String(reason || '').trim();
  if (r.length < 3) throw badRequest('Informe o motivo do cancelamento.');
  const items = current.items.filter((it) => it.product_id !== null);
  const wasReceived = current.status === 'received';
  if (wasReceived) await requireStockActive(companyId); // estorno gera movimentação

  // INTEGRIDADE FINANCEIRA (consolidação v2.0 + espelho v3.0): a consulta do
  // título NÃO depende do módulo estar ativo — o registro financeiro EXISTE
  // e sua consistência deve ser preservada (o gating bloqueia apenas NOVAS
  // operações do módulo). Título PAGO bloqueia o cancelamento ANTES de
  // qualquer escrita; título OPEN é cancelado na MESMA transação do estorno.
  let payable = null;
  if (wasReceived) {
    payable = await db.prepare('SELECT id, status FROM accounts_payable WHERE company_id = ? AND purchase_id = ?').get(companyId, id);
    if (payable && payable.status === 'paid') {
      throw conflict('Esta compra possui um título financeiro JÁ PAGO. O cancelamento não é permitido porque o estorno financeiro ainda não está disponível.');
    }
  }

  // All-or-nothing: estorno de compra é SAÍDA de estoque — viabilidade
  // verificada ANTES de qualquer escrita (mesma semântica da transação
  // original: cancelamento falha sem persistir nada).
  if (wasReceived) {
    for (const it of items) {
      const available = await stock.currentBalance(companyId, current.store_id, it.product_id);
      if (available < it.quantity) {
        const e = conflict('Estoque insuficiente para estornar a compra. Ajuste o estoque antes de cancelar.');
        e.code = 'INSUFFICIENT_STOCK';
        throw e;
      }
    }
  }
  // Guard-first (padrão D1-ready): UPDATE condicional (idempotente em retry)
  // ANTES do estorno de estoque e do cancelamento do título OPEN.
  const info = await db.prepare(
    `UPDATE purchases SET status = 'canceled', canceled_at = datetime('now'), cancel_reason = ?, updated_at = datetime('now')
     WHERE id = ? AND company_id = ? AND status != 'canceled'`
  ).run(r.slice(0, 300), id, companyId);
  if (info.changes === 0) throw conflict('Compra já cancelada.');
  if (wasReceived) {
    for (const it of items) {
      await stock.applyMovement(companyId, current.store_id, it.product_id, 'EXIT', it.quantity, 'purchase', id, actorId, `Estorno de compra: ${r.slice(0, 200)}`);
    }
  }
  // Título OPEN acompanha o cancelamento (condicional: não duplica em retry)
  if (payable && payable.status === 'open') {
    await db.prepare(
      `UPDATE accounts_payable SET status = 'canceled', updated_by = ?, updated_at = datetime('now')
       WHERE id = ? AND status = 'open'`
    ).run(actorId, payable.id);
  }
  return await getScoped(companyId, id);
}

module.exports = { list, getScoped, create, update, receive, cancel };
