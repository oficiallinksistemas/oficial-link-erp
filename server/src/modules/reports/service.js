'use strict';

/**
 * Relatórios operacionais (v1.9) — agregações SQL (sem N+1), sempre com
 * company_id do tenant, períodos validados, paginação nos detalhados.
 */

const db = require('../../database/connection');
const { badRequest } = require('../../core/errors');
const { businessToday } = require('../../core/businessDate');

function parsePeriod(query) {
  const valid = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
  const from = query.from ? String(query.from).slice(0, 10) : null;
  const to = query.to ? String(query.to).slice(0, 10) : null;
  if (from && !valid(from)) throw badRequest('Data inicial inválida.');
  if (to && !valid(to)) throw badRequest('Data final inválida.');
  if (from && to && to < from) throw badRequest('Período inválido.');
  return { from, to };
}

function scopeFilters(alias, { from, to, store_id, seller_id, status }) {
  let where = ` WHERE ${alias}.company_id = ?`;
  const params = [];
  if (from) { where += ` AND date(${alias}.sold_at) >= date(?)`; params.push(from); }
  if (to) { where += ` AND date(${alias}.sold_at) <= date(?)`; params.push(to); }
  if (store_id) { where += ` AND ${alias}.store_id = ?`; params.push(store_id); }
  if (seller_id) { where += ` AND ${alias}.seller_id = ?`; params.push(seller_id); }
  if (status && ['active', 'canceled'].includes(status)) { where += ` AND ${alias}.status = ?`; params.push(status); }
  return { where, params };
}

/** Relatório de vendas: POR PADRÃO somente vendas ATIVAS (faturamento não
 * mistura canceladas). Filtros explícitos: status=active|canceled|all. */
