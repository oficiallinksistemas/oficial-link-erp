'use strict';

/**
 * Serviço de Metas (v1.3.1) — correções sobre a v1.3:
 *
 * 1) VENDEDOR RESTRITO À FUNÇÃO "seller": metas de vendedor só aceitam
 *    usuários ativos da empresa CUJA FUNÇÃO seja vendedor (RBAC real, validado
 *    no backend — o frontend também filtra, mas nunca é autoridade).
 *
 * 2) DESEMPENHO SEM N+1: a listagem passa a EMBUTIR o desempenho de cada meta
 *    (achieved_cents, percent, missing_cents, reached) — uma única requisição
 *    HTTP. No servidor, cada linha é calculada por AGREGAÇÃO SQL (SUM com
 *    prepared statement reutilizado + índices compostos). Nenhuma venda é
 *    carregada para memória. O endpoint /:id/performance continua existindo
 *    para detalhe.
 *
 * Regras preservadas: vendas ATIVAS apenas; período da meta; escopo por
 * tenant; anti-duplicidade por escopo + período exato (sobreposições ok).
 */

const db = require('../../database/connection');
const { badRequest, notFound, conflict } = require('../../core/errors');
const { parseAmountCents } = require('../sales/service');

// ---------------------------------------------------------------------------
// Validações
// ---------------------------------------------------------------------------

function parseDate(value, field) {
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

/** Vendedor = usuário ATIVO da empresa cuja FUNÇÃO é "seller". */
async function assertSellerInCompany(companyId, userId) {
  const u = await db.prepare(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.id = ? AND u.company_id = ? AND u.status = 'active' AND r.slug = 'seller'`
  ).get(userId, companyId);
  if (!u) throw badRequest('Vendedor inválido para esta empresa.');
  return u.id;
}

async function assertStoreInCompany(companyId, storeId) {
  const s = await db.prepare('SELECT id FROM stores WHERE id = ? AND company_id = ?').get(storeId, companyId);
  if (!s) throw badRequest('Loja inválida para esta empresa.');
  return s.id;
}

/** Normaliza e valida o escopo (type + user_id/store_id) do payload. */
async function parseScope(companyId, data) {
  const type = String(data.type || '').trim();
  if (!['seller', 'store'].includes(type)) throw badRequest('Tipo de meta inválido (use seller ou store).');
  if (type === 'seller') {
    const userId = Number(data.user_id);
    if (!Number.isInteger(userId)) throw badRequest('Vendedor é obrigatório para meta de vendedor.');
    return { type, user_id: await assertSellerInCompany(companyId, userId), store_id: null };
  }
  const storeId = Number(data.store_id);
  if (!Number.isInteger(storeId)) throw badRequest('Loja é obrigatória para meta de loja.');
  return { type, user_id: null, store_id: await assertStoreInCompany(companyId, storeId) };
}

// ---------------------------------------------------------------------------
// Desempenho (agregação SQL — nada carregado em memória)
// ---------------------------------------------------------------------------

const perfStmtCache = {};

function perfStatement(type) {
  if (!perfStmtCache[type]) {
    const scopeCol = type === 'seller' ? 'seller_id' : 'store_id';
    perfStmtCache[type] = db.prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS achieved
       FROM sales
       WHERE company_id = ? AND status = 'active'
         AND date(sold_at) BETWEEN date(?) AND date(?)
         AND ${scopeCol} = ?`
    );
  }
  return perfStmtCache[type];
}

