'use strict';

/**
 * Adapter de banco DUAL — Fase 2 (Cloudflare).
 *
 * Uma única API assíncrona, dois backends:
 *
 *   MODO D1 (Cloudflare Workers):
 *     - detectado pela presença do módulo 'cloudflare:workers' (via
 *       d1-binding.mjs, importável apenas dentro do bundle do Wrangler).
 *     - prepare(sql) → D1PreparedStatement { get/all/run } assíncronos
 *     - batch(stmts) → env.DB.batch() (atômico no D1)
 *
 *   MODO CLÁSSICO (Node.js + better-sqlite3 — dev/teste local):
 *     - fallback quando o módulo cloudflare:workers não existe.
 *     - mesma API sobre better-sqlite3; batch() atômico via transaction.
 *
 * GARANTIAS PRESERVADAS em ambos os modos:
 *   - run() resolve com { changes, lastInsertRowid }
 *   - get() resolve com a linha ou undefined
 *   - INTEGER permanece INTEGER; valores monetários seguem em cents
 *   - undefined é normalizado para null nos binds (compat better-sqlite3)
 *   - BLOB: Buffer no clássico; ArrayBuffer/Uint8Array no D1 (rotas de
 *     download fazem Buffer.from() quando necessário — ver company/routes.js)
 *
 * MIGRAÇÃO/SEED não rodam aqui: no Worker são etapas de deploy
 * (wrangler d1 execute / wrangler d1 migrations apply). O modo clássico
 * continua aplicando migrations no boot (database/connection legado é
 * carregado apenas neste modo, via require não rastreável pelo bundler).
 */

let mode = null; // 'd1' | 'classic'

function getD1Module() {
  // .mjs só é require-able dentro do bundle do Wrangler; no Node clássico
  // o require lança (ESM) e caímos no modo clássico.
  try {
    return require('./d1-binding.mjs');
  } catch {
    return null;
  }
}

function resolveMode() {
  if (mode === null) {
    mode = getD1Module() ? 'd1' : 'classic';
  }
  return mode;
}

function isD1() {
  return resolveMode() === 'd1';
}

/* ------------------------------- modo D1 ---------------------------------- */

function d1Wrap(stmt) {
  const norm = (params) => params.map((v) => (v === undefined ? null : v));
  return {
    get: (...params) =>
      stmt.bind(...norm(params)).first().then((row) => (row == null ? undefined : row)),
    all: (...params) =>
      stmt.bind(...norm(params)).all().then((r) => r.results),
    run: (...params) =>
      stmt.bind(...norm(params)).run().then(({ meta }) => ({
        changes: meta.changes,
        lastInsertRowid: meta.last_row_id,
      })),
  };
}

function d1Prepare(sql) {
  return d1Wrap(getD1Module().getBinding().prepare(sql));
}

function d1Exec(sql) {
  // D1 não tem exec genérico multi-statement via binding; split simples de
  // ponto-e-vírgula fora de strings (usado apenas por bootstrap interno).
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  let chain = Promise.resolve();
  for (const s of statements) chain = chain.then(() => getD1Module().getBinding().prepare(s).run());
  return chain;
}

function d1Batch(stmts) {
  const norm = (params) => (params || []).map((v) => (v === undefined ? null : v));
  return getD1Module()
    .getBinding()
    .batch(stmts.map((s) => getD1Module().getBinding().prepare(s.sql).bind(...norm(s.params))));
}

/* ----------------------------- modo clássico ------------------------------ */

function getClassicConnection() {
  // require NÃO rastreável pelo bundler do Wrangler: o worker nunca executa
  // este caminho (modo D1), e o better-sqlite3 (addon nativo) não pode
  // entrar no bundle. db.js exporta a instância better-sqlite3.
  return eval('require')('./db');
}

function classicWrap(stmt) {
  // SINCRONO de propósito: o código de negócio await-ed funciona igual
  // (await sobre valor não-thenable devolve o valor), e consumidores sync
  // legados (migrations, seed, scripts, testes com leitura direta) seguem
  // funcionando sem alteração.
  return {
    get: (...params) => stmt.get(...params),
    all: (...params) => stmt.all(...params),
    run: (...params) => stmt.run(...params),
  };
}

function classicPrepare(sql) {
  return classicWrap(getClassicConnection().prepare(sql));
}

function classicExec(sql) {
  return getClassicConnection().exec(sql);
}

function classicBatch(stmts) {
  const conn = getClassicConnection();
  const tx = conn.transaction((list) => {
    const out = [];
    for (const s of list) out.push(conn.prepare(s.sql).run(...(s.params || [])));
    return out;
  });
  return tx(stmts);
}

/* --------------------------------- API pública ---------------------------- */

function prepare(sql) {
  return isD1() ? d1Prepare(sql) : classicPrepare(sql);
}

function exec(sql) {
  return isD1() ? d1Exec(sql) : classicExec(sql);
}

/**
 * Executa uma lista de statements de forma ATÔMICA.
 * D1: batch nativo (rollback de toda a lista em qualquer falha).
 * Clássico: better-sqlite3 transaction.
 */
function batch(stmts) {
  return isD1() ? d1Batch(stmts) : classicBatch(stmts);
}

/**
 * transaction(fn) — COMPATIBILIDADE DE TRANSIÇÃO (modo clássico apenas).
 *
 * Restam transações legadas com corpos de statements puros que ainda não
 * foram convertidas para batch(). No modo clássico delega para a transaction
 * nativa do better-sqlite3 (comportamento idêntico à V3.5.0). No modo D1
 * lança erro explícito — TODO Fase 2: converter os call sites restantes
 * (billing saveConfig/updateCharge/cancelCharge/pay, checklists create/
 * setItem, notifications markRead, payables createFromPurchase, receivables
 * createFromSale, purchases create/update, transfers create, tasks complete,
 * company branding save) para db.batch([...]).
 */
function transaction(fn) {
  if (isD1()) {
    throw new Error(
      'db.transaction() não existe no D1 — converter este call site para db.batch([...]) (Fase 2, lista em adapter.js).'
    );
  }
  return getClassicConnection().transaction(fn);
}

module.exports = { prepare, exec, batch, transaction, isD1 };
