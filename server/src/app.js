'use strict';

/**
 * Oficial Link ERP — aplicação Express (API + frontend estático).
 * Este módulo EXPORTA o app configurado, sem escutar porta — permite
 * que testes automatizados subam o servidor em porta efêmera.
 * O entrypoint real é index.js.
 */

const path = require('path');
const express = require('express');

const config = require('./config');
const adapter = require('./database/connection'); // adapter dual (D1 no Worker)
if (!adapter.isD1()) {
  // Migrations/seed rodam apenas no modo clássico (Node). No Worker são
  // etapas de deploy: wrangler d1 migrations apply / wrangler d1 execute.
  require('./database/migrations').runMigrations();
}
const { seedIfEmpty } = require('./database/seed');
const { parseCookies } = require('./core/http');
const { createRateLimiter } = require('./core/rateLimit');
const { csrfOriginProtection } = require('./core/csrf');
const { ApiError } = require('./core/errors');
const { authenticate } = require('./middlewares/auth');

const authModule = require('./modules/auth/routes');
const platformRoutes = require('./modules/platform/routes');
const companyRoutes = require('./modules/company/routes');
const storeRoutes = require('./modules/stores/routes');
const userRoutes = require('./modules/users/routes');
const roleRoutes = require('./modules/roles/routes');
const dashboardRoutes = require('./modules/dashboard/routes');

seedIfEmpty();

const app = express();
app.disable('x-powered-by');
// Proxy confiável configurável via TRUST_PROXY (nunca via valor do cliente).
// Prod sem proxy reverso: false → X-Forwarded-For é ignorado (anti-falsificação
// de IP em rate limit e auditoria). Dev/test: 1 (loopback).
app.set('trust proxy', config.trustProxy);

// ---- Headers de segurança ---------------------------------------------------
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'self'; " +
      "form-action 'self'; frame-ancestors 'none'",
  });
  // HSTS só faz sentido quando o cookie já é Secure (produção com HTTPS)
  if (config.secureCookies) {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// ---- Parsing ----------------------------------------------------------------
app.use(express.json({ limit: '256kb' }));
app.use((req, res, next) => {
  req.cookies = parseCookies(req);
  next();
});

// ---- Rate limiting global da API --------------------------------------------
app.use('/api', createRateLimiter({ windowMs: 60 * 1000, max: 600 }));

// ---- Proteção CSRF / Origin (requisições que alteram dados) ------------------
app.use('/api', csrfOriginProtection);

// ---- Rotas da API -----------------------------------------------------------
app.use('/api/auth', authModule.router);
app.use('/api/platform', authenticate, platformRoutes);
app.use('/api/company', authenticate, companyRoutes);
app.use('/api/stores', authenticate, storeRoutes);
app.use('/api/users', authenticate, userRoutes);
app.use('/api/roles', authenticate, roleRoutes);
app.use('/api/dashboard', authenticate, dashboardRoutes);

// ---- Arquitetura modular (v1.2): módulos oficiais ativos por empresa ----
const { requireModule, modulesForCompany } = require('./core/modules');
const salesRoutes = require('./modules/sales/routes');
const customersRoutes = require('./modules/customers/routes');
const targetsRoutes = require('./modules/targets/routes');
const rankingRoutes = require('./modules/ranking/routes');
const productsRoutes = require('./modules/products/routes');
const stockRoutes = require('./modules/stock/routes');
const suppliersRoutes = require('./modules/suppliers/routes');
const purchasesRoutes = require('./modules/purchases/routes');
const transfersRoutes = require('./modules/stock/transfers.routes');
const inventoryRoutes = require('./modules/stock/inventory.routes');
const reportsRoutes = require('./modules/reports/routes');
const payablesRoutes = require('./modules/payables/routes');
const receivablesRoutes = require('./modules/receivables/routes');

app.get('/api/modules', authenticate, async (req, res) => {
  if (req.auth.user.companyId === null) {
    return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Módulos são gerenciados por empresa.' } });
  }
  return res.json({ ok: true, data: await modulesForCompany(req.auth.user.companyId) });
});
// Todas as rotas de negócio: sessão → módulo ativo no tenant → permissão → escopo
app.use('/api/sales', authenticate, requireModule('sales'), salesRoutes);
// V1.5: /api/customers passa a ser do módulo Clientes próprio (não mais do Sales)
app.use('/api/customers', authenticate, requireModule('customers'), customersRoutes);
app.use('/api/targets', authenticate, requireModule('targets'), targetsRoutes);
app.use('/api/ranking', authenticate, requireModule('ranking'), rankingRoutes);
app.use('/api/products', authenticate, requireModule('products'), productsRoutes);
app.use('/api/stock', authenticate, requireModule('stock'), stockRoutes);
app.use('/api/stock/transfers', authenticate, requireModule('stock'), transfersRoutes);
app.use('/api/stock/inventory', authenticate, requireModule('stock'), inventoryRoutes);
app.use('/api/suppliers', authenticate, requireModule('suppliers'), suppliersRoutes);
app.use('/api/purchases', authenticate, requireModule('purchases'), purchasesRoutes);
app.use('/api/reports', authenticate, requireModule('reports'), reportsRoutes);
app.use('/api/payables', authenticate, requireModule('payables'), payablesRoutes);
app.use('/api/receivables', authenticate, requireModule('receivables'), receivablesRoutes);

// ---- Camada operacional V1 (v3.4): módulos independentes, gating obrigatório
app.use('/api/tasks', authenticate, requireModule('tasks'), require('./modules/tasks/routes'));
app.use('/api/agenda', authenticate, requireModule('agenda'), require('./modules/agenda/routes'));
app.use('/api/checklists', authenticate, requireModule('checklists'), require('./modules/checklists/routes'));
app.use('/api/notifications', authenticate, requireModule('notifications'), require('./modules/notifications/routes'));

app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Endpoint não encontrado.' } });
});

// ---- Tratamento de erros (nunca expõe stack/servidor) -----------------------
// eslint-disable-next-line no-unused-vars
app.use('/api', (err, req, res, next) => {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ ok: false, error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: { code: 'BAD_JSON', message: 'Corpo da requisição inválido.' } });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'Requisição muito grande.' } });
  }
  console.error('[erro] %s %s →', req.method, req.originalUrl, err);
  return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Erro interno. Tente novamente.' } });
});

// ---- Frontend estático ------------------------------------------------------
const webDir = path.join(__dirname, '..', '..', 'web');
app.use(express.static(webDir, { index: false, maxAge: '1d', setHeaders: (res, filePath) => {
  if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
} }));

app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(webDir, 'index.html'));
});

module.exports = app;
