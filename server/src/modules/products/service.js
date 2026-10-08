'use strict';

/**
 * Serviço de Produtos (v1.7) — padrão Customer: escopo tenant, validações
 * backend, snapshot nas vendas, exclusão protegida.
 *
 * - Valores monetários em CENTAVOS (mesmo padrão de Sales).
 * - SKU e código de barras normalizados e únicos POR EMPREZA (quando
 *   preenchidos); empresa diferente pode repetir.
 * - Unidade com domínio fechado (UN, KG, CX, PC, LT, MT, M2, M3, PAR).
 * - Estoque mínimo é dado cadastral para o futuro módulo Estoque — NENHUM
 *   "estoque atual" é inventado nesta versão.
 * - Exclusão física SOMENTE sem vendas; com vendas → 409 (desativar).
 * - Categorias são entidade interna do módulo (company_id, nome único).
 */

const db = require('../../database/connection');
const { badRequest, notFound, conflict } = require('../../core/errors');
const { parseAmountCents } = require('../sales/service');

const UNITS = ['UN', 'PC', 'CX', 'PCT', 'KG', 'G', 'LT', 'L', 'ML', 'MT', 'M', 'CM', 'M2', 'M3', 'PAR'];

const norm = (v, max) => {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

function parseUnit(value) {
  const u = String(value || 'UN').trim().toUpperCase();
  if (!UNITS.includes(u)) throw badRequest(`Unidade inválida. Use: ${UNITS.join(', ')}.`);
  return u;
}

function optionalCents(value, field) {
  if (value === undefined || value === null || value === '') return null;
  return parseAmountCents(value, field);
}

function optionalInt(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw badRequest(`${field} inválido.`);
  return n;
}

async function assertCategoryInCompany(companyId, categoryId) {
  const c = await db.prepare(`SELECT id FROM product_categories WHERE id = ? AND company_id = ? AND status = 'active'`).get(categoryId, companyId);
  if (!c) throw badRequest('Categoria inválida para esta empresa.');
  return c.id;
}

// ---------------------------------------------------------------------------
// Categorias
// ---------------------------------------------------------------------------

async function listCategories(companyId) {
  return await db.prepare(
    `SELECT id, name, status, created_at FROM product_categories
     WHERE company_id = ? ORDER BY name`
  ).all(companyId);
}

async function createCategory(companyId, name) {
  const n = String(name || '').trim();
  if (n.length < 2 || n.length > 80) throw badRequest('Nome da categoria inválido (2 a 80).');
  try {
    const id = (await db.prepare('INSERT INTO product_categories (company_id, name) VALUES (?, ?)').run(companyId, n)).lastInsertRowid;
    return await db.prepare('SELECT id, name, status, created_at FROM product_categories WHERE id = ?').get(id);
  } catch (err) {
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) throw conflict('Já existe uma categoria com este nome.');
    throw err;
  }
}

/**
 * Exclusão de categoria: SOMENTE sem produtos associados (proteção de uso);
 * produtos referenciam-na com ON DELETE SET NULL — mesmo assim, a regra de
 * negócio exige 409 para não perder a classificação acidentalmente.
 */
async function removeCategory(companyId, id) {
  const cat = await db.prepare('SELECT id, name FROM product_categories WHERE id = ? AND company_id = ?').get(id, companyId);
  if (!cat) throw notFound('Categoria não encontrada.');
  const inUse = (await db.prepare('SELECT COUNT(*) AS c FROM products WHERE category_id = ? AND company_id = ?').get(id, companyId)).c;
  if (inUse > 0) {
    throw conflict('Categoria em uso por produtos. Desative-a ou reatribua os produtos antes de excluir.');
  }
  await db.prepare('DELETE FROM product_categories WHERE id = ? AND company_id = ?').run(id, companyId);
  return cat;
}