async function sales(companyId, q) {
  const { from, to } = parsePeriod(q);
  const statusParam = q.status === 'canceled' ? 'canceled' : q.status === 'all' ? null : 'active';
  const { where, params } = scopeFilters('s', { from, to, store_id: q.store_id, seller_id: q.seller_id, status: statusParam });
  const all = [companyId, ...params];
  const totals = await db.prepare(
    `SELECT COUNT(*) AS sales_count, COALESCE(SUM(amount_cents), 0) AS total_cents
     FROM sales s${where}`
  ).get(...all);
  const itemsSold = await db.prepare(
    `SELECT COALESCE(SUM(si.quantity), 0) AS qty FROM sale_items si JOIN sales s ON s.id = si.sale_id${where}`
  ).get(...all);
  // Canceladas sempre visíveis como indicador separado (período/filtros).
  const canceledWhere = scopeFilters('s', { from, to, store_id: q.store_id, seller_id: q.seller_id, status: 'canceled' });
  const canceled = await db.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(amount_cents), 0) AS total_cents FROM sales s${canceledWhere.where}`
  ).get(companyId, ...canceledWhere.params);
  return {
    summary: {
      sales_count: totals.sales_count,
      total_cents: totals.total_cents,
      avg_ticket_cents: totals.sales_count ? Math.round(totals.total_cents / totals.sales_count) : 0,
      products_sold: itemsSold.qty,
      canceled_count: canceled.count,
      canceled_cents: canceled.total_cents,
      status_filter: statusParam || 'all',
    },
  };
}

/** Vendas por produto (giro): quantidade e faturamento por item vendido. */
async function byProduct(companyId, q) {
  const { from, to } = parsePeriod(q);
  const { where, params } = scopeFilters('s', { from, to, store_id: q.store_id, seller_id: null, status: 'active' });
  const productFilter = q.product_id ? ' AND si.product_id = ?' : '';
  const all = [companyId, ...params];
  const rows = await db.prepare(
    `SELECT si.product_id, si.product_name, si.product_sku, si.product_unit,
            SUM(si.quantity) AS quantity, SUM(si.subtotal_cents) AS total_cents
     FROM sale_items si JOIN sales s ON s.id = si.sale_id
     ${where.replace('s.seller_id = ? AND ', '').replace(' AND s.seller_id = ?', '')}${productFilter}
     GROUP BY si.product_id, si.product_name
     ORDER BY quantity DESC, total_cents DESC LIMIT 100`
  ).all(...all, ...(q.product_id ? [Number(q.product_id)] : []));
  return { items: rows };
}

/** Estoque atual (reutiliza o serviço de estoque — agregado ou por loja). */
async function stock(companyId, q) {
  const svc = require('../stock/service');
  const data = await svc.listBalances(companyId, {
    page: 1, perPage: 100, offset: 0,
    store_id: q.store_id ? Number(q.store_id) : undefined,
    search: q.search ? String(q.search).slice(0, 80) : undefined,
    low: q.low === '1' ? '1' : undefined,
    zero: q.zero === '1' ? '1' : undefined,
  });
  return { items: data.items, summary: await svc.summary(companyId, q.store_id ? Number(q.store_id) : null) };
}

/** Movimentações (delega ao serviço de estoque, com os mesmos filtros). */
async function movements(companyId, q) {
  const svc = require('../stock/service');
  return await svc.listMovements(companyId, {
    page: Number(q.page) || 1, perPage: Math.min(50, Number(q.per_page) || 20), offset: 0,
    store_id: q.store_id ? Number(q.store_id) : undefined,
    product_id: q.product_id ? Number(q.product_id) : undefined,
    type: q.type ? String(q.type).slice(0, 20).toUpperCase() : undefined,
    from: q.from ? String(q.from).slice(0, 10) : undefined,
    to: q.to ? String(q.to).slice(0, 10) : undefined,
  });
}

/** Compras: POR PADRÃO o total efetivo somente RECEBIDAS (draft e canceladas
 * entram como indicadores separados). Filtro explícito: status=draft|
 * received|canceled|all. */
async function purchases(companyId, q) {
  const { from, to } = parsePeriod({ from: q.from, to: q.to });
  const base = () => {
    let where = ' WHERE pc.company_id = ?';
    const params = [companyId];
    if (from) { where += ' AND date(pc.purchase_date) >= date(?)'; params.push(from); }
    if (to) { where += ' AND date(pc.purchase_date) <= date(?)'; params.push(to); }
    if (q.store_id) { where += ' AND pc.store_id = ?'; params.push(Number(q.store_id)); }
    return { where, params };
  };
  const status = q.status && ['draft', 'received', 'canceled', 'all'].includes(q.status) ? q.status : null;

  const { where, params } = base();
  const effectiveStatus = status === 'all' ? null : status || 'received';
  const effWhere = effectiveStatus ? where + ' AND pc.status = ?' : where;
  const effParams = effectiveStatus ? [...params, effectiveStatus] : params;
  const totals = await db.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(total_cents), 0) AS total_cents FROM purchases pc${effWhere}`
  ).get(...effParams);

  const drafts = await db.prepare(`SELECT COUNT(*) AS count FROM purchases pc${where + ' AND pc.status = ?'}`).get(...params, 'draft');
  const canceled = await db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(total_cents), 0) AS total_cents FROM purchases pc${where + ' AND pc.status = ?'}`).get(...params, 'canceled');

  const bySupplier = await db.prepare(
    `SELECT s.name AS supplier_name, COUNT(*) AS purchases_count, COALESCE(SUM(pc.total_cents), 0) AS total_cents
     FROM purchases pc JOIN suppliers s ON s.id = pc.supplier_id ${effWhere}
     GROUP BY s.id ORDER BY total_cents DESC LIMIT 50`
  ).all(...effParams);
  return {
    summary: {
      purchases_count: totals.count,
      total_cents: totals.total_cents,
      drafts_count: drafts.count,
      canceled_count: canceled.count,
      canceled_cents: canceled.total_cents,
      status_filter: effectiveStatus || 'all',
    },
    by_supplier: bySupplier,
  };
}

/** Contas a pagar: totais por natureza (nunca misturados). OVERDUE derivado
 *  pela data de NEGÓCIO da empresa (businessToday) — nunca date('now') UTC.
 *  Mesmo padrão de receivables() abaixo. */
async function payables(companyId, q) {
  const { from, to } = parsePeriod({ from: q.from, to: q.to });
  const today = await businessToday(companyId);
  let where = ' WHERE ap.company_id = ?';
  const params = [companyId];
  if (from) { where += ' AND ap.due_date >= date(?)'; params.push(from); }
  if (to) { where += ' AND ap.due_date <= date(?)'; params.push(to); }
  if (q.supplier_id) { where += ' AND ap.supplier_id = ?'; params.push(Number(q.supplier_id)); }
  if (q.store_id) { where += ' AND ap.store_id = ?'; params.push(Number(q.store_id)); }
  const row = await db.prepare(
    `SELECT
       COUNT(*) AS total_count,
       COALESCE(SUM(CASE WHEN ap.status='open' AND ap.due_date >= ? THEN ap.amount_cents END),0) AS open_cents,
       COUNT(CASE WHEN ap.status='open' AND ap.due_date >= ? THEN 1 END) AS open_count,
       COALESCE(SUM(CASE WHEN ap.status='open' AND ap.due_date <  ? THEN ap.amount_cents END),0) AS overdue_cents,
       COUNT(CASE WHEN ap.status='open' AND ap.due_date <  ? THEN 1 END) AS overdue_count,
       COALESCE(SUM(CASE WHEN ap.status='paid'  THEN ap.amount_cents END),0) AS paid_cents,
       COUNT(CASE WHEN ap.status='paid' THEN 1 END) AS paid_count,
       COUNT(CASE WHEN ap.status='canceled' THEN 1 END) AS canceled_count
     FROM accounts_payable ap${where}`
  ).get(today, today, today, today, ...params);
  // por fornecedor (apenas títulos com fornecedor, ordenados por em aberto+vencido)
  const bySupplier = await db.prepare(
    `SELECT s.name AS supplier_name,
       COUNT(*) AS titles_count,
       COALESCE(SUM(CASE WHEN ap.status='open' AND ap.due_date >= ? THEN ap.amount_cents END),0) AS open_cents,
       COALESCE(SUM(CASE WHEN ap.status='open' AND ap.due_date <  ? THEN ap.amount_cents END),0) AS overdue_cents,
       COALESCE(SUM(CASE WHEN ap.status='paid' THEN ap.amount_cents END),0) AS paid_cents
     FROM accounts_payable ap JOIN suppliers s ON s.id = ap.supplier_id ${where}
     GROUP BY s.id ORDER BY (open_cents + overdue_cents) DESC LIMIT 50`
  ).all(today, today, ...params);
  return { summary: row, by_supplier: bySupplier };
}

/** Contas a receber: totais por natureza (separados) + por cliente e loja.
 *  Filtro de período por vencimento (padrão), emissão ou RECEBIMENTO —
 *  este último SEMPRE pela data local da empresa (nunca date(UTC)). */
async function receivables(companyId, q) {
  const { businessToday, formatInTz, companyTimezone, addDays } = require('../../core/businessDate');
  const today = await businessToday(companyId);
  const from = q.from ? String(q.from).slice(0, 10) : null;
  const to = q.to ? String(q.to).slice(0, 10) : null;
  const byReceived = q.date_field === 'received';

  let where = ' WHERE ar.company_id = ?';
  const params = [companyId];
  if (!byReceived) {
    const dateField = q.date_field === 'issue' ? 'ar.issue_date' : 'ar.due_date';
    if (from) { where += ` AND ${dateField} >= ?`; params.push(from); }
    if (to) { where += ` AND ${dateField} <= ?`; params.push(to); }
  } else {
    // janela UTC ampliada (±1 dia); o filtro final pela data LOCAL é
    // aplicado em JS — date(received_at) em UTC classificaria a virada do
    // dia no dia errado para o fuso da empresa.
    if (from) { where += ' AND ar.received_at >= ?'; params.push(`${addDays(from, -1)} 00:00:00`); }
    if (to) { where += ' AND ar.received_at <= ?'; params.push(`${addDays(to, 1)} 23:59:59`); }
  }
  if (q.customer_id) { where += ' AND ar.customer_id = ?'; params.push(Number(q.customer_id)); }
  if (q.store_id) { where += ' AND ar.store_id = ?'; params.push(Number(q.store_id)); }

  const nature = (r) => (r.status === 'open' ? (r.due_date < today ? 'overdue' : 'open') : r.status);

  if (byReceived && (from || to)) {
    // Agregação em JS com data de recebimento LOCAL (mesma regra do summary).
    const tz = await companyTimezone(companyId);
    const rows = await db.prepare(
      `SELECT ar.amount_cents, ar.status, ar.due_date, ar.received_at,
              ar.customer_id, c.name AS customer_name, ar.store_id, st.name AS store_name
       FROM accounts_receivable ar
       LEFT JOIN customers c ON c.id = ar.customer_id
       LEFT JOIN stores st ON st.id = ar.store_id
       ${where.replace("ar.status = 'open' AND ", '')}`
    ).all(...params);
    const summary = { total_count: 0, open_cents: 0, open_count: 0, overdue_cents: 0, overdue_count: 0, received_cents: 0, received_count: 0, canceled_count: 0 };
    const cust = new Map(); const store = new Map();
    for (const r of rows) {
      const local = r.received_at ? formatInTz(new Date(`${String(r.received_at).replace(' ', 'T')}Z`), tz) : null;
      if (from && (!local || local < from)) continue;
      if (to && (!local || local > to)) continue;
      if (r.status !== 'paid') continue; // período de RECEBIMENTO só conta recebidos
      summary.total_count += 1; summary.received_count += 1; summary.received_cents += r.amount_cents;
      if (r.customer_id) {
        const e = cust.get(r.customer_id) || { customer_name: r.customer_name || '—', titles_count: 0, received_cents: 0, open_cents: 0, overdue_cents: 0 };
        e.titles_count += 1; e.received_cents += r.amount_cents; cust.set(r.customer_id, e);
      }
      if (r.store_id) {
        const e = store.get(r.store_id) || { store_name: r.store_name || '—', titles_count: 0, received_cents: 0, open_cents: 0, overdue_cents: 0 };
        e.titles_count += 1; e.received_cents += r.amount_cents; store.set(r.store_id, e);
      }
    }
    return { summary, by_customer: [...cust.values()], by_store: [...store.values()] };
  }

  const row = await db.prepare(
    `SELECT
       COUNT(*) AS total_count,
       COALESCE(SUM(CASE WHEN ar.status='open' AND ar.due_date >= ? THEN ar.amount_cents END),0) AS open_cents,
       COUNT(CASE WHEN ar.status='open' AND ar.due_date >= ? THEN 1 END) AS open_count,
       COALESCE(SUM(CASE WHEN ar.status='open' AND ar.due_date <  ? THEN ar.amount_cents END),0) AS overdue_cents,
       COUNT(CASE WHEN ar.status='open' AND ar.due_date <  ? THEN 1 END) AS overdue_count,
       COALESCE(SUM(CASE WHEN ar.status='paid' THEN ar.amount_cents END),0) AS received_cents,
       COUNT(CASE WHEN ar.status='paid' THEN 1 END) AS received_count,
       COUNT(CASE WHEN ar.status='canceled' THEN 1 END) AS canceled_count
     FROM accounts_receivable ar${where}`
  ).get(today, today, today, today, ...params);

  const byCustomer = await db.prepare(
    `SELECT c.name AS customer_name,
       COUNT(*) AS titles_count,
       COALESCE(SUM(CASE WHEN ar.status='open' AND ar.due_date >= ? THEN ar.amount_cents END),0) AS open_cents,
       COALESCE(SUM(CASE WHEN ar.status='open' AND ar.due_date <  ? THEN ar.amount_cents END),0) AS overdue_cents,
       COALESCE(SUM(CASE WHEN ar.status='paid' THEN ar.amount_cents END),0) AS received_cents
     FROM accounts_receivable ar JOIN customers c ON c.id = ar.customer_id ${where}
     GROUP BY c.id ORDER BY (open_cents + overdue_cents) DESC LIMIT 50`
  ).all(today, today, ...params);

  const byStore = await db.prepare(
    `SELECT st.name AS store_name,
       COUNT(*) AS titles_count,
       COALESCE(SUM(CASE WHEN ar.status='open' AND ar.due_date >= ? THEN ar.amount_cents END),0) AS open_cents,
       COALESCE(SUM(CASE WHEN ar.status='open' AND ar.due_date <  ? THEN ar.amount_cents END),0) AS overdue_cents,
       COALESCE(SUM(CASE WHEN ar.status='paid' THEN ar.amount_cents END),0) AS received_cents
     FROM accounts_receivable ar JOIN stores st ON st.id = ar.store_id ${where}
     GROUP BY st.id ORDER BY (open_cents + overdue_cents) DESC LIMIT 50`
  ).all(today, today, ...params);

  return { summary: row, by_customer: byCustomer, by_store: byStore };
}

module.exports = { sales, byProduct, stock, movements, purchases, payables, receivables };
