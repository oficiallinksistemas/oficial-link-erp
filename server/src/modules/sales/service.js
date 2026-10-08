'use strict';

/**
 * Serviço de Vendas (v1.8) — multi-item + integração transacional com Estoque.
 *
 * - FLUXO NOVO: payload com items[] (product_id + quantity). Preço unitário
 *   vem do Products (backend é autoridade); subtotal e total CALCULADOS em
 *   centavos. Duplicados no mesmo produto são SOMADOS.
 * - FLUXO LEGADO (compatibilidade): amount + product_id opcional — mantido
 *   intocado para vendas sem catálogo/item.
 * - ATOMICIDADE: venda + itens + baixas de estoque na MESMA transação;
 *   decremento usa UPDATE condicional — qualquer item sem estoque falha a
 *   operação INTEIRA (nada persiste parcialmente).
 * - STOCK INATIVO: venda com itens registra histórico (itens/snapshot), mas
 *   NÃO movimenta saldo nem cria movimentações.
 * - CANCELAMENTO: estorna cada item (SALE_REVERSAL) em transação; cancelar
 *   duas vezes continua bloqueado (409) — estorno nunca ocorre duas vezes.
 * - SNAPSHOT: sale_items guarda nome/sku/unidade/preço do momento da venda —
 *   alterações futuras de Products nunca reescrevem o histórico.
 */

const db = require('../../database/connection');
const { badRequest, notFound, conflict } = require('../../core/errors');
const stock = require('../stock/service');
const { isModuleActive } = require('../../core/modules');

// ---------------------------------------------------------------------------
// Parsers/validadores (inalterados desde a v1.2)
// ---------------------------------------------------------------------------

/** Aceita número (1234.56) ou string pt-BR ("1.234,56" | "1234.56") → centavos. */
function parseAmountCents(value, field = 'Valor') {
  let cents;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw badRequest(`${field} inválido.`);
    cents = Math.round(value * 100);
  } else if (typeof value === 'string') {
    const s = value.trim();
    if (!s) throw badRequest(`${field} é obrigatório.`);
    const normalized = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
    const n = Number(normalized);
    if (!Number.isFinite(n)) throw badRequest(`${field} inválido.`);
    cents = Math.round(n * 100);
  } else {
    throw badRequest(`${field} é obrigatório.`);
  }
  if (cents <= 0) throw badRequest(`${field} deve ser maior que zero.`);
  if (cents > 999_999_999_99) throw badRequest(`${field} excede o limite permitido.`);
  return cents;
}

/** Aceita 'YYYY-MM-DD' ou 'YYYY-MM-DD HH:mm' → 'YYYY-MM-DD HH:MM' (validado). */
function parseSoldAt(value) {
  const s = String(value || '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/);
  if (!m) throw badRequest('Data da venda inválida. Use AAAA-MM-DD ou AAAA-MM-DD HH:MM.');
  const [, y, mo, d, h = '00', mi = '00'] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi));
  if (date.getUTCFullYear() !== +y || date.getUTCMonth() !== +mo - 1 || date.getUTCDate() !== +d) {
    throw badRequest('Data da venda inexistente.');
  }
  if (+h > 23 || +mi > 59) throw badRequest('Hora da venda inválida.');
  return `${y}-${mo}-${d} ${h}:${mi}`;
}

// ---------------------------------------------------------------------------
// Escopo e vínculos (anti-IDOR)
// ---------------------------------------------------------------------------

async function assertStoreInCompany(companyId, storeId) {
  const store = await db.prepare('SELECT id FROM stores WHERE id = ? AND company_id = ?').get(storeId, companyId);
  if (!store) throw badRequest('Loja inválida para esta empresa.');
  return store.id;
}

async function assertSellerInCompany(companyId, sellerId) {
  const seller = await db.prepare(`SELECT id FROM users WHERE id = ? AND company_id = ? AND status = 'active'`).get(sellerId, companyId);
  if (!seller) throw badRequest('Vendedor inválido para esta empresa.');
  return seller.id;
}