async function updateCategory(companyId, id, data) {
  const current = await db.prepare('SELECT id FROM product_categories WHERE id = ? AND company_id = ?').get(id, companyId);
  if (!current) throw notFound('Categoria não encontrada.');
  const name = data.name !== undefined ? String(data.name || '').trim() : undefined;
  if (name !== undefined && (name.length < 2 || name.length > 80)) throw badRequest('Nome da categoria inválido.');
  const status = data.status !== undefined ? String(data.status) : undefined;
  if (status !== undefined && !['active', 'inactive'].includes(status)) throw badRequest('Status inválido.');
  try {
    await db.prepare(
      `UPDATE product_categories SET name = COALESCE(?, name), status = COALESCE(?, status), updated_at = datetime('now')
       WHERE id = ? AND company_id = ?`
    ).run(name ?? null, status ?? null, id, companyId);
  } catch (err) {
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) throw conflict('Já existe uma categoria com este nome.');
    throw err;
  }
  return await db.prepare('SELECT id, name, status, created_at FROM product_categories WHERE id = ?').get(id);
}

// ---------------------------------------------------------------------------
// Produtos
// ---------------------------------------------------------------------------

const PRODUCT_SQL = `
  SELECT p.id, p.company_id, p.category_id, p.name, p.description, p.sku, p.barcode,
         p.unit, p.price_cents, p.cost_cents, p.minimum_stock, p.status,
         p.created_at, p.updated_at, c.name AS category_name
  FROM products p
  LEFT JOIN product_categories c ON c.id = p.category_id
`;

async function getScoped(companyId, id) {
  const p = await db.prepare(`${PRODUCT_SQL} WHERE p.id = ? AND p.company_id = ?`).get(id, companyId);
  if (!p) throw notFound('Produto não encontrado.');
  return p;
}

async function list(companyId, { page, perPage, offset, search, category_id, status }) {
  let where = ' WHERE p.company_id = ?';
  const params = [companyId];
  if (search) {
    const term = `%${String(search).slice(0, 80)}%`;
    where += ' AND (p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ?)';
    params.push(term, term, term);
  }
  if (category_id) { where += ' AND p.category_id = ?'; params.push(category_id); }
  if (status === 'active' || status === 'inactive') { where += ' AND p.status = ?'; params.push(status); }

  const total = (await db.prepare(`SELECT COUNT(*) AS c FROM products p${where}`).get(...params)).c;
  const items = await db.prepare(`${PRODUCT_SQL}${where} ORDER BY p.name LIMIT ? OFFSET ?`)
    .all(...params, perPage, offset);
  return { items, total, page, perPage };
}

async function parseProductPayload(companyId, data, partial = false) {
  const out = {};
  const need = (v, field) => {
    if (v === undefined || v === null || String(v).trim() === '') throw badRequest(`${field} é obrigatório.`);
    return String(v).trim();
  };
  out.name = partial && data.name === undefined ? undefined : need(data.name, 'Nome');
  if (out.name !== undefined && out.name.length > 120) throw badRequest('Nome muito longo.');
  if (data.description !== undefined) out.description = norm(data.description, 500);
  if (data.sku !== undefined) out.sku = norm(data.sku, 40);
  if (data.barcode !== undefined) out.barcode = norm(data.barcode, 40);
  if (data.unit !== undefined) out.unit = parseUnit(data.unit);
  if (data.price !== undefined || data.price_cents !== undefined) {
    out.price_cents = parseAmountCents(data.price !== undefined ? data.price : data.price_cents / 100, 'Preço');
  }
  if (data.cost !== undefined) out.cost_cents = optionalCents(data.cost, 'Custo');
  if (data.minimum_stock !== undefined) out.minimum_stock = optionalInt(data.minimum_stock, 'Estoque mínimo');
  if (data.category_id !== undefined) {
    out.category_id = data.category_id === null ? null : await assertCategoryInCompany(companyId, Number(data.category_id));
  }
  if (data.status !== undefined) {
    if (!['active', 'inactive'].includes(String(data.status))) throw badRequest('Status inválido.');
    out.status = String(data.status);
  }
  return out;
}

