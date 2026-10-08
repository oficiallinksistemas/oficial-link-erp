'use strict';

/**
 * Serviço de Estoque (v1.8) — saldo por EMPRESA + LOJA + PRODUTO.
 *
 * - Quantidades em INTEGER (decisão v1.7.1 mantida: frações trabalham em
 *   unidade base — grama/ml — quando o Estoque evoluir; nada de float).
 * - Saldo NUNCA negativo: UPDATE condicional (`AND quantity >= ?`) garante
 *   atomicidade mesmo com concorrência (SQLite serializa a escrita; se o
 *   UPDATE afetar 0 linhas, estoque insuficiente).
 * - Toda alteração gera MOVIMENTAÇÃO imutável (before/after, referência,
 *   usuário). Movimentações não são apagadas — correções viram ajustes.
 * - Linha de saldo NASCE na primeira movimentação da combinação (sem
 *   pré-criar produto × loja). Sem saldo = 0 na visualização.
 */

const db = require('../../database/connection');
const { badRequest, notFound, conflict } = require('../../core/errors');

// ---------------------------------------------------------------------------
// Núcleo: aplicação de movimentação (sempre dentro da transação do chamador)
// ---------------------------------------------------------------------------

const DECREASE = new Set(['EXIT', 'SALE', 'ADJUST_OUT']);

async function assertStoreInCompany(companyId, storeId) {
  const s = await db.prepare(`SELECT id FROM stores WHERE id = ? AND company_id = ? AND status = 'active'`).get(storeId, companyId);
  if (!s) throw badRequest('Loja inválida para esta empresa.');
  return s.id;
}

async function assertProductInCompany(companyId, productId) {
  const p = await db.prepare(`SELECT id, name FROM products WHERE id = ? AND company_id = ? AND status = 'active'`).get(productId, companyId);
  if (!p) throw badRequest('Produto inválido para esta empresa.');
  return p;
}

function parseQty(value, field = 'Quantidade') {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`${field} inválida (inteiro maior que zero).`);
  return n;
}

/** Cria a linha de saldo se não existir e retorna o saldo atual. */
async function ensureBalance(companyId, storeId, productId) {
  await db.prepare(
    `INSERT OR IGNORE INTO stock_balances (company_id, store_id, product_id, quantity)
     VALUES (?, ?, ?, 0)`
  ).run(companyId, storeId, productId);
  return (await db.prepare('SELECT quantity FROM stock_balances WHERE company_id = ? AND store_id = ? AND product_id = ?')
    .get(companyId, storeId, productId)).quantity;
}

/**
 * Aplica uma movimentação ATÔMICA (chame dentro de db.transaction):
 * decrementos usam UPDATE condicional — 0 linhas afetadas = estoque
 * insuficiente (lança ApiError 409 INSUFFICIENT_STOCK).
 */
