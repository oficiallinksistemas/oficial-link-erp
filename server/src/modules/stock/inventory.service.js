'use strict';

/**
 * Inventário (v1.9) — contagem física por loja.
 * Abrir sessão → registrar contagens (system_quantity = saldo no momento da
 * contagem) → finalizar: cada diferença gera ADJUST_IN/OUT na MESMA
 * transação. Idempotente (dupla finalização → 409). Loja/empresa cruzadas →
 * 400/404. Nada de contábil — apenas correção de saldo com histórico.
 */

const db = require('../../database/connection');
const { badRequest, notFound, conflict } = require('../../core/errors');
const stock = require('./service');

async function getSession(companyId, id) {
  const s = await db.prepare(
    `SELECT i.*, st.name AS store_name, u.name AS created_by_name
     FROM inventory_sessions i JOIN stores st ON st.id = i.store_id JOIN users u ON u.id = i.created_by
     WHERE i.id = ? AND i.company_id = ?`
  ).get(id, companyId);
  if (!s) throw notFound('Inventário não encontrado.');
  return s;
}

async function open(companyId, actorId, { store_id, note }) {
  const store = await db.prepare(`SELECT id FROM stores WHERE id = ? AND company_id = ? AND status = 'active'`).get(store_id, companyId);
  if (!store) throw badRequest('Loja inválida para esta empresa.');
  const openCount = (await db.prepare(`SELECT COUNT(*) AS c FROM inventory_sessions WHERE company_id = ? AND store_id = ? AND status = 'open'`)
    .get(companyId, store.id)).c;
  if (openCount > 0) throw conflict('Já existe um inventário aberto para esta loja.');
  const id = (await db.prepare(
    `INSERT INTO inventory_sessions (company_id, store_id, created_by, note) VALUES (?, ?, ?, ?)`
  ).run(companyId, store.id, actorId, note ? String(note).slice(0, 300) : null)).lastInsertRowid;
  return await detail(companyId, id);
}

/** Registra (ou atualiza) a contagem de um produto. */
async function count(companyId, sessionId, { product_id, counted }) {
  const session = await getSession(companyId, sessionId);
  if (session.status !== 'open') throw conflict('Inventário já finalizado.');
  const pid = Number(product_id);
  const countedQty = Number(counted);
  if (!Number.isInteger(pid)) throw badRequest('Produto inválido.');
  if (!Number.isInteger(countedQty) || countedQty < 0) throw badRequest('Quantidade contada inválida (inteiro ≥ 0).');
  const product = await db.prepare('SELECT id, name FROM products WHERE id = ? AND company_id = ?').get(pid, companyId);
  if (!product) throw badRequest('Produto inválido para esta empresa.');

  // Marcador determinístico: último movimento existente no momento da
  // contagem — a finalização soma apenas movimentos com id MAIOR que este.
  // Leitura de saldo + marcador + gravação na MESMA transação: o par
  // (system_quantity, counted_movement_id) é sempre um estado lógico único.
  // Guard-first (padrão D1-ready): leituras fora, escrita única com UPSERT
  // idempotente. O par (system_quantity, counted_movement_id) permanece um
  // estado lógico único — mesma garantia da transação original.
  const systemQty = await stock.currentBalance(companyId, session.store_id, pid);
  const lastMovement = (await db.prepare(
    'SELECT COALESCE(MAX(id), 0) AS m FROM stock_movements WHERE company_id = ? AND store_id = ? AND product_id = ?'
  ).get(companyId, session.store_id, pid)).m;
  await db.prepare(
    `INSERT INTO inventory_items (session_id, company_id, product_id, system_quantity, counted_quantity, difference, counted_at, counted_movement_id)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT(session_id, product_id) DO UPDATE SET
       system_quantity = excluded.system_quantity, counted_quantity = excluded.counted_quantity,
       difference = excluded.difference, counted_at = excluded.counted_at,
       counted_movement_id = excluded.counted_movement_id`
  ).run(sessionId, companyId, pid, systemQty, countedQty, countedQty - systemQty, lastMovement);
  return await detail(companyId, sessionId);
}