function performanceOf(companyId, target) {
  const stmt = perfStatement(target.type);
  const scopeId = target.type === 'seller' ? target.user_id : target.store_id;
  const achieved = stmt.get(companyId, target.start_date, target.end_date, scopeId).achieved;
  const targetCents = target.target_cents;
  const missing = Math.max(targetCents - achieved, 0);
  return {
    achieved_cents: achieved,
    missing_cents: missing,
    percent: targetCents > 0 ? Math.round((achieved / targetCents) * 1000) / 10 : 0,
    reached: achieved >= targetCents,
  };
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

const TARGET_SQL = `
  SELECT t.id, t.company_id, t.type, t.user_id, t.store_id,
         t.start_date, t.end_date, t.target_cents, t.notes, t.created_at,
         u.name  AS seller_name,
         st.name AS store_name,
         cb.name AS created_by_name
  FROM targets t
  LEFT JOIN users u  ON u.id = t.user_id
  LEFT JOIN stores st ON st.id = t.store_id
  JOIN users cb ON cb.id = t.created_by
`;

async function getScoped(companyId, id) {
  const t = await db.prepare(`${TARGET_SQL} WHERE t.id = ? AND t.company_id = ?`).get(id, companyId);
  if (!t) throw notFound('Meta não encontrada.');
  return t;
}

async function list(companyId, { page, perPage, offset, type, user_id, store_id, from, to }) {
  let where = ' WHERE t.company_id = ?';
  const params = [companyId];
  if (type === 'seller' || type === 'store') { where += ' AND t.type = ?'; params.push(type); }
  if (user_id) { where += ' AND t.user_id = ?'; params.push(user_id); }
  if (store_id) { where += ' AND t.store_id = ?'; params.push(store_id); }
  if (from) { where += ' AND t.end_date >= ?'; params.push(parseDate(from, 'Data inicial do filtro')); }
  if (to) { where += ' AND t.start_date <= ?'; params.push(parseDate(to, 'Data final do filtro')); }

  const total = (await db.prepare(`SELECT COUNT(*) AS c FROM targets t${where}`).get(...params)).c;
  const items = await db.prepare(`${TARGET_SQL}${where} ORDER BY t.end_date DESC, t.id DESC LIMIT ? OFFSET ?`)
    .all(...params, perPage, offset)
    // Desempenho embutido — elimina o N+1 de requisições do frontend
    .map((t) => ({ ...t, ...performanceOf(companyId, t) }));
  return { items, total, page, perPage };
}

/** Desempenho de uma meta (detalhe). */
async function performance(companyId, id) {
  const t = await getScoped(companyId, id);
  return {
    target: t,
    target_cents: t.target_cents,
    ...performanceOf(companyId, t),
  };
}

/** Resumo para o dashboard: metas que cobrem o mês corrente. */
async function monthSummary(companyId) {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const first = `${y}-${m}-01`;
  const last = new Date(Date.UTC(y, now.getMonth() + 1, 0)).toISOString().slice(0, 10);
  const row = await db.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(target_cents), 0) AS target_cents
     FROM targets WHERE company_id = ? AND start_date <= ? AND end_date >= ?`
  ).get(companyId, last, first);
  return { count: row.count, target_cents: row.target_cents, month: `${y}-${m}` };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

async function create(companyId, actorId, data) {
  const scope = await parseScope(companyId, data);
  const startDate = parseDate(data.start_date, 'Data inicial');
  const endDate = parseDate(data.end_date, 'Data final');
  if (endDate < startDate) throw badRequest('Data final deve ser igual ou posterior à inicial.');
  const targetCents = parseAmountCents(data.target_value, 'Valor da meta');
  const notes = data.notes ? String(data.notes).trim().slice(0, 500) : null;

  let id;
  try {
    id = (await db.prepare(
      `INSERT INTO targets (company_id, type, user_id, store_id, start_date, end_date, target_cents, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(companyId, scope.type, scope.user_id, scope.store_id, startDate, endDate, targetCents, notes, actorId)).lastInsertRowid;
  } catch (err) {
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
      throw conflict('Já existe uma meta idêntica para esse vendedor/loja nesse período.');
    }
    throw err;
  }
  return await getScoped(companyId, id);
}

async function update(companyId, id, data) {
  await getScoped(companyId, id); // escopo antes de alterar
  let scope;
  if (data.type !== undefined) {
    scope = await parseScope(companyId, data);
  }
  const startDate = data.start_date !== undefined ? parseDate(data.start_date, 'Data inicial') : undefined;
  const endDate = data.end_date !== undefined ? parseDate(data.end_date, 'Data final') : undefined;
  const targetCents = data.target_value !== undefined ? parseAmountCents(data.target_value, 'Valor da meta') : undefined;
  const notes = data.notes !== undefined ? (data.notes ? String(data.notes).trim().slice(0, 500) : null) : undefined;

  const current = await getScoped(companyId, id);
  const newStart = startDate ?? current.start_date;
  const newEnd = endDate ?? current.end_date;
  if (newEnd < newStart) throw badRequest('Data final deve ser igual ou posterior à inicial.');

  try {
    await db.prepare(
      `UPDATE targets SET
         type         = COALESCE(?, type),
         user_id      = CASE WHEN ? THEN ? ELSE user_id END,
         store_id     = CASE WHEN ? THEN ? ELSE store_id END,
         start_date   = COALESCE(?, start_date),
         end_date     = COALESCE(?, end_date),
         target_cents = COALESCE(?, target_cents),
         notes        = CASE WHEN ? THEN ? ELSE notes END,
         updated_at   = datetime('now')
       WHERE id = ? AND company_id = ?`
    ).run(
      scope?.type ?? null,
      scope ? 1 : 0, scope?.user_id ?? null,
      scope ? 1 : 0, scope?.store_id ?? null,
      startDate ?? null, endDate ?? null, targetCents ?? null,
      notes !== undefined ? 1 : 0, notes ?? null,
      id, companyId
    );
  } catch (err) {
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
      throw conflict('Já existe uma meta idêntica para esse vendedor/loja nesse período.');
    }
    throw err;
  }
  return await getScoped(companyId, id);
}

async function remove(companyId, id) {
  const t = await getScoped(companyId, id);
  await db.prepare('DELETE FROM targets WHERE id = ? AND company_id = ?').run(id, companyId);
  return t;
}

module.exports = { list, getScoped, create, update, remove, performance, monthSummary, parseScope };
