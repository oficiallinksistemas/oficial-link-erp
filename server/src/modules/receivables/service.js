'use strict';

/**
 * Contas a RECEBER (v3.0) — títulos financeiros a receber da empresa.
 *
 * Lições da consolidação do Contas a Pagar aplicadas na concepção:
 * - OVERDUE derivado pela data de NEGÓCIO da empresa (core/businessDate —
 *   NENHUM default empresarial em UTC);
 * - recebimento: UPDATE condicional (status='open') em transação —
 *   concorrência real protegida (dois receives simultâneos = um 200, um 409);
 *   integral nesta etapa (received_amount_cents = amount_cents);
 * - origem 'sale' com UNIQUE(company_id, sale_id) — uma venda gera no
 *   máximo um título (constraint, não if);
 * - cancelamento de VENDA integrado: título OPEN acompanha na MESMA
 *   transação; título PAID BLOQUEIA o cancelamento da venda antes de
 *   qualquer escrita (sem estorno financeiro nesta etapa);
 * - delete físico SOMENTE manual + open (permissão própria receivables.delete).
 */

const db = require('../../database/connection');
const { badRequest, notFound, conflict } = require('../../core/errors');
const { parseAmountCents } = require('../sales/service');
const { businessToday, businessMonthStart, formatInTz, companyTimezone, addDays } = require('../../core/businessDate');

function parseDate(value, field, required = true) {
  if (!required && (value === undefined || value === null || value === '')) return null;
  const s = String(value || '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw badRequest(`${field} inválida. Use AAAA-MM-DD.`);
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d));
  if (date.getUTCFullYear() !== +y || date.getUTCMonth() !== +mo - 1 || date.getUTCDate() !== +d) {
    throw badRequest(`${field} inexistente.`);
  }
  return s;
}

async function assertCustomer(companyId, id) {
  const c = await db.prepare('SELECT id FROM customers WHERE id = ? AND company_id = ?').get(id, companyId);
  if (!c) throw badRequest('Cliente inválido para esta empresa.');
  return c.id;
}

async function assertStore(companyId, id) {
  const s = await db.prepare('SELECT id FROM stores WHERE id = ? AND company_id = ?').get(id, companyId);
  if (!s) throw badRequest('Loja inválida para esta empresa.');
  return s.id;
}

/** Venda válida para vínculo: mesma empresa, não cancelada. Retorna a venda. */
async function assertSale(companyId, id) {
  const s = await db.prepare('SELECT id, status, amount_cents, store_id, customer_id, customer_name FROM sales WHERE id = ? AND company_id = ?').get(id, companyId);
  if (!s) throw notFound('Venda não encontrada.');
  if (s.status !== 'active') throw conflict('Venda cancelada não pode receber novo título.');
  return s;
}

const SQL = `
  SELECT ar.*, c.name AS customer_name, st.name AS store_name, s2.customer_name AS sale_customer
  FROM accounts_receivable ar
  LEFT JOIN customers c ON c.id = ar.customer_id
  LEFT JOIN stores st ON st.id = ar.store_id
  LEFT JOIN sales s2 ON s2.id = ar.sale_id
`;

function effectiveStatus(row, today) {
  if (row.status !== 'open') return row.status;
  return row.due_date < today ? 'overdue' : 'open';
}

async function getScoped(companyId, id) {
  const t = await db.prepare(`${SQL} WHERE ar.id = ? AND ar.company_id = ?`).get(id, companyId);
  if (!t) throw notFound('Título não encontrado.');
  return { ...t, effective_status: effectiveStatus(t, await businessToday(companyId)) };
}