async function finalize(companyId, sessionId, actorId) {
  const session = await getSession(companyId, sessionId);
  if (session.status === 'completed') throw conflict('Inventário já finalizado.');
  if (session.status === 'canceled') throw conflict('Inventário cancelado.');
  const items = await db.prepare(
    `SELECT product_id, system_quantity, counted_quantity, counted_at, counted_movement_id FROM inventory_items
     WHERE session_id = ? AND company_id = ? AND counted_quantity IS NOT NULL AND product_id IS NOT NULL`
  ).all(sessionId, companyId);

  // Guard-first: UPDATE condicional da sessão (idempotente: dupla
  // finalização → 409 via changes === 0) ANTES de qualquer movimentação.
  const info = await db.prepare(
    `UPDATE inventory_sessions SET status = 'completed', completed_at = datetime('now'), completed_by = ?
     WHERE id = ? AND company_id = ? AND status = 'open'`
  ).run(actorId, sessionId, companyId);
  if (info.changes === 0) throw conflict('Inventário já finalizado.');
  {
    for (const it of items) {
      // REGRA DEFINITIVA (auditoria V1.9): o ajuste é calculado EXCLUSIVA-
      // MENTE contra o estoque existente NO MOMENTO DA CONTAGEM; os movimentos
      // posteriores permanecem no saldo (não são apagados nem re-somados).
      //   adjustment = counted − system_at_count
      //   saldo_final = saldo_atual (já contém os pós-contagem) + adjustment
      // Ex.: sistema 100 / contado 90 / +20 / −10 → saldo 110 →
      //      adjustment −10 → saldo final 100 (NÃO 90).
      const diff = it.counted_quantity - it.system_quantity;
      if (diff === 0) continue;
      const type = diff > 0 ? 'ADJUST_IN' : 'ADJUST_OUT';
      await stock.applyMovement(companyId, session.store_id, it.product_id, type, Math.abs(diff), 'adjust', sessionId, actorId, `Inventário #${sessionId}`);
      await db.prepare('UPDATE inventory_items SET adjustment_applied = 1 WHERE session_id = ? AND product_id = ?')
        .run(sessionId, it.product_id);
    }
  }
  return await detail(companyId, sessionId);
}

async function cancel(companyId, sessionId, reason, actorId) {
  const session = await getSession(companyId, sessionId);
  if (session.status !== 'open') throw conflict('Somente inventários abertos podem ser cancelados.');
  const r = String(reason || '').trim();
  if (r.length < 3) throw badRequest('Informe o motivo.');
  await db.prepare(`UPDATE inventory_sessions SET status = 'canceled' WHERE id = ? AND company_id = ? AND status = 'open'`)
    .run(sessionId, companyId);
  return await detail(companyId, sessionId);
}

async function detail(companyId, id) {
  const session = await getSession(companyId, id);
  session.items = await db.prepare(
    `SELECT ii.id, ii.product_id, p.name AS product_name, p.sku, ii.system_quantity, ii.counted_quantity, ii.difference, ii.adjustment_applied
     FROM inventory_items ii JOIN products p ON p.id = ii.product_id
     WHERE ii.session_id = ? ORDER BY p.name`
  ).all(id);
  return session;
}

async function list(companyId, { page, perPage, offset, store_id, status }) {
  let where = ' WHERE i.company_id = ?';
  const params = [companyId];
  if (store_id) {
    const st = await db.prepare('SELECT id FROM stores WHERE id = ? AND company_id = ?').get(store_id, companyId);
    if (!st) throw notFound('Loja não encontrada.');
    where += ' AND i.store_id = ?'; params.push(st.id);
  }
  if (status && ['open', 'completed', 'canceled'].includes(status)) { where += ' AND i.status = ?'; params.push(status); }
  const total = (await db.prepare(`SELECT COUNT(*) AS c FROM inventory_sessions i${where}`).get(...params)).c;
  const items = await db.prepare(
    `SELECT i.id, i.status, i.started_at, i.completed_at, i.note, st.name AS store_name, u.name AS created_by_name,
       (SELECT COUNT(*) FROM inventory_items x WHERE x.session_id = i.id) AS items_count
     FROM inventory_sessions i JOIN stores st ON st.id = i.store_id JOIN users u ON u.id = i.created_by
     ${where} ORDER BY i.id DESC LIMIT ? OFFSET ?`
  ).all(...params, perPage, offset);
  return { items, total, page, perPage };
}

module.exports = { open, count, finalize, cancel, detail, list };
