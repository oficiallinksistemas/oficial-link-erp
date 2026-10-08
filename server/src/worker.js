/**
 * Entry point do Cloudflare Worker — formato ES Module (required para
 * cloudflare:node / cloudflare:workers / nodejs_compat no bundle).
 *
 * Express oficialmente suportado via cloudflare:node httpServerHandler
 * (compatibility_date >= 2025-08-15):
 *
 *   import { httpServerHandler } from 'cloudflare:node';
 *   app.listen(port);
 *   export default httpServerHandler({ port });
 *
 * - app.js é o MESMO da V3.5.0 (CJS) — esbuild resolve o interop
 *   module.exports → default import.
 * - Banco via adapter dual (D1 em produção; better-sqlite3 no Node clássico).
 * - Frontend: Workers Static Assets (wrangler.toml [assets]); somente /api/*
 *   executa este Worker (run_worker_first).
 * - Migrations/seed NÃO rodam aqui: etapas de deploy (wrangler d1 ...).
 */

import { httpServerHandler } from 'cloudflare:node';
import app from './app.js';

const PORT = 3000;
app.listen(PORT);

export default httpServerHandler({ port: PORT });