async function list(companyId, { page, perPage, offset, status, customer_id, store_id, sale_id, due_from, due_to, search }) {
  const today = await businessToday(companyId);
  let where = ' WHERE ar.company_id = ?';
  const params = [companyId];
  if (status === 'open' || status === 'paid' || status === 'canceled') {
    where += ' AND ar.status = ?'; params.push(status);
  } else if (status === 'overdue') {
    where += ' AND ar.status = ? AND ar.due_date < ?'; params.push('open', today);
  }
  if (customer_id) { where += ' AND ar.customer_id = ?'; params.push(await assertCustomer(companyId, customer_id)); }
  if (store_id) { where += ' AND ar.store_id = ?'; params.push(await assertStore(companyId, store_id)); }
  if (sale_id) {
    const sid = await assertSale(companyId, sale_id);
    where += ' AND ar.sale_id = ?'; params.push(sid.id);
  }
  if (due_from) { where += ' AND ar.due_date >= ?'; params.push(parseDate(due_from, 'Vencimento inicial')); }
  if (due_to) { where += ' AND ar.due_date <= ?'; params.push(parseDate(due_to, 'Vencimento final')); }
  if (search) {
    const term = `%${String(search).slice(0, 80)}%`;
    where += ' AND (ar.description LIKE ? OR ar.notes LIKE ?)';
    params.push(term, term);
  }
  const total = (await db.prepare(`SELECT COUNT(*) AS c FROM accounts_receivable ar${where}`).get(...params)).c;
  const items = (await db.prepare(`${SQL}${where} ORDER BY ar.due_date ASC, ar.id ASC LIMIT ? OFFSET ?`)
    .all(...params, perPage, offset))
    .map((r) => ({ ...r, effective_status: effectiveStatus(r, today) }));
  return { items, total, page, perPage };
}

