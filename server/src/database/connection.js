'use strict';

/**
 * Ponto oficial de acesso ao banco — AGORA É O ADAPTER DUAL.
 *
 *   Cloudflare Workers (produção/dev via wrangler): backend D1 (binding env.DB).
 *   Node.js clássico (testes/dev local): backend better-sqlite3.
 *
 * Todo o código de negócio usa `db.prepare(...).get/all/run` await-ed;
 * a escolha do backend é transparente e acontece uma única vez por isolate.
 *
 * Migrations/seed continuam existindo apenas no modo clássico (boot do
 * Node); no Worker elas são etapas de deploy:
 *   wrangler d1 migrations apply / wrangler d1 execute --file=bootstrap.sql
 */

const adapter = require('./adapter');

module.exports = adapter;