async function create(companyId, data) {
  const p = await parseProductPayload(companyId, data);
  let id;
  try {
    id = (await db.prepare(
      `INSERT INTO products (company_id, category_id, name, description, sku, barcode, unit, price_cents, cost_cents, minimum_stock)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      companyId, p.category_id ?? null, p.name, p.description ?? null, p.sku ?? null,
      p.barcode ?? null, p.unit ?? 'UN', p.price_cents, p.cost_cents ?? null, p.minimum_stock ?? null
    )).lastInsertRowid;
  } catch (err) {
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
      throw conflict('SKU ou código de barras já cadastrado nesta empresa.');
    }
    throw err;
  }
  return await getScoped(companyId, id);
}

async function update(companyId, id, data) {
  await getScoped(companyId, id);
  const p = await parseProductPayload(companyId, data, true);

  try {
    await db.prepare(
      `UPDATE products SET
         name = COALESCE(?, name), description = CASE WHEN ? THEN ? ELSE description END,
         sku = CASE WHEN ? THEN ? ELSE sku END,
         barcode = CASE WHEN ? THEN ? ELSE barcode END,
         unit = COALESCE(?, unit), price_cents = COALESCE(?, price_cents),
         cost_cents = CASE WHEN ? THEN ? ELSE cost_cents END,
         minimum_stock = CASE WHEN ? THEN ? ELSE minimum_stock END,
         category_id = CASE WHEN ? THEN ? ELSE category_id END,
         status = COALESCE(?, status), updated_at = datetime('now')
       WHERE id = ? AND company_id = ?`
    ).run(
      p.name ?? null,
      p.description !== undefined ? 1 : 0, p.description ?? null,
      p.sku !== undefined ? 1 : 0, p.sku ?? null,
      p.barcode !== undefined ? 1 : 0, p.barcode ?? null,
      p.unit ?? null, p.price_cents ?? null,
      p.cost_cents !== undefined ? 1 : 0, p.cost_cents ?? null,
      p.minimum_stock !== undefined ? 1 : 0, p.minimum_stock ?? null,
      p.category_id !== undefined ? 1 : 0, p.category_id ?? null,
      p.status ?? null, id, companyId
    );
  } catch (err) {
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
      throw conflict('SKU ou código de barras já cadastrado nesta empresa.');
    }
    throw err;
  }
  return await getScoped(companyId, id);
}

async function remove(companyId, id) {
  const p = await getScoped(companyId, id);
  // HARDENING v1.9: nenhum erro bruto de FK — dependências de histórico
  // (vendas, itens, saldo/movimentações) bloqueiam com 409 orientado.
  const salesCount = (await db.prepare('SELECT COUNT(*) AS c FROM sales WHERE product_id = ? AND company_id = ?').get(id, companyId)).c;
  const itemsCount = (await db.prepare('SELECT COUNT(*) AS c FROM sale_items WHERE product_id = ? AND company_id = ?').get(id, companyId)).c;
  const movementsCount = (await db.prepare('SELECT COUNT(*) AS c FROM stock_movements WHERE product_id = ? AND company_id = ?').get(id, companyId)).c;
  const balanceQty = (await db.prepare('SELECT COALESCE(SUM(quantity), 0) AS q FROM stock_balances WHERE product_id = ? AND company_id = ?').get(id, companyId)).q;
  const purchasesCount = (await db.prepare('SELECT COUNT(*) AS c FROM purchase_items WHERE product_id = ? AND company_id = ?').get(id, companyId)).c;
  const inventoryCount = (await db.prepare('SELECT COUNT(*) AS c FROM inventory_items WHERE product_id = ? AND company_id = ?').get(id, companyId)).c;
  const transfersCount = (await db.prepare('SELECT COUNT(*) AS c FROM stock_transfer_items WHERE product_id = ? AND company_id = ?').get(id, companyId)).c;
  if (salesCount + itemsCount + movementsCount + purchasesCount + inventoryCount + transfersCount > 0 || balanceQty > 0) {
    throw conflict('Este produto possui histórico (vendas, estoque, compras, transferências ou inventário) e não pode ser excluído. Desative-o para preservar o histórico.');
  }
  await db.prepare('DELETE FROM products WHERE id = ? AND company_id = ?').run(id, companyId);
  return p;
}

module.exports = {
  UNITS, list, getScoped, create, update, remove,
  listCategories, createCategory, updateCategory, removeCategory,
};
