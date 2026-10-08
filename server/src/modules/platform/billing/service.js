'use strict';

/**
 * BILLING SaaS — camada comercial da plataforma (Oficial Link → empresas).
 *
 * Contexto DIFERENTE de accounts_payable/accounts_receivable (financeiro do
 * tenant). Aqui são os dados da cobrança que a plataforma faz do tenant:
 * configuração comercial, cobranças (implantação/mensalidade/avulsa),
 * pagamentos manuais registrados pelo Master e comprovantes.
 *
 * Regras desta camada:
 * - Dinheiro SEMPRE em centavos inteiros (sem float).
 * - OVERDUE classificado pela data de negócio de cada empresa
 *   (core/businessDate — nunca date('now')/UTC) e persistido por refresh em
 *   tempo de leitura (escala master-only: dezenas de cobranças).
 * - Pagamento é transacional e idempotente: UPDATE com guarda de status e
 *   changes===1 — concorrência/duplo clique retorna conflito, nunca paga
 *   duas vezes. V1: somente pagamento INTEGRAL (sem parcial).
 * - Comprovante validado por magic bytes (PNG/JPEG/PDF), nunca SVG/HTML.
 * - Nada é apagado: cancelar ≠ excluir; pagamento confirmado não some.
 */

const db = require('../../../database/connection');
const { badRequest, notFound, conflict } = require('../../../core/errors');
const { businessToday, formatInTz } = require('../../../core/businessDate');
const { parseAmountCents } = require('../../sales/service');

const PAYMENT_METHODS = Object.freeze(['pix', 'transferencia', 'boleto', 'dinheiro', 'cartao', 'outro']);
const CHARGE_TYPES = Object.freeze(['implementation', 'monthly', 'custom']);

/** Fuso da plataforma (Oficial Link). Agenda comercial (mês corrente,
 *  "vencendo em breve") usa este fuso; o OVERDUE de cada cobrança usa o
 *  fuso da empresa (businessToday). */
const PLATFORM_TZ = 'America/Fortaleza';

function platformToday() { return formatInTz(new Date(), PLATFORM_TZ); }

// ---------------------------------------------------------------------------
// Datas de negócio
// ---------------------------------------------------------------------------
function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function reqDate(value, field) {
  if (!isValidDate(value)) throw badRequest(`${field} inválida (use AAAA-MM-DD).`);
  return value;
}

// ---------------------------------------------------------------------------
// OVERDUE — refresh em tempo de leitura (fuso de cada empresa)
// ---------------------------------------------------------------------------
async function refreshOverdue() {
  const companies = await db.prepare(
    `SELECT DISTINCT company_id FROM saas_charges WHERE status = 'OPEN'`
  ).all();
  const todayByCompany = new Map();
  for (const { company_id } of companies) {
    todayByCompany.set(company_id, await businessToday(company_id));
  }
  // batch atômico (D1 nativo; clássico: better-sqlite3 transaction)
  await db.batch(companies.map(({ company_id }) => ({
    sql: `UPDATE saas_charges SET status = 'OVERDUE', updated_at = datetime('now')
          WHERE company_id = ? AND status = 'OPEN' AND due_date < ?`,
    params: [company_id, todayByCompany.get(company_id)],
  })));
}

/** Atualiza OPEN → OVERDUE conforme a data de negócio de cada empresa.
 *  Barato (só empresas com cobranças em aberto) e mantém os filtros SQL
 *  corretos sem N+1 de timezone. */


// ---------------------------------------------------------------------------
// Configuração comercial (1:1 com companies)
// ---------------------------------------------------------------------------
async function getConfig(companyId) {
  return await db.prepare('SELECT * FROM saas_billing_config WHERE company_id = ?').get(companyId) || null;
}

async function txSaveConfig(companyId, data) {
  await db.prepare(
    `INSERT INTO saas_billing_config
       (company_id, implementation_fee_cents, monthly_fee_cents, billing_due_day,
        payment_method, billing_notes, next_due_date)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(company_id) DO UPDATE SET
       implementation_fee_cents = excluded.implementation_fee_cents,
       monthly_fee_cents        = excluded.monthly_fee_cents,
       billing_due_day          = excluded.billing_due_day,
       payment_method           = excluded.payment_method,
       billing_notes            = excluded.billing_notes,
       next_due_date            = excluded.next_due_date,
       updated_at               = datetime('now')`
  ).run(
    companyId, data.implementation_fee_cents, data.monthly_fee_cents,
    data.billing_due_day, data.payment_method, data.billing_notes,
    data.next_due_date
  );
}

