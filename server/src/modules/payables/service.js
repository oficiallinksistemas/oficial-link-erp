'use strict';

/**
 * Contas a Pagar (v2.0) — títulos financeiros da empresa.
 *
 * - OVERDUE é DERIVADO (open + due_date < hoje) — nunca persistido.
 * - Pagamento: UPDATE condicional (status='open') dentro de transação —
 *   concorrência real protegida pelo SQLite (duas chamadas simultâneas =
 *   uma vence, outra recebe 409). Sem pagamento parcial nesta etapa:
 *   paid_amount_cents = amount_cents.
 * - Origem 'purchase' com UNIQUE(company_id, purchase_id) — uma compra gera
 *   no máximo um título (idempotência por constraint, dentro da transação
 *   do recebimento). Módulo payables inativo → o recebimento da compra NÃO
 *   gera título (compra segue funcionando sozinha).
 * - Delete físico SOMENTE para título manual em aberto; demais casos: cancel.
 * - Não afeta estoque (financeiro ≠ físico).
 */

const db = require('../../database/connection');
const { badRequest, notFound, conflict } = require('../../core/errors');
const { businessToday, businessMonthStart } = require('../../core/businessDate');
const { parseAmountCents } = require('../sales/service');

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

async function assertSupplier(companyId, id) {
  const s = await db.prepare('SELECT id FROM suppliers WHERE id = ? AND company_id = ?').get(id, companyId);
  if (!s) throw badRequest('Fornecedor inválido para esta empresa.');
  return s.id;
}

async function assertStore(companyId, id) {
  const s = await db.prepare('SELECT id FROM stores WHERE id = ? AND company_id = ?').get(id, companyId);
  if (!s) throw badRequest('Loja inválida para esta empresa.');
  return s.id;
}

const SQL = `
  SELECT ap.*, s.name AS supplier_name, st.name AS store_name, pc.purchase_date AS purchase_date_ref
  FROM accounts_payable ap
  LEFT JOIN suppliers s ON s.id = ap.supplier_id
  LEFT JOIN stores st ON st.id = ap.store_id
  LEFT JOIN purchases pc ON pc.id = ap.purchase_id
`;

async function getScoped(companyId, id) {
  const t = await db.prepare(`${SQL} WHERE ap.id = ? AND ap.company_id = ?`).get(id, companyId);
  if (!t) throw notFound('Título não encontrado.');
  return { ...t, effective_status: effectiveStatus(t, await businessToday(companyId)) };
}

/**
 * Datas de negócio (businessToday/businessMonthStart) vêm de
 * core/businessDate — ÚNICA fonte de verdade do fuso empresarial
 * (timezone do cadastro da company; padrão America/Fortaleza). Nunca
 * UTC do servidor. Timezone inválido → erro explícito (nunca fallback
 * silencioso para UTC), igual ao módulo de Recebíveis.
 */

/** Status efetivo com OVERDUE derivado pela data de negócio da empresa. */
function effectiveStatus(row, today) {
  if (row.status !== 'open') return row.status;
  return row.due_date < today ? 'overdue' : 'open';
}

async function list(companyId, { page, perPage, offset, status, supplier_id, store_id, purchase_id, due_from, due_to, search }) {
  const today = await businessToday(companyId);
  let where = ' WHERE ap.company_id = ?';
  const params = [companyId];
  if (status === 'open' || status === 'paid' || status === 'canceled') {
    where += ' AND ap.status = ?'; params.push(status);
  } else if (status === 'overdue') {
    where += ' AND ap.status = ? AND ap.due_date < ?'; params.push('open', today);
  }
  if (supplier_id) { where += ' AND ap.supplier_id = ?'; params.push(await assertSupplier(companyId, supplier_id)); }
  if (store_id) { where += ' AND ap.store_id = ?'; params.push(await assertStore(companyId, store_id)); }
  if (purchase_id) {
    const p = await db.prepare('SELECT id FROM purchases WHERE id = ? AND company_id = ?').get(purchase_id, companyId);
    if (!p) throw notFound('Compra não encontrada.');
    where += ' AND ap.purchase_id = ?'; params.push(p.id);
  }
  if (due_from) { where += ' AND ap.due_date >= ?'; params.push(parseDate(due_from, 'Vencimento inicial')); }
  if (due_to) { where += ' AND ap.due_date <= ?'; params.push(parseDate(due_to, 'Vencimento final')); }
  if (search) {
    const term = `%${String(search).slice(0, 80)}%`;
    where += ' AND (ap.description LIKE ? OR ap.document_number LIKE ? OR ap.reference LIKE ?)';
    params.push(term, term, term);
  }
  const total = (await db.prepare(`SELECT COUNT(*) AS c FROM accounts_payable ap${where}`).get(...params)).c;
  const items = (await db.prepare(`${SQL}${where} ORDER BY ap.due_date ASC, ap.id ASC LIMIT ? OFFSET ?`)
    .all(...params, perPage, offset))
    .map((r) => ({ ...r, effective_status: effectiveStatus(r, today) }));
  return { items, total, page, perPage };
}