/** Resumo por natureza + "recebido no mês" pela data local da empresa. */
async function summary(companyId) {
  const today = await businessToday(companyId);
  const monthStart = await businessMonthStart(companyId);
  const in7 = addDays(today, 7);
  const row = await db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN status='open' AND due_date >=  ? THEN amount_cents END),0) AS open_cents,
       COUNT(CASE WHEN status='open' AND due_date >=  ? THEN 1 END) AS open_count,
       COALESCE(SUM(CASE WHEN status='open' AND due_date <   ? THEN amount_cents END),0) AS overdue_cents,
       COUNT(CASE WHEN status='open' AND due_date <   ? THEN 1 END) AS overdue_count,
       COALESCE(SUM(CASE WHEN status='open' AND due_date =  ? THEN amount_cents END),0) AS due_today_cents,
       COALESCE(SUM(CASE WHEN status='open' AND due_date >  ? AND due_date <= ? THEN amount_cents END),0) AS due_7d_cents,
       0 AS received_month_cents,
       COUNT(CASE WHEN status='canceled' THEN 1 END) AS canceled_count
     FROM accounts_receivable WHERE company_id = ?`
  ).get(today, today, today, today, today, today, in7, companyId);

  let receivedMonth = 0;
  try {
    const tz = await companyTimezone(companyId);
    const rows = await db.prepare(
      `SELECT amount_cents, received_at FROM accounts_receivable
       WHERE company_id = ? AND status = 'paid' AND received_at >= ?`
    ).all(companyId, `${addDays(monthStart, -1)} 00:00:00`);
    for (const r of rows) {
      const localDate = formatInTz(new Date(`${String(r.received_at).replace(' ', 'T')}Z`), tz);
      if (localDate >= monthStart) receivedMonth += r.amount_cents;
    }
  } catch { /* mantém 0 */ }
  return { ...row, received_month_cents: receivedMonth, business_today: today };
}

async function create(companyId, actorId, data) {
  const descriptionRaw = String(data.description || '').trim();
  const issueDate = parseDate(data.issue_date, 'Data de emissão', false) || await businessToday(companyId);
  const dueDate = parseDate(data.due_date, 'Vencimento');
  const notes = data.notes ? String(data.notes).slice(0, 500) : null;

  // ORIGEM SALE — INTEGRIDADE FINANCEIRA (consolidação V3.0): valor, loja e
  // cliente são DERIVADOS da venda. Payload divergente é REJEITADO (contrato
  // explícito) — o frontend nunca autoriza o que a venda não é.
  let sale = null;
  let amountCents;
  let customerId = null;
  let storeId = null;
  let description = descriptionRaw;

  if (data.sale_id) {
    sale = await assertSale(companyId, Number(data.sale_id));
    amountCents = sale.amount_cents;
    if (data.amount !== undefined && data.amount !== null && String(data.amount).trim() !== '') {
      const sent = parseAmountCents(data.amount, 'Valor');
      if (sent !== sale.amount_cents) {
        throw badRequest(`O valor do título de venda deve ser ${(sale.amount_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} (valor da venda #${sale.id}).`);
      }
    }
    storeId = sale.store_id;
    if (data.store_id !== undefined && data.store_id !== null && Number(data.store_id) !== sale.store_id) {
      throw badRequest('Título de venda deve usar a loja da venda.');
    }
    customerId = sale.customer_id;
    if (sale.customer_id && data.customer_id !== undefined && data.customer_id !== null && Number(data.customer_id) !== sale.customer_id) {
      throw badRequest('Título de venda deve usar o cliente da venda.');
    }
    if (!descriptionRaw) description = `Venda #${sale.id} — ${sale.customer_name || 'cliente'}`;
  } else {
    if (descriptionRaw.length < 2 || descriptionRaw.length > 200) throw badRequest('Descrição inválida (2 a 200).');
    amountCents = parseAmountCents(data.amount, 'Valor');
    customerId = data.customer_id ? await assertCustomer(companyId, Number(data.customer_id)) : null;
    storeId = data.store_id ? await assertStore(companyId, Number(data.store_id)) : null;
  }
  if (description.length < 2 || description.length > 200) throw badRequest('Descrição inválida (2 a 200).');
  const origin = sale ? 'sale' : 'manual';
  const saleId = sale ? sale.id : null;

  let id;
  try {
    id = (await db.prepare(
      `INSERT INTO accounts_receivable (company_id, store_id, customer_id, sale_id, origin,
         description, issue_date, due_date, amount_cents, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(companyId, storeId, customerId, saleId, origin, description, issueDate, dueDate, amountCents, notes, actorId)).lastInsertRowid;
  } catch (err) {
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
      throw conflict('Esta venda já possui um título a receber vinculado.');
    }
    throw err;
  }
  return await getScoped(companyId, id);
}

async function update(companyId, id, actorId, data) {
  const current = await getScoped(companyId, id);
  if (current.status !== 'open') throw conflict('Somente títulos em aberto podem ser editados.');
  if (current.origin === 'sale') {
    // Identidade financeira IMUTÁVEL: venda, valor, cliente e loja são da
    // venda. Apenas descrição/datas/observações podem ser ajustadas.
    const blocked = ['amount', 'sale_id', 'customer_id', 'store_id', 'origin', 'status', 'received_amount_cents'];
    const attempted = blocked.filter((f) => data[f] !== undefined);
    if (attempted.length) {
      throw conflict(`Título de venda não permite alterar: ${attempted.join(', ')}. Cancele a venda para corrigir a origem.`);
    }
  }
  const description = data.description !== undefined ? String(data.description || '').trim() : undefined;
  if (description !== undefined && (description.length < 2 || description.length > 200)) throw badRequest('Descrição inválida.');
  const amountCents = data.amount !== undefined ? parseAmountCents(data.amount, 'Valor') : undefined;
  const dueDate = data.due_date !== undefined ? parseDate(data.due_date, 'Vencimento') : undefined;
  const issueDate = data.issue_date !== undefined ? parseDate(data.issue_date, 'Data de emissão', false) : undefined;
  const customerId = data.customer_id !== undefined ? (data.customer_id === null ? null : await assertCustomer(companyId, Number(data.customer_id))) : undefined;
  const storeId = data.store_id !== undefined ? (data.store_id === null ? null : await assertStore(companyId, Number(data.store_id))) : undefined;

  await db.prepare(
    `UPDATE accounts_receivable SET
       description = COALESCE(?, description), amount_cents = COALESCE(?, amount_cents),
       issue_date = COALESCE(?, issue_date), due_date = COALESCE(?, due_date),
       customer_id = CASE WHEN ? THEN ? ELSE customer_id END,
       store_id = CASE WHEN ? THEN ? ELSE store_id END,
       notes = CASE WHEN ? THEN ? ELSE notes END,
       updated_by = ?, updated_at = datetime('now')
     WHERE id = ? AND company_id = ?`
  ).run(
    description ?? null, amountCents ?? null, issueDate ?? null, dueDate ?? null,
    customerId !== undefined ? 1 : 0, customerId ?? null,
    storeId !== undefined ? 1 : 0, storeId ?? null,
    data.notes !== undefined ? 1 : 0, data.notes ? String(data.notes).slice(0, 500) : null,
    actorId, id, companyId
  );
  return await getScoped(companyId, id);
}

/** Recebimento: condicional e transacional — sem duplicidade sob concorrência. */
async function receive(companyId, id, actorId) {
  const current = await getScoped(companyId, id);
  if (current.status === 'canceled') throw conflict('Título cancelado não pode ser recebido.');
  // UPDATE condicional único — atômico por si só (tx desnecessária).
  // Idempotente em retry: duplo recebimento → 409 via changes === 0.
  const info = await db.prepare(
    `UPDATE accounts_receivable SET status = 'paid', received_at = datetime('now'),
       received_amount_cents = amount_cents, received_by = ?, updated_by = ?, updated_at = datetime('now')
     WHERE id = ? AND company_id = ? AND status = 'open'`
  ).run(actorId, actorId, id, companyId);
  if (info.changes === 0) throw conflict('Título já está recebido.');
  return await getScoped(companyId, id);
}

async function cancel(companyId, id, actorId) {
  const current = await getScoped(companyId, id);
  if (current.origin === 'sale') {
    throw conflict('Título de venda só pode ser cancelado pelo cancelamento da própria venda.');
  }
  if (current.status === 'paid') throw conflict('Título recebido não pode ser cancelado sem estorno financeiro (fora do escopo desta etapa).');
  if (current.status === 'canceled') throw conflict('Título já cancelado.');
  await db.prepare(
    `UPDATE accounts_receivable SET status = 'canceled', canceled_at = datetime('now'),
       updated_by = ?, updated_at = datetime('now')
     WHERE id = ? AND company_id = ? AND status = 'open'`
  ).run(actorId, id, companyId);
  return await getScoped(companyId, id);
}

/** Delete físico SOMENTE manual em aberto (permissão própria). */
async function remove(companyId, id) {
  const t = await getScoped(companyId, id);
  if (t.origin === 'sale') throw conflict('Títulos originados de venda não podem ser excluídos. Cancele para preservar a integridade financeira.');
  if (t.status !== 'open') throw conflict('Somente títulos em aberto podem ser excluídos.');
  await db.prepare(`DELETE FROM accounts_receivable WHERE id = ? AND company_id = ? AND status = 'open'`).run(id, companyId);
  return t;
}

/** Cancelamento automático por cancelamento de venda (chamado DENTRO da
 *  transação do cancelamento da venda, após a reversão de estoque). */
async function cancelBySale(companyId, saleId, actorId) {
  await db.prepare(
    `UPDATE accounts_receivable SET status = 'canceled', canceled_at = datetime('now'),
       updated_by = ?, updated_at = datetime('now')
     WHERE company_id = ? AND sale_id = ? AND status = 'open'`
  ).run(actorId, companyId, saleId);
}

module.exports = { list, summary, getScoped, create, update, receive, cancel, remove, cancelBySale, effectiveStatus };