async function saveConfig(companyId, data) {
  await txSaveConfig(companyId, data);
  return await getConfig(companyId);
}

/** Valida e normaliza o payload da configuração (campos opcionais = manter). */
function validateConfigPayload(body, current) {
  const fee = (raw, field, prev) => {
    if (raw === undefined || raw === null || raw === '') return prev;
    const cents = parseAmountCents(raw, field);
    if (cents < 0) throw badRequest(`${field} não pode ser negativo.`);
    return cents;
  };
  const day = (raw, prev) => {
    if (raw === undefined || raw === null || raw === '') return prev;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 28) {
      throw badRequest('Dia de vencimento inválido (use 1 a 28).');
    }
    return n;
  };
  const method = (raw, prev) => {
    if (raw === undefined || raw === null || raw === '') return prev;
    if (!PAYMENT_METHODS.includes(raw)) throw badRequest('Método de pagamento inválido.');
    return raw;
  };
  const notes = (raw, prev) => {
    if (raw === undefined) return prev;
    if (raw === null || raw === '') return null;
    return String(raw).trim().slice(0, 500) || null;
  };
  const next = (raw, prev) => {
    if (raw === undefined) return prev;
    if (raw === null || raw === '') return null;
    return reqDate(raw, 'Próximo vencimento');
  };
  return {
    implementation_fee_cents: fee(body?.implementation_fee, 'Taxa de implantação', current?.implementation_fee_cents ?? 0),
    monthly_fee_cents: fee(body?.monthly_fee, 'Mensalidade', current?.monthly_fee_cents ?? 0),
    billing_due_day: day(body?.billing_due_day, current?.billing_due_day ?? 10),
    payment_method: method(body?.payment_method, current?.payment_method ?? 'pix'),
    billing_notes: notes(body?.billing_notes, current?.billing_notes ?? null),
    next_due_date: next(body?.next_due_date, current?.next_due_date ?? null),
  };
}

// ---------------------------------------------------------------------------
// Cobranças
// ---------------------------------------------------------------------------
const CHARGE_SELECT = `
  SELECT ch.id, ch.company_id, ch.type, ch.reference, ch.amount_cents, ch.due_date,
         ch.status, ch.paid_at, ch.paid_on, ch.payment_method, ch.payment_notes,
         ch.canceled_at, ch.cancel_notes, ch.created_at,
         c.name AS company_name
  FROM saas_charges ch JOIN companies c ON c.id = ch.company_id`;

async function getCharge(id) {
  return await db.prepare(`${CHARGE_SELECT} WHERE ch.id = ?`).get(id) || null;
}

async function listCharges({ companyId, status, type, search, page, perPage }) {
  await refreshOverdue();
  const where = [];
  const params = [];
  if (companyId) { where.push('ch.company_id = ?'); params.push(companyId); }
  if (status) {
    if (!['OPEN', 'OVERDUE', 'PAID', 'CANCELED'].includes(status)) throw badRequest('Status inválido.');
    where.push('ch.status = ?'); params.push(status);
  }
  if (type) {
    if (!CHARGE_TYPES.includes(type)) throw badRequest('Tipo inválido.');
    where.push('ch.type = ?'); params.push(type);
  }
  if (search) {
    where.push('(c.name LIKE ? OR ch.reference LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total = (await db.prepare(
    `SELECT COUNT(*) AS c FROM saas_charges ch JOIN companies c ON c.id = ch.company_id${w}`
  ).get(...params)).c;
  const items = await db.prepare(
    `${CHARGE_SELECT}${w}
     ORDER BY CASE ch.status WHEN 'OVERDUE' THEN 0 WHEN 'OPEN' THEN 1 ELSE 2 END,
              ch.due_date DESC, ch.id DESC
     LIMIT ? OFFSET ?`
  ).all(...params, perPage, perPage * (page - 1));
  return { items, total };
}

