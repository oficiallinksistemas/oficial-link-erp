'use strict';

/**
 * Serviço de Ranking (v1.4.1) — correções sobre a v1.4:
 *
 * 1) REGRA DE META CORRIGIDA: a meta só é usada quando COBRE INTEGRALMENTE o
 *    período consultado (start_date <= from AND end_date >= to). Sobreposição
 *    parcial NÃO é utilizada → meta/percent ficam null ("—"). Havendo várias
 *    metas válidas, usa-se a MAIS ESPECÍFICA (menor duração) — regra mantida.
 *
 * 2) VALIDAÇÃO DE DATAS RIGOROSA: from/to aceitam somente datas REAIS em
 *    AAAA-MM-DD (2026-02-31, 2026-13-01, 2026-00-10, 10/10/2026, abc → 400),
 *    mesmo padrão do módulo Metas. Manter from <= to; ausência → mês corrente.
 *
 * 3) SEM DUPLA AGREGAÇÃO: sellerRanking() executa a agregação UMA vez; o
 *    summary é derivado desses itens (routes não reconsulta).
 *
 * 4) METAS EM LOTE: as metas que cobrem o período são carregadas em UMA única
 *    consulta e mapeadas por escopo (regra de menor duração resolvida em
 *    memória sobre poucos registros) — nenhuma query por vendedor/loja.
 *
 * Mantém: ranking derivado (sem tabela própria), vendas ATIVAS apenas,
 * company_id da sessão, índices compostos, zero venda em memória.
 */

const db = require('../../database/connection');
const { badRequest } = require('../../core/errors');

// ---------------------------------------------------------------------------
// Período (validação rigorosa — equivalente ao módulo Metas)
// ---------------------------------------------------------------------------

function parseDateStrict(value, field) {
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

function parsePeriod(query) {
  const hasFrom = query.from !== undefined && query.from !== '';
  const hasTo = query.to !== undefined && query.to !== '';
  let from;
  let to;

  if (!hasFrom && !hasTo) {
    const now = new Date();
    const fmt = (d) => d.toISOString().slice(0, 10);
    from = fmt(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
    to = fmt(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)));
  } else {
    from = hasFrom ? parseDateStrict(query.from, 'Data inicial') : parseDateStrict(query.to, 'Data final');
    to = hasTo ? parseDateStrict(query.to, 'Data final') : from;
  }
  if (to < from) throw badRequest('Data final deve ser igual ou posterior à inicial.');
  return { from, to };
}

// ---------------------------------------------------------------------------
// Metas (uma consulta em lote; cobertura integral; mais específica vence)
// ---------------------------------------------------------------------------

const durationMs = (start, end) => Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);

/**
 * Mapa escopo → target_cents com a regra v1.4.1:
 * só metas que cobrem INTEGRALMENTE [from, to]; desempate por menor duração.
 */
async function buildTargetMap(companyId, type, from, to) {
  const rows = await db.prepare(
    `SELECT ${type === 'seller' ? 'user_id' : 'store_id'} AS scope_id,
            target_cents, start_date, end_date
     FROM targets
     WHERE company_id = ? AND type = ?
       AND start_date <= ? AND end_date >= ?`
  ).all(companyId, type, from, to);

  const map = new Map();
  for (const r of rows) {
    const dur = durationMs(r.start_date, r.end_date);
    const current = map.get(r.scope_id);
    if (!current || dur < current.dur) {
      map.set(r.scope_id, { target_cents: r.target_cents, dur });
    }
  }
  return map;
}

function attachMeta(targetMap, rows, idField) {
  return rows.map((r) => {
    const entry = targetMap.get(r[idField]);
    const target = entry ? entry.target_cents : null;
    return {
      ...r,
      target_cents: target,
      percent: target ? Math.round((r.total_cents / target) * 1000) / 10 : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Rankings (uma agregação por visão)
// ---------------------------------------------------------------------------

/** Ranking de VENDEDORES da empresa. */
async function sellerRanking(companyId, { from, to, store_id }) {
  const params = [from, to];
  let storeFilter = '';
  if (store_id) { storeFilter = ' AND s.store_id = ?'; params.push(store_id); }
  params.push(companyId);

  const rows = await db.prepare(
    `SELECT u.id AS seller_id, u.name,
            COUNT(s.id) AS sales_count,
            COALESCE(SUM(s.amount_cents), 0) AS total_cents
     FROM users u
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN sales s
       ON s.seller_id = u.id
      AND s.company_id = u.company_id
      AND s.status = 'active'
      AND date(s.sold_at) BETWEEN date(?) AND date(?)${storeFilter}
     WHERE u.company_id = ? AND u.status = 'active' AND r.slug = 'seller'
     GROUP BY u.id
     ORDER BY total_cents DESC, u.name ASC`
  ).all(...params);

  const targetMap = await buildTargetMap(companyId, 'seller', from, to);
  const leader = rows.length ? rows[0].total_cents : 0;
  return attachMeta(targetMap, rows, 'seller_id')
    .map((r, i) => ({
      position: i + 1,
      ...r,
      gap_to_leader_cents: leader - r.total_cents,
    }));
}

/** Ranking de LOJAS da empresa. */
async function storeRanking(companyId, { from, to }) {
  const rows = await db.prepare(
    `SELECT st.id AS store_id, st.name,
            COUNT(s.id) AS sales_count,
            COALESCE(SUM(s.amount_cents), 0) AS total_cents
     FROM stores st
     LEFT JOIN sales s
       ON s.store_id = st.id
      AND s.company_id = st.company_id
      AND s.status = 'active'
      AND date(s.sold_at) BETWEEN date(?) AND date(?)
     WHERE st.company_id = ?
     GROUP BY st.id
     ORDER BY total_cents DESC, st.name ASC`
  ).all(from, to, companyId);

  const targetMap = await buildTargetMap(companyId, 'store', from, to);
  const leader = rows.length ? rows[0].total_cents : 0;
  return attachMeta(targetMap, rows, 'store_id')
    .map((r, i) => ({
      position: i + 1,
      ...r,
      gap_to_leader_cents: leader - r.total_cents,
    }));
}

/**
 * Summary derivado do resultado único do sellerRanking — NENHUMA segunda
 * agregação SQL.
 */
function summaryFromItems(items) {
  const withMeta = items.filter((s) => s.target_cents !== null);
  return {
    total_cents: items.reduce((acc, s) => acc + s.total_cents, 0),
    sales_count: items.reduce((acc, s) => acc + s.sales_count, 0),
    leader: items.length ? { name: items[0].name, total_cents: items[0].total_cents } : null,
    avg_meta_percent: withMeta.length
      ? Math.round(withMeta.reduce((acc, s) => acc + (s.percent || 0), 0) / withMeta.length * 10) / 10
      : null,
  };
}

/** Líder do mês corrente (card do dashboard). */
async function monthLeader(companyId) {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const rows = await sellerRanking(companyId, { from: first, to: last });
  return rows.length && rows[0].total_cents > 0
    ? { name: rows[0].name, total_cents: rows[0].total_cents }
    : null;
}

module.exports = { parsePeriod, sellerRanking, storeRanking, summaryFromItems, monthLeader, parseDateStrict };