async function assertCustomerInCompany(companyId, customerId) {
  const customer = await db.prepare('SELECT id FROM customers WHERE id = ? AND company_id = ?').get(customerId, companyId);
  if (!customer) throw badRequest('Cliente inválido para esta empresa.');
  return customer.id;
}

/** Produto para venda: exige módulo Products ATIVO (sem bypass), mesmo
 *  tenant e status ativo. Retorna o produto para o snapshot. */
async function assertProductForSale(companyId, productId) {
  if (!(await isModuleActive(companyId, 'products'))) {
    throw badRequest('O módulo de produtos está inativo para esta empresa.');
  }
  const product = db
    .prepare(`SELECT id, name, sku, unit, price_cents FROM products WHERE id = ? AND company_id = ? AND status = 'active'`)
    .get(productId, companyId);
  if (!product) throw badRequest('Produto inválido para esta empresa.');
  return product;
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

const SALE_SQL = `
  SELECT s.id, s.store_id, s.seller_id, s.customer_id, s.customer_name,
         s.product_id, s.product_name, s.product_price_cents,
         s.amount_cents, s.sold_at, s.note, s.status,
         s.canceled_at, s.cancel_reason, s.created_at, s.stock_was_applied,
         (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS items_count,
         st.name AS store_name, u.name AS seller_name, cu.name AS created_by_name
  FROM sales s
  JOIN stores st ON st.id = s.store_id
  JOIN users u ON u.id = s.seller_id
  JOIN users cu ON cu.id = s.created_by
`;

async function getScoped(companyId, id) {
  const sale = await db.prepare(`${SALE_SQL} WHERE s.id = ? AND s.company_id = ?`).get(id, companyId);
  if (!sale) throw notFound('Venda não encontrada.');
  return sale;
}

/** Detalhe incluindo os itens (snapshot) da venda. */
async function getDetail(companyId, id) {
  const sale = await getScoped(companyId, id);
  sale.items = await db.prepare(
    `SELECT id, product_id, product_name, product_sku, product_unit,
            unit_price_cents, quantity, subtotal_cents
     FROM sale_items WHERE sale_id = ? AND company_id = ? ORDER BY id`
  ).all(id, companyId);
  return sale;
}

async function list(companyId, { page, perPage, offset, search, store_id, seller_id, status }) {
  let where = ' WHERE s.company_id = ?';
  const params = [companyId];
  if (search) {
    where += ' AND s.customer_name LIKE ?';
    params.push(`%${search}%`);
  }
  if (store_id) { where += ' AND s.store_id = ?'; params.push(store_id); }
  if (seller_id) { where += ' AND s.seller_id = ?'; params.push(seller_id); }
  if (status) { where += ' AND s.status = ?'; params.push(status); }

  const total = (await db.prepare(`SELECT COUNT(*) AS c FROM sales s${where}`).get(...params)).c;
  const items = await db.prepare(`${SALE_SQL}${where} ORDER BY s.sold_at DESC, s.id DESC LIMIT ? OFFSET ?`)
    .all(...params, perPage, offset);
  return { items, total, page, perPage };
}

// ---------------------------------------------------------------------------
// Criação
// ---------------------------------------------------------------------------

/**
 * Resolve e valida items[] (fluxo novo) ou product_id legado.
 * Retorna array de itens com snapshot e subtotais calculados.
 */
async function resolveItems(companyId, data) {
  const hasItems = Array.isArray(data.items) && data.items.length > 0;
  if (hasItems && (data.amount !== undefined && data.amount !== null && data.amount !== '')) {
    throw badRequest('Informe itens[] OU valor total, não ambos.');
  }
  if (hasItems && data.product_id) {
    throw badRequest('Use items[] ou product_id, não ambos.');
  }

  const merged = new Map();
  if (hasItems) {
    for (const raw of data.items) {
      const pid = Number(raw?.product_id);
      const qty = Number(raw?.quantity);
      if (!Number.isInteger(pid)) throw badRequest('Item com produto inválido.');
      if (!Number.isInteger(qty) || qty <= 0) throw badRequest('Quantidade inválida (inteiro maior que zero).');
      merged.set(pid, (merged.get(pid) || 0) + qty); // duplicados somam
    }
  } else if (data.product_id) {
    merged.set(Number(data.product_id), 1);
  }

  const items = [];
  for (const [pid, qty] of merged) {
    const product = await assertProductForSale(companyId, pid);
    items.push({
      product,
      quantity: qty,
      unit_price_cents: product.price_cents,
      subtotal_cents: product.price_cents * qty,
    });
  }
  return { hasItems, items };
}

async function create(companyId, actorId, data) {
  const storeId = await assertStoreInCompany(companyId, data.store_id);
  const sellerId = await assertSellerInCompany(companyId, data.seller_id);
  const customerId = data.customer_id ? await assertCustomerInCompany(companyId, data.customer_id) : null;
  const customerName = String(data.customer_name || '').trim();
  if (!customerName) throw badRequest('Nome do cliente é obrigatório.');
  if (customerName.length > 120) throw badRequest('Nome do cliente muito longo.');
  const soldAt = parseSoldAt(data.sold_at);
  const note = data.note ? String(data.note).trim().slice(0, 500) : null;

  const { hasItems, items } = await resolveItems(companyId, data);
  // Total: backend calcula (itens) ou valor legado informado
  const totalCents = hasItems
    ? items.reduce((acc, it) => acc + it.subtotal_cents, 0)
    : parseAmountCents(data.amount);

  // POLÍTICA LEGADO (v1.9): venda com product_id e amount → o item registra o
  // PREÇO PRATICADO (amount) como unit_price — nunca divergência entre
  // sales.amount_cents e sale_items.subtotal_cents sem justificativa.
  if (!hasItems && items.length) {
    items[0].unit_price_cents = totalCents;
    items[0].subtotal_cents = totalCents;
  }

  const stockActive = await isModuleActive(companyId, 'stock');
  // Pré-checagem de estoque com mensagem clara (a transação revalida de forma atômica)
  if (items.length && stockActive) {
    for (const it of items) {
      const available = await stock.currentBalance(companyId, storeId, it.product.id);
      if (available < it.quantity) {
        const e = conflict(`Estoque insuficiente para "${it.product.name}" na loja selecionada (disponível ${available}, solicitado ${it.quantity}).`);
        e.code = 'INSUFFICIENT_STOCK';
        throw e;
      }
    }
  }

  const stockWasApplied = items.length > 0 && stockActive;

  // Guard-first (padrão D1-ready): INSERT da venda primeiro (id de referência),
  // itens com snapshot histórico, baixa de estoque por applyMovement. A
  // invariante do saldo fica no SQL do UPDATE condicional (INSUFFICIENT_STOCK
  // lança antes de persistir movimentação parcial). Inserts de venda/itens
  // precedem a baixa — mesma ordem semântica da transação original.
  const legacyProduct = !hasItems && items.length ? items[0] : null;
  const id = (await db.prepare(
    `INSERT INTO sales (company_id, store_id, seller_id, customer_id, customer_name,
                        product_id, product_name, product_price_cents,
                        amount_cents, sold_at, note, created_by, stock_was_applied)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    companyId, storeId, sellerId, customerId, customerName,
    legacyProduct ? legacyProduct.product.id : null,
    legacyProduct ? legacyProduct.product.name : null,
    legacyProduct ? legacyProduct.unit_price_cents : null,
    totalCents, soldAt, note, actorId,
    stockWasApplied ? 1 : 0
  )).lastInsertRowid;

  const insItem = db.prepare(
    `INSERT INTO sale_items (company_id, sale_id, product_id, product_name, product_sku, product_unit,
                             unit_price_cents, quantity, subtotal_cents)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const it of items) {
    await insItem.run(
      companyId, id, it.product.id, it.product.name, it.product.sku, it.product.unit,
      it.unit_price_cents, it.quantity, it.subtotal_cents
    );
  }
  if (stockWasApplied) {
    for (const it of items) {
      await stock.applyMovement(companyId, storeId, it.product.id, 'SALE', it.quantity, 'sale', id, actorId, null);
    }
  }
  return await getDetail(companyId, id);
}

// ---------------------------------------------------------------------------
// Edição e cancelamento
// ---------------------------------------------------------------------------

async function update(companyId, id, data) {
  const current = await getScoped(companyId, id);
  if (current.status !== 'active') throw conflict('Venda cancelada não pode ser alterada.');

  const itemCount = (await db.prepare('SELECT COUNT(*) AS c FROM sale_items WHERE sale_id = ? AND company_id = ?').get(id, companyId)).c;
  const touchesItems = data.items !== undefined || data.product_id !== undefined || data.amount !== undefined;
  if (itemCount > 0 && touchesItems) {
    throw conflict('Itens/valor de uma venda com produtos não podem ser alterados. Cancele e recrie a venda.');
  }

  // INTEGRIDADE FINANCEIRA (consolidação V3.0): venda com título a receber
  // vinculado não pode ter identidade financeira alterada (valor, cliente,
  // loja) — o título representa a venda. Não existe estorno nesta versão.
  const hasReceivable = await db.prepare('SELECT 1 AS x FROM accounts_receivable WHERE company_id = ? AND sale_id = ?').get(companyId, id);
  if (hasReceivable) {
    const financial = ['amount', 'customer_id', 'store_id'].filter((f) => data[f] !== undefined);
    if (financial.length) {
      throw conflict(`Esta venda possui um título a receber vinculado e não pode ter ${financial.join(', ')} alterados. Cancele e recrie a venda.`);
    }
  }

  // INVARIANTE CRÍTICO: venda que JÁ baixou estoque não pode mudar de loja —
  // o estorno ocorreria no local errado (estoque fantasma na nova loja,
  // saldo incorreto na original). Loja imutável quando stock_was_applied = 1.
  if (current.stock_was_applied === 1 && data.store_id !== undefined && data.store_id !== null) {
    const newStore = Number(data.store_id);
    if (newStore !== current.store_id) {
      const e = conflict('A loja de uma venda com baixa de estoque não pode ser alterada. Cancele e recrie a venda.');
      e.code = 'SALE_STORE_LOCKED';
      throw e;
    }
  }

  const storeId = data.store_id !== undefined ? await assertStoreInCompany(companyId, data.store_id) : undefined;
  const sellerId = data.seller_id !== undefined ? await assertSellerInCompany(companyId, data.seller_id) : undefined;
  const customerId = data.customer_id !== undefined
    ? (data.customer_id === null ? null : await assertCustomerInCompany(companyId, data.customer_id))
    : undefined;
  const customerName = data.customer_name !== undefined ? String(data.customer_name || '').trim() : undefined;
  if (customerName !== undefined && !customerName) throw badRequest('Nome do cliente é obrigatório.');
  const product = data.product_id !== undefined
    ? (data.product_id === null ? null : await assertProductForSale(companyId, data.product_id))
    : undefined;
  const amountCents = data.amount !== undefined ? parseAmountCents(data.amount) : undefined;
  const soldAt = data.sold_at !== undefined ? parseSoldAt(data.sold_at) : undefined;
  const note = data.note !== undefined ? (data.note ? String(data.note).trim().slice(0, 500) : null) : undefined;

  await db.prepare(
    `UPDATE sales SET
       store_id     = COALESCE(?, store_id),
       seller_id    = COALESCE(?, seller_id),
       customer_id  = CASE WHEN ? THEN ? ELSE customer_id END,
       customer_name = COALESCE(?, customer_name),
       product_id = CASE WHEN ? THEN ? ELSE product_id END,
       product_name = CASE WHEN ? THEN ? ELSE product_name END,
       product_price_cents = CASE WHEN ? THEN ? ELSE product_price_cents END,
       amount_cents = COALESCE(?, amount_cents),
       sold_at      = COALESCE(?, sold_at),
       note         = CASE WHEN ? THEN ? ELSE note END,
       updated_at   = datetime('now')
     WHERE id = ? AND company_id = ?`
  ).run(
    storeId ?? null, sellerId ?? null,
    customerId !== undefined ? 1 : 0, customerId ?? null,
    customerName ?? null,
    product !== undefined ? 1 : 0, product ? product.id : null,
    product !== undefined ? 1 : 0, product ? product.name : null,
    product !== undefined ? 1 : 0, product ? product.price_cents : null,
    amountCents ?? null,
    soldAt ?? null,
    note !== undefined ? 1 : 0, note ?? null,
    id, companyId
  );

  return await getDetail(companyId, id);
}

async function cancel(companyId, id, reason, actorId) {
  const current = await getScoped(companyId, id);
  if (current.status !== 'active') throw conflict('Venda já está cancelada.');
  const r = String(reason || '').trim();
  if (r.length < 3) throw badRequest('Informe o motivo do cancelamento.');

  const items = await db.prepare(
    'SELECT product_id, quantity FROM sale_items WHERE sale_id = ? AND company_id = ? AND product_id IS NOT NULL'
  ).all(id, companyId);
  // HARDENING v1.9: o estorno depende do que A VENDA realmente fez
  // (stock_was_applied gravado na criação) — NUNCA do estado atual do módulo.
  const mustReverse = current.stock_was_applied === 1 && items.length > 0;

  // INTEGRIDADE FINANCEIRA (consolidação V3.0): a consulta do título NÃO é
  // condicionada ao módulo estar ativo — o registro financeiro EXISTE e a
  // consistência dele deve ser preservada independentemente do gating (que
  // bloqueia apenas NOVAS operações do módulo). Título RECEBIDO bloqueia o
  // cancelamento ANTES de qualquer escrita; título OPEN é cancelado na MESMA
  // transação do estorno de estoque.
  const receivable = await db.prepare('SELECT id, status FROM accounts_receivable WHERE company_id = ? AND sale_id = ?').get(companyId, id);
  if (receivable && receivable.status === 'paid') {
    throw conflict('Esta venda possui um título a receber JÁ RECEBIDO. O cancelamento da venda não é permitido porque o estorno financeiro ainda não está disponível.');
  }

  // Guard-first (padrão D1-ready): UPDATE condicional da venda (idempotente
  // em retry — duplo cancelamento → 409 via changes === 0) ANTES do estorno
  // de estoque e do cancelamento financeiro. INTEGRIDADE: título recebido
  // bloqueia antes de qualquer escrita (verificado acima); título OPEN é
  // cancelado na sequência.
  // SALE_REVERSAL é ENTRADA de estoque (estorno) — sempre viável, mesmo
  // semântica da transação original. A invariante do saldo continua no SQL
  // do UPDATE condicional dentro de applyMovement.
  const info = await db.prepare(
    `UPDATE sales SET status = 'canceled', canceled_at = datetime('now'),
       canceled_by = ?, cancel_reason = ?, updated_at = datetime('now')
     WHERE id = ? AND company_id = ? AND status = 'active'`
  ).run(actorId, r.slice(0, 300), id, companyId);
  if (info.changes === 0) throw conflict('Venda já cancelada.');
  if (mustReverse) {
    for (const it of items) {
      await stock.applyMovement(companyId, current.store_id, it.product_id, 'SALE_REVERSAL', it.quantity, 'cancel', id, actorId, `Estorno: ${r.slice(0, 200)}`);
    }
  }
  // Título OPEN acompanha o cancelamento (condicional: sem efeito em retry)
  if (receivable && receivable.status === 'open') {
    await require('../receivables/service').cancelBySale(companyId, id, actorId);
  }

  return await getDetail(companyId, id);
}

// ---------------------------------------------------------------------------
// Dashboard (inalterado — usa amount_cents da venda)
// ---------------------------------------------------------------------------

async function monthSummary(companyId) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(amount_cents), 0) AS total_cents
     FROM sales WHERE company_id = ? AND status = 'active'
       AND strftime('%Y-%m', sold_at) = strftime('%Y-%m', 'now', 'localtime')`
  ).get(companyId);
  return { count: row.count, total_cents: row.total_cents };
}

module.exports = {
  list, getScoped, getDetail, create, update, cancel, monthSummary,
  parseAmountCents, parseSoldAt, assertCustomerInCompany, assertProductForSale,
};