async function createCharge({ companyId, type, reference, amount, due_date, notes }, userId) {
  if (!CHARGE_TYPES.includes(type)) throw badRequest('Tipo de cobrança inválido.');
  const amountCents = parseAmountCents(amount, 'Valor');
  if (amountCents <= 0) throw badRequest('Valor deve ser maior que zero.');
  const dueDate = reqDate(due_date, 'Vencimento');
  const ref = reference === undefined || reference === null ? null : String(reference).trim().slice(0, 80) || null;
  const nt = notes === undefined || notes === null ? null : String(notes).trim().slice(0, 500) || null;
  const id = (await db.prepare(
    `INSERT INTO saas_charges (company_id, type, reference, amount_cents, due_date, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(companyId, type, ref, amountCents, dueDate, userId)).lastInsertRowid;
  return await getCharge(id);
}

async function txUpdateCharge(charge, data) {
  await db.prepare(
    `UPDATE saas_charges
     SET reference = ?, amount_cents = ?, due_date = ?, payment_notes = COALESCE(?, payment_notes),
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(data.reference, data.amountCents, data.dueDate, data.notes, charge.id);
}

/** Edita somente cobrança OPEN/OVERDUE (valor, vencimento, referência, nota). */
async function updateCharge(id, { reference, amount, due_date, notes }) {
  const charge = await getCharge(id);
  if (!charge) throw notFound('Cobrança não encontrada.');
  if (!['OPEN', 'OVERDUE'].includes(charge.status)) {
    throw conflict('Apenas cobranças em aberto podem ser editadas.');
  }
  const amountCents = amount === undefined ? charge.amount_cents : parseAmountCents(amount, 'Valor');
  if (amountCents <= 0) throw badRequest('Valor deve ser maior que zero.');
  const dueDate = due_date === undefined ? charge.due_date : reqDate(due_date, 'Vencimento');
  const ref = reference === undefined ? charge.reference : (String(reference || '').trim().slice(0, 80) || null);
  const nt = notes === undefined ? null : (String(notes || '').trim().slice(0, 500) || null);
  await txUpdateCharge(charge, { reference: ref, amountCents, dueDate, notes: nt });
  return await getCharge(id);
}

async function txCancelCharge(id, notes, userId) {
  const r = await db.prepare(
    `UPDATE saas_charges
     SET status = 'CANCELED', canceled_at = datetime('now'), canceled_by = ?,
         cancel_notes = ?, updated_at = datetime('now')
     WHERE id = ? AND status IN ('OPEN','OVERDUE')`
  ).run(userId, notes, id);
  return r.changes;
}

/** Cancela cobrança em aberto. Nunca apaga: permanece no histórico. */
async function cancelCharge(id, notes, userId) {
  const charge = await getCharge(id);
  if (!charge) throw notFound('Cobrança não encontrada.');
  const changes = await txCancelCharge(id, notes || null, userId);
  if (changes !== 1) throw conflict('Cobrança já foi paga ou cancelada.');
  return await getCharge(id);
}

// ---------------------------------------------------------------------------
// Pagamento (transacional, idempotente, integral na V1)
// ---------------------------------------------------------------------------
const MAX_RECEIPT_BYTES = 5 * 1024 * 1024; // 5 MB (raw)
const RECEIPT_SIGNATURES = [
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
];

/** Decodifica data URL (data:<mime>;base64,...) e valida magic bytes.
 *  Nunca confia no MIME declarado — o tipo real vem dos bytes. */
function decodeReceipt(dataUrl) {
  if (typeof dataUrl !== 'string') throw badRequest('Comprovante inválido.');
  const m = dataUrl.match(/^data:([a-zA-Z0-9/+.-]+);base64,(.*)$/s);
  if (!m) throw badRequest('Comprovante deve ser enviado como data URL base64.');
  if (m[2].length > Math.ceil(MAX_RECEIPT_BYTES / 3) * 4 + 8) {
    throw badRequest('Comprovante excede o tamanho máximo (5 MB).');
  }
  let buf;
  try { buf = Buffer.from(m[2], 'base64'); } catch { throw badRequest('Comprovante inválido.'); }
  if (!buf.length || buf.length > MAX_RECEIPT_BYTES) {
    throw badRequest('Comprovante inválido ou excede 5 MB.');
  }
  const sig = RECEIPT_SIGNATURES.find((s) => s.bytes.every((b, i) => buf[i] === b));
  if (!sig) {
    throw badRequest('Tipo de comprovante não suportado (use PNG, JPEG ou PDF).');
  }
  return { mime: sig.mime, buffer: buf };
}

async function txPay(charge, payment, receipt) {
  // Guarda de status no UPDATE: concorrência/duplo clique → changes 0 → 409.
  // Guard-first sequencial (padrão D1-ready): UPDATE condicional isolado
  // (atômico e idempotente) antes dos INSERTs.
  const r = await db.prepare(
    `UPDATE saas_charges
     SET status = 'PAID', paid_at = datetime('now'), paid_on = ?,
         payment_method = ?, payment_notes = ?, updated_at = datetime('now')
     WHERE id = ? AND status IN ('OPEN','OVERDUE')`
  ).run(payment.paid_on, payment.method, payment.notes, charge.id);
  if (r.changes !== 1) throw conflict('Cobrança já foi paga ou cancelada.');

  const paymentId = (await db.prepare(
    `INSERT INTO saas_payments (charge_id, company_id, amount_cents, paid_on, method, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(charge.id, charge.company_id, payment.amount_cents, payment.paid_on,
        payment.method, payment.notes, payment.created_by)).lastInsertRowid;

  let receiptId = null;
  if (receipt) {
    receiptId = (await db.prepare(
      `INSERT INTO saas_receipts (payment_id, company_id, mime, size, data)
       VALUES (?, ?, ?, ?, ?)`
    ).run(paymentId, charge.company_id, receipt.mime, receipt.buffer.length, receipt.buffer)).lastInsertRowid;
    await db.prepare('UPDATE saas_payments SET receipt_id = ? WHERE id = ?').run(receiptId, paymentId);
  }
  return { paymentId, receiptId };
}

/** Registra pagamento integral de uma cobrança OPEN/OVERDUE. Idempotente por
 *  guarda de status (dupla submissão/concorrência → 409, nunca paga 2x). */
async function payCharge(id, { amount, paid_on, method, notes, receipt }, userId) {
  const charge = await getCharge(id);
  if (!charge) throw notFound('Cobrança não encontrada.');
  if (!['OPEN', 'OVERDUE'].includes(charge.status)) {
    throw conflict('Cobrança já foi paga ou cancelada.');
  }
  const amountCents = parseAmountCents(amount, 'Valor pago');
  if (amountCents <= 0) throw badRequest('Valor pago inválido.');
  if (amountCents !== charge.amount_cents) {
    throw badRequest('Na V1 o pagamento deve ser integral (valor igual à cobrança). Pagamento parcial será uma evolução própria.');
  }
  const paidOn = reqDate(paid_on, 'Data do pagamento');
  if (!PAYMENT_METHODS.includes(method)) throw badRequest('Método de pagamento inválido.');
  const nt = notes === undefined || notes === null ? null : String(notes).trim().slice(0, 500) || null;
  const rc = receipt ? decodeReceipt(receipt) : null;

  const { paymentId } = await txPay(charge, {
    amount_cents: amountCents, paid_on: paidOn, method, notes: nt, created_by: userId,
  }, rc);
  return { charge: await getCharge(id), payment: await getPayment(paymentId) };
}

async function getPayment(id) {
  return await db.prepare(
    `SELECT p.id, p.charge_id, p.company_id, p.amount_cents, p.paid_on, p.method,
            p.notes, p.receipt_id, p.created_at, p.created_by,
            u.name AS created_by_name
     FROM saas_payments p JOIN users u ON u.id = p.created_by WHERE p.id = ?`
  ).get(id) || null;
}

async function listPayments({ companyId, chargeId, page, perPage }) {
  const where = [];
  const params = [];
  if (companyId) { where.push('p.company_id = ?'); params.push(companyId); }
  if (chargeId) { where.push('p.charge_id = ?'); params.push(chargeId); }
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total = (await db.prepare(`SELECT COUNT(*) AS c FROM saas_payments p${w}`).get(...params)).c;
  const items = await db.prepare(
    `SELECT p.id, p.charge_id, p.company_id, p.amount_cents, p.paid_on, p.method,
            p.notes, p.receipt_id, p.created_at, u.name AS created_by_name,
            c.name AS company_name,
            ch.type AS charge_type, ch.reference AS charge_reference
     FROM saas_payments p
     JOIN users u ON u.id = p.created_by
     JOIN companies c ON c.id = p.company_id
     JOIN saas_charges ch ON ch.id = p.charge_id
     ${w}
     ORDER BY p.paid_on DESC, p.id DESC LIMIT ? OFFSET ?`
  ).all(...params, perPage, perPage * (page - 1));
  return { items, total };
}

async function getReceiptByPayment(paymentId) {
  const receipt = await db.prepare(
    'SELECT id, payment_id, mime, size, data FROM saas_receipts WHERE payment_id = ?'
  ).get(paymentId);
  if (!receipt) return null;
  const payment = await db.prepare('SELECT company_id FROM saas_payments WHERE id = ?').get(paymentId);
  return { ...receipt, company_id: payment?.company_id };
}

// ---------------------------------------------------------------------------
// Listagem comercial de empresas + detalhe
// ---------------------------------------------------------------------------
async function listCompaniesCommercial({ search, plan, subscription, situation, page, perPage }) {
  await refreshOverdue();
  const where = [];
  const params = [];
  if (search) {
    where.push('(c.name LIKE ? OR c.trade_name LIKE ? OR c.document LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (plan) { where.push('c.plan = ?'); params.push(String(plan).slice(0, 30)); }
  if (subscription) { where.push('c.subscription_status = ?'); params.push(String(subscription).slice(0, 20)); }
  if (situation === 'overdue') where.push(`EXISTS (SELECT 1 FROM saas_charges ch
    WHERE ch.company_id = c.id AND ch.status = 'OVERDUE')`);
  if (situation === 'due_soon') {
    // Próximos 7 dias no calendário comercial da plataforma.
    const limit = addDaysPlatform(platformToday(), 7);
    where.push(`EXISTS (SELECT 1 FROM saas_charges ch
      WHERE ch.company_id = c.id AND ch.status = 'OPEN' AND ch.due_date <= ?)`);
    params.push(limit);
  }
  if (situation === 'none') where.push('cfg.company_id IS NULL');
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total = (await db.prepare(
    `SELECT COUNT(*) AS c FROM companies c LEFT JOIN saas_billing_config cfg ON cfg.company_id = c.id${w}`
  ).get(...params)).c;
  const items = await db.prepare(
    `SELECT c.id, c.name, c.trade_name, c.document, c.plan, c.status, c.subscription_status,
            cfg.monthly_fee_cents, cfg.implementation_fee_cents, cfg.billing_due_day, cfg.next_due_date,
       (SELECT ch.due_date FROM saas_charges ch
         WHERE ch.company_id = c.id AND ch.status IN ('OPEN','OVERDUE')
         ORDER BY ch.due_date LIMIT 1) AS next_charge_due,
       (SELECT COUNT(*) FROM saas_charges ch
         WHERE ch.company_id = c.id AND ch.status = 'OVERDUE') AS overdue_count,
       (SELECT COALESCE(SUM(ch.amount_cents),0) FROM saas_charges ch
         WHERE ch.company_id = c.id AND ch.status = 'OVERDUE') AS overdue_cents,
       (SELECT ch.status FROM saas_charges ch
         WHERE ch.company_id = c.id AND ch.type = 'implementation'
         ORDER BY ch.id DESC LIMIT 1) AS implementation_status
     FROM companies c LEFT JOIN saas_billing_config cfg ON cfg.company_id = c.id
     ${w}
     ORDER BY overdue_cents DESC, c.name
     LIMIT ? OFFSET ?`
  ).all(...params, perPage, perPage * (page - 1));
  return { items, total };
}

function addDaysPlatform(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return formatInTz(dt, PLATFORM_TZ);
}

async function companyCommercialDetail(companyId) {
  await refreshOverdue();
  const company = await db.prepare(
    `SELECT c.id, c.name, c.trade_name, c.document, c.plan, c.status, c.subscription_status, c.created_at
     FROM companies c WHERE c.id = ?`
  ).get(companyId);
  if (!company) throw notFound('Empresa não encontrada.');
  company.config = await getConfig(companyId);
  const charges = await db.prepare(
    `${CHARGE_SELECT} WHERE ch.company_id = ? ORDER BY ch.id DESC LIMIT 100`
  ).all(companyId);
  company.charges = charges;
  const totals = await db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN status IN ('OPEN','OVERDUE') THEN amount_cents END), 0) AS open_cents,
       COALESCE(SUM(CASE WHEN status = 'OVERDUE' THEN amount_cents END), 0)     AS overdue_cents,
       COALESCE(SUM(CASE WHEN status = 'PAID' THEN amount_cents END), 0)        AS paid_cents,
       SUM(CASE WHEN status IN ('OPEN','OVERDUE') THEN 1 ELSE 0 END)            AS open_count,
       SUM(CASE WHEN status = 'OVERDUE' THEN 1 ELSE 0 END)                      AS overdue_count
     FROM saas_charges WHERE company_id = ?`
  ).get(companyId);
  company.charge_totals = totals;
  return company;
}

// ---------------------------------------------------------------------------
// Dashboard comercial
// ---------------------------------------------------------------------------
function nextMonthStart(monthStart) {
  const [y, m] = monthStart.slice(0, 7).split('-').map(Number);
  return formatInTz(new Date(Date.UTC(y, m, 1)), PLATFORM_TZ); // mês seguinte (m é 1-based)
}

async function overview() {
  await refreshOverdue();
  const today = platformToday();
  const monthStart = `${today.slice(0, 7)}-01`;
  const monthEnd = nextMonthStart(monthStart);

  const mrr = await db.prepare(
    `SELECT COALESCE(SUM(cfg.monthly_fee_cents), 0) AS s, COUNT(*) AS c
     FROM saas_billing_config cfg
     JOIN companies c ON c.id = cfg.company_id
     WHERE c.subscription_status = 'active' AND cfg.monthly_fee_cents > 0`
  ).get();

  const received = await db.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS s, COUNT(*) AS c
     FROM saas_payments WHERE paid_on >= ? AND paid_on < ?`
  ).get(monthStart, monthEnd);

  const open = await db.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS s, COUNT(*) AS c
     FROM saas_charges WHERE status = 'OPEN'`
  ).get();
  const overdue = await db.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS s, COUNT(*) AS c
     FROM saas_charges WHERE status = 'OVERDUE'`
  ).get();
  const implementationPending = await db.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS s, COUNT(*) AS c
     FROM saas_charges WHERE type = 'implementation' AND status IN ('OPEN','OVERDUE')`
  ).get();

  const attentionOverdue = await db.prepare(
    `SELECT ch.id, ch.company_id, ch.type, ch.reference, ch.amount_cents, ch.due_date,
            c.name AS company_name
     FROM saas_charges ch JOIN companies c ON c.id = ch.company_id
     WHERE ch.status = 'OVERDUE'
     ORDER BY ch.due_date LIMIT 10`
  ).all();

  const dueSoonLimit = addDaysPlatform(today, 7);
  const attentionDueSoon = await db.prepare(
    `SELECT ch.id, ch.company_id, ch.type, ch.reference, ch.amount_cents, ch.due_date,
            c.name AS company_name
     FROM saas_charges ch JOIN companies c ON c.id = ch.company_id
     WHERE ch.status = 'OPEN' AND ch.due_date <= ?
     ORDER BY ch.due_date LIMIT 10`
  ).all(dueSoonLimit);

  const recentPayments = await db.prepare(
    `SELECT p.id, p.company_id, p.amount_cents, p.paid_on, p.method, p.receipt_id,
            c.name AS company_name
     FROM saas_payments p JOIN companies c ON c.id = p.company_id
     ORDER BY p.id DESC LIMIT 8`
  ).all();

  const companies = await db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN subscription_status = 'active' THEN 1 ELSE 0 END) AS subscriptions_active
     FROM companies`
  ).get();

  return {
    month: today.slice(0, 7),
    companies,
    mrr_expected_cents: mrr.s,
    mrr_companies: mrr.c,
    received_month_cents: received.s,
    received_month_count: received.c,
    open_cents: open.s,
    open_count: open.c,
    overdue_cents: overdue.s,
    overdue_count: overdue.c,
    implementation_pending_cents: implementationPending.s,
    implementation_pending_count: implementationPending.c,
    attention_overdue: attentionOverdue,
    attention_due_soon: attentionDueSoon,
    recent_payments: recentPayments,
  };
}

module.exports = {
  PAYMENT_METHODS,
  CHARGE_TYPES,
  PLATFORM_TZ,
  refreshOverdue,
  getConfig,
  saveConfig,
  validateConfigPayload,
  getCharge,
  listCharges,
  createCharge,
  updateCharge,
  cancelCharge,
  payCharge,
  getPayment,
  listPayments,
  getReceiptByPayment,
  listCompaniesCommercial,
  companyCommercialDetail,
  overview,
};