async function applyMovement(companyId, storeId, productId, type, quantity, referenceType, referenceId, userId, note = null) {
  const decrease = DECREASE.has(type);
  const before = await ensureBalance(companyId, storeId, productId);
  let after;
  if (decrease) {
    const info = await db.prepare(
      `UPDATE stock_balances SET quantity = quantity - ?, updated_at = datetime('now')
       WHERE company_id = ? AND store_id = ? AND product_id = ? AND quantity >= ?`
    ).run(quantity, companyId, storeId, productId, quantity);
    if (info.changes === 0) {
      throw conflict('Estoque insuficiente para concluir a operação.', undefined);
    }
    after = before - quantity;
  } else {
    await db.prepare(
      `UPDATE stock_balances SET quantity = quantity + ?, updated_at = datetime('now')
       WHERE company_id = ? AND store_id = ? AND product_id = ?`
    ).run(quantity, companyId, storeId, productId);
    after = before + quantity;
  }
  await db.prepare(
    `INSERT INTO stock_movements (company_id, store_id, product_id, type, quantity,
       balance_before, balance_after, reference_type, reference_id, user_id, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(companyId, storeId, productId, type, quantity, before, after, referenceType, referenceId, userId, note);
  return { before, after };
}

// ---------------------------------------------------------------------------
// Operações manuais
// ---------------------------------------------------------------------------

async function entry(companyId, userId, { store_id, product_id, quantity, note }) {
  const storeId = await assertStoreInCompany(companyId, store_id);
  const product = await assertProductInCompany(companyId, product_id);
  const qty = parseQty(quantity);
  const { before, after } = await applyMovement(companyId, storeId, product.id, 'ENTRY', qty, 'manual', null, userId, note ? String(note).slice(0, 300) : null);
  return { product: product.name, before, after };
}

async function exit(companyId, userId, { store_id, product_id, quantity, note }) {
  const storeId = await assertStoreInCompany(companyId, store_id);
  const product = await assertProductInCompany(companyId, product_id);
  const qty = parseQty(quantity);
  // pré-checagem com mensagem clara; a transação revalida atomicamente
  const available = await currentBalance(companyId, storeId, product.id);
  if (available < qty) {
    const e = conflict(`Estoque insuficiente para "${product.name}" (disponível ${available}, solicitado ${qty}).`);
    e.code = 'INSUFFICIENT_STOCK';
    throw e;
  }
  const { before, after } = await applyMovement(companyId, storeId, product.id, 'EXIT', qty, 'manual', null, userId, note ? String(note).slice(0, 300) : null);
  return { product: product.name, before, after };
}

async function adjust(companyId, userId, { store_id, product_id, new_quantity, note }) {
  const storeId = await assertStoreInCompany(companyId, store_id);
  const product = await assertProductInCompany(companyId, product_id);
  const target = Number(new_quantity);
  if (!Number.isInteger(target) || target < 0) throw badRequest('Quantidade ajustada inválida (inteiro ≥ 0).');
  const current = await currentBalance(companyId, storeId, product.id);
  if (target === current) throw badRequest('O saldo já está igual ao informado.');
  const qty = Math.abs(target - current);
  const type = target > current ? 'ADJUST_IN' : 'ADJUST_OUT';
  const { before, after } = await applyMovement(companyId, storeId, product.id, type, qty, 'adjust', null, userId,
    `Ajuste de ${current} para ${target}${note ? ' — ' + String(note).slice(0, 250) : ''}`);
  return { product: product.name, type, before, after };
}

async function currentBalance(companyId, storeId, productId) {
  const row = await db.prepare('SELECT quantity FROM stock_balances WHERE company_id = ? AND store_id = ? AND product_id = ?')
    .get(companyId, storeId, productId);
  return row ? row.quantity : 0;
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

/**
 * Visão de estoque. COM loja: saldo daquela loja. SEM loja: AGREGAÇÃO (soma
 * das lojas) — nunca linhas duplicadas ambíguas; quantity = total da empresa
 * e store_name = 'Todas as lojas'.
 */
async function listBalances(companyId, { page, perPage, offset, store_id, search, category_id, low, zero, status }) {
  const storeId = store_id ? await assertStoreInCompany(companyId, store_id) : null;
  let where = ' WHERE p.company_id = ?';
  const params = [companyId];
  if (search) {
    const term = `%${String(search).slice(0, 80)}%`;
    where += ' AND (p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ?)';
    params.push(term, term, term);
  }
  if (category_id) { where += ' AND p.category_id = ?'; params.push(category_id); }
  if (status === 'active' || status === 'inactive') { where += ' AND p.status = ?'; params.push(status); }

  if (storeId) {
    if (low === '1') where += ' AND COALESCE(b.quantity, 0) > 0 AND COALESCE(b.quantity, 0) < COALESCE(p.minimum_stock, 0) AND p.minimum_stock IS NOT NULL';
    if (zero === '1') where += ' AND COALESCE(b.quantity, 0) = 0';
    const join = ' LEFT JOIN stock_balances b ON b.product_id = p.id AND b.company_id = p.company_id AND b.store_id = ?';
    const total = (await db.prepare(`SELECT COUNT(*) AS c FROM products p${join}${where}`).get(storeId, ...params)).c;
    const items = await db.prepare(
      `SELECT p.id AS product_id, p.name, p.sku, p.unit, p.status, p.minimum_stock,
              p.price_cents, c.name AS category_name, COALESCE(b.quantity, 0) AS quantity
       FROM products p
       LEFT JOIN product_categories c ON c.id = p.category_id
       ${join}${where} ORDER BY p.name LIMIT ? OFFSET ?`
    ).all(storeId, ...params, perPage, offset);
    return { items, total, page, perPage };
  }

  // Agregação por produto (todas as lojas) — mesma semântica do summary:
  // low = total>0 E total<mínimo; zero = total=0 (loja nunca conta como
  // produto separado em visão global).
  const join = ' LEFT JOIN stock_balances b ON b.product_id = p.id AND b.company_id = p.company_id';
  const having = [];
  const havingParams = [];
  if (low === '1') { having.push('COALESCE(SUM(b.quantity), 0) > 0 AND COALESCE(SUM(b.quantity), 0) < COALESCE(p.minimum_stock, 0) AND p.minimum_stock IS NOT NULL'); }
  if (zero === '1') { having.push('COALESCE(SUM(b.quantity), 0) = 0'); }
  const havingSql = having.length ? ` HAVING ${having.join(' AND ')}` : '';
  const base = `FROM products p LEFT JOIN product_categories c ON c.id = p.category_id ${join}${where}
       GROUP BY p.id${havingSql}`;
  const total = (await db.prepare(`SELECT COUNT(*) AS c FROM (SELECT p.id ${base})`).get(...params)).c;
  const items = await db.prepare(
    `SELECT p.id AS product_id, p.name, p.sku, p.unit, p.status, p.minimum_stock,
            p.price_cents, c.name AS category_name, COALESCE(SUM(b.quantity), 0) AS quantity
     ${base} ORDER BY p.name LIMIT ? OFFSET ?`
  ).all(...params, perPage, offset);
  return { items, total, page, perPage };
}

async function listMovements(companyId, { page, perPage, offset, store_id, product_id, type, from, to }) {
  let where = ' WHERE m.company_id = ?';
  const params = [companyId];
  if (store_id) { where += ' AND m.store_id = ?'; params.push(await assertStoreInCompany(companyId, store_id)); }
  if (product_id) {
    const p = await db.prepare('SELECT id FROM products WHERE id = ? AND company_id = ?').get(product_id, companyId);
    if (!p) throw notFound('Produto não encontrado.');
    where += ' AND m.product_id = ?'; params.push(p.id);
  }
  if (type && ['ENTRY', 'EXIT', 'ADJUST_IN', 'ADJUST_OUT', 'SALE', 'SALE_REVERSAL'].includes(type)) {
    where += ' AND m.type = ?'; params.push(type);
  }
  if (from) { where += ' AND date(m.created_at) >= date(?)'; params.push(String(from).slice(0, 10)); }
  if (to) { where += ' AND date(m.created_at) <= date(?)'; params.push(String(to).slice(0, 10)); }

  const total = (await db.prepare(`SELECT COUNT(*) AS c FROM stock_movements m${where}`).get(...params)).c;
  const items = await db.prepare(
    `SELECT m.id, m.type, m.quantity, m.balance_before, m.balance_after,
            m.reference_type, m.reference_id, m.note, m.created_at,
            p.name AS product_name, p.sku, p.unit, st.name AS store_name, u.name AS user_name
     FROM stock_movements m
     JOIN products p ON p.id = m.product_id
     JOIN stores st ON st.id = m.store_id
     JOIN users u ON u.id = m.user_id
     ${where} ORDER BY m.id DESC LIMIT ? OFFSET ?`
  ).all(...params, perPage, offset);
  return { items, total, page, perPage };
}

/**
 * Resumo — semântica por escopo (coerente com a visão apresentada):
 * - COM store_id: saldo/alertas DAQUELA LOJA (por linha de saldo da loja).
 * - SEM store_id (GLOBAL): por PRODUTO, com global_quantity = SUM das lojas.
 *   zero = global_quantity = 0; low = global_quantity > 0 E < minimum_stock.
 *   NUNCA contar cada loja como produto separado em visão global
 *   (ex.: 5+5 com mínimo 10 = total 10 → NÃO é baixo nem zerado).
 */
async function summary(companyId, storeId = null) {
  if (storeId) {
    const total = (await db.prepare('SELECT COALESCE(SUM(quantity),0) AS t FROM stock_balances WHERE company_id = ? AND store_id = ?').get(companyId, storeId)).t;
    const low = (await db.prepare(
      `SELECT COUNT(*) AS c FROM products p
       LEFT JOIN stock_balances b ON b.product_id = p.id AND b.company_id = p.company_id AND b.store_id = ?
       WHERE p.company_id = ? AND p.status = 'active' AND p.minimum_stock IS NOT NULL
         AND COALESCE(b.quantity, 0) > 0 AND COALESCE(b.quantity, 0) < p.minimum_stock`
    ).get(storeId, companyId)).c;
    const zero = (await db.prepare(
      `SELECT COUNT(*) AS c FROM products p
       LEFT JOIN stock_balances b ON b.product_id = p.id AND b.company_id = p.company_id AND b.store_id = ?
       WHERE p.company_id = ? AND COALESCE(b.quantity, 0) = 0`
    ).get(storeId, companyId)).c;
    return { total_units: total, low_stock: low, zero_stock: zero, scope: 'store' };
  }

  const total = (await db.prepare('SELECT COALESCE(SUM(quantity),0) AS t FROM stock_balances WHERE company_id = ?').get(companyId)).t;
  const gq = (extra = '') => `COALESCE((SELECT SUM(b.quantity) FROM stock_balances b WHERE b.product_id = p.id AND b.company_id = p.company_id${extra}), 0)`;
  const low = (await db.prepare(
    `SELECT COUNT(*) AS c FROM products p
     WHERE p.company_id = ? AND p.status = 'active' AND p.minimum_stock IS NOT NULL
       AND ${gq()} > 0 AND ${gq()} < p.minimum_stock`
  ).get(companyId)).c;
  const zero = (await db.prepare(
    `SELECT COUNT(*) AS c FROM products p WHERE p.company_id = ? AND ${gq()} = 0`
  ).get(companyId)).c;
  return { total_units: total, low_stock: low, zero_stock: zero, scope: 'company' };
}

module.exports = {
  applyMovement, currentBalance, entry, exit, adjust,
  listBalances, listMovements, summary, assertStoreInCompany,
};