/** Resumo operacional — totais separados por natureza, pela data de
 *  negócio da empresa (fuso do cadastro; "pago no mês" usa o mês local). */
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
       0 AS paid_month_cents,
       COUNT(CASE WHEN status='canceled' THEN 1 END) AS canceled_count
     FROM accounts_payable WHERE company_id = ?`
  ).get(today, today, today, today, today, today, in7, companyId);
  // "Pago no mês" pela data LOCAL da empresa (paid_at é UTC — converte com o
  // fuso do cadastro antes de comparar com o início do mês de negócio).
  let paidMonth = 0;
  try {
    const tz = companyTimezone(companyId);
    const rows = await db.prepare(
      `SELECT amount_cents, paid_at FROM accounts_payable
       WHERE company_id = ? AND status = 'paid' AND paid_at >= ?`
    ).all(companyId, `${addDays(monthStart, -1)} 00:00:00`);
    for (const r of rows) {
      const localDate = formatInTz(new Date(`${String(r.paid_at).replace(' ', 'T')}Z`), tz);
      if (localDate >= monthStart) paidMonth += r.amount_cents;
    }
  } catch { /* mantém 0 */ }
  return { ...row, paid_month_cents: paidMonth, business_today: today };
}

function addDays(yyyyMmDd, days) {
  const d = new Date(`${yyyyMmDd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function create(companyId, actorId, data) {
  const description = String(data.description || '').trim();
  if (description.length < 2 || description.length > 200) throw badRequest('Descrição inválida (2 a 200).');
  const amountCents = parseAmountCents(data.amount, 'Valor');
  const issueDate = parseDate(data.issue_date, 'Data de emissão', false) || new Date().toISOString().slice(0, 10);
  const dueDate = parseDate(data.due_date, 'Vencimento');
  const supplierId = data.supplier_id ? await assertSupplier(companyId, Number(data.supplier_id)) : null;
  const storeId = data.store_id ? await assertStore(companyId, Number(data.store_id)) : null;
  const document = data.document_number ? String(data.document_number).slice(0, 40) : null;
  const reference = data.reference ? String(data.reference).slice(0, 60) : null;
  const notes = data.notes ? String(data.notes).slice(0, 500) : null;

  const id = (await db.prepare(
    `INSERT INTO accounts_payable (company_id, store_id, supplier_id, origin_type, description,
       document_number, reference, amount_cents, issue_date, due_date, notes, created_by)
     VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(companyId, storeId, supplierId, description, document, reference, amountCents, issueDate, dueDate, notes, actorId)).lastInsertRowid;
  return await getScoped(companyId, id);
}

async function update(companyId, id, actorId, data) {
  const current = await getScoped(companyId, id);
  if (current.status !== 'open') throw conflict('Somente títulos em aberto podem ser editados.');
  const description = data.description !== undefined ? String(data.description || '').trim() : undefined;
  if (description !== undefined && (description.length < 2 || description.length > 200)) throw badRequest('Descrição inválida.');
  const amountCents = data.amount !== undefined ? parseAmountCents(data.amount, 'Valor') : undefined;
  const dueDate = data.due_date !== undefined ? parseDate(data.due_date, 'Vencimento') : undefined;
  const issueDate = data.issue_date !== undefined ? parseDate(data.issue_date, 'Data de emissão', false) : undefined;
  const supplierId = data.supplier_id !== undefined ? (data.supplier_id === null ? null : await assertSupplier(companyId, Number(data.supplier_id))) : undefined;
  const storeId = data.store_id !== undefined ? (data.store_id === null ? null : await assertStore(companyId, Number(data.store_id))) : undefined;

  await db.prepare(
    `UPDATE accounts_payable SET
       description = COALESCE(?, description), amount_cents = COALESCE(?, amount_cents),
       issue_date = COALESCE(?, issue_date), due_date = COALESCE(?, due_date),
       supplier_id = CASE WHEN ? THEN ? ELSE supplier_id END,
       store_id = CASE WHEN ? THEN ? ELSE store_id END,
       document_number = CASE WHEN ? THEN ? ELSE document_number END,
       reference = CASE WHEN ? THEN ? ELSE reference END,
       notes = CASE WHEN ? THEN ? ELSE notes END,
       updated_by = ?, updated_at = datetime('now')
     WHERE id = ? AND company_id = ?`
  ).run(
    description ?? null, amountCents ?? null, issueDate ?? null, dueDate ?? null,
    supplierId !== undefined ? 1 : 0, supplierId ?? null,
    storeId !== undefined ? 1 : 0, storeId ?? null,
    data.document_number !== undefined ? 1 : 0, data.document_number ? String(data.document_number).slice(0, 40) : null,
    data.reference !== undefined ? 1 : 0, data.reference ? String(data.reference).slice(0, 60) : null,
    data.notes !== undefined ? 1 : 0, data.notes ? String(data.notes).slice(0, 500) : null,
    actorId, id, companyId
  );
  return await getScoped(companyId, id);
}

/** Pagamento: condicional e transacional — concorrência protegida no banco. */
async function pay(companyId, id, actorId) {
  const current = await getScoped(companyId, id);
  if (current.status === 'canceled') throw conflict('Título cancelado não pode ser pago.');
  // UPDATE condicional único — atômico por si só (tx desnecessária).
  // Idempotente em retry: duplo pagamento → 409 via changes === 0.
  const info = await db.prepare(
    `UPDATE accounts_payable SET status = 'paid', paid_at = datetime('now'),
       paid_amount_cents = amount_cents, paid_by = ?, updated_by = ?, updated_at = datetime('now')
     WHERE id = ? AND company_id = ? AND status = 'open'`
  ).run(actorId, actorId, id, companyId);
  if (info.changes === 0) throw conflict('Título já está pago.');
  return await getScoped(companyId, id);
}

async function cancel(companyId, id, reason, actorId) {
  const current = await getScoped(companyId, id);
  if (current.status === 'paid') throw conflict('Título pago não pode ser cancelado sem estorno financeiro (fora do escopo desta etapa).');
  if (current.status === 'canceled') throw conflict('Título já cancelado.');
  await db.prepare(
    `UPDATE accounts_payable SET status = 'canceled', updated_by = ?, updated_at = datetime('now')
     WHERE id = ? AND company_id = ? AND status = 'open'`
  ).run(actorId, id, companyId);
  return await getScoped(companyId, id);
}

/** Delete físico SOMENTE manual em aberto; título de compra deve ser cancelado. */
async function remove(companyId, id) {
  const t = await getScoped(companyId, id);
  if (t.status !== 'open') throw conflict('Somente títulos em aberto podem ser excluídos. Cancele para preservar histórico.');
  if (t.origin_type === 'purchase') throw conflict('Títulos originados de compra não podem ser excluídos. Cancele para preservar a integridade financeira.');
  await db.prepare('DELETE FROM accounts_payable WHERE id = ? AND company_id = ? AND status = ?').run(id, companyId, 'open');
  return t;
}

/** Geração de título a partir de compra recebida (chamado DENTRO da
 *  transação do recebimento). Idempotente por UNIQUE + OR IGNORE.
 *  issue_date = data de NEGÓCIO da empresa (businessToday) — nunca UTC. */
async function createFromPurchase(companyId, purchase, actorId) {
  await db.prepare(
    `INSERT OR IGNORE INTO accounts_payable (company_id, store_id, supplier_id, purchase_id, origin_type,
       description, amount_cents, issue_date, due_date, created_by)
     VALUES (?, ?, ?, ?, 'purchase', ?, ?, ?, ?, ?)`
  ).run(
    companyId, purchase.store_id, purchase.supplier_id, purchase.id,
    `Compra #${purchase.id} — ${purchase.supplier_name || 'fornecedor'}`,
    purchase.total_cents, await businessToday(companyId), purchase.purchase_date, actorId
  );
}

module.exports = { list, summary, getScoped, create, update, pay, cancel, remove, createFromPurchase, effectiveStatus };
