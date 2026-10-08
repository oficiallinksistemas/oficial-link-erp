'use strict';

const express = require('express');
const { ok } = require('../../core/http');
const { requirePermission, tenantId } = require('../../middlewares/auth');
const { requireModule } = require('../../core/modules');
const service = require('./service');

const router = express.Router();

router.use((req, res, next) => {
  if (tenantId(req) === null) return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Módulo exclusivo de empresas.' } });
  next();
});

router.get('/sales', requirePermission('reports.view'), async (req, res, next) => {
  try { return ok(res, await service.sales(tenantId(req), req.query)); } catch (err) { next(err); }
});
router.get('/products', requirePermission('reports.view'), async (req, res, next) => {
  try { return ok(res, await service.byProduct(tenantId(req), req.query)); } catch (err) { next(err); }
});
router.get('/stock', requirePermission('reports.view'), async (req, res, next) => {
  try { return ok(res, await service.stock(tenantId(req), req.query)); } catch (err) { next(err); }
});
router.get('/movements', requirePermission('reports.view'), async (req, res, next) => {
  try { return ok(res, await service.movements(tenantId(req), req.query)); } catch (err) { next(err); }
});
router.get('/purchases', requirePermission('reports.view'), async (req, res, next) => {
  try { return ok(res, await service.purchases(tenantId(req), req.query)); } catch (err) { next(err); }
});
router.get('/payables', requirePermission('reports.view'), async (req, res, next) => {
  try { return ok(res, await service.payables(tenantId(req), req.query)); } catch (err) { next(err); }
});
// Relatório EXCLUSIVO de Recebíveis também exige o módulo receivables ativo —
// um módulo não expõe dados de outro por rota indireta.
router.get('/receivables', requirePermission('reports.view'), requireModule('receivables'), async (req, res, next) => {
  try { return ok(res, await service.receivables(tenantId(req), req.query)); } catch (err) { next(err); }
});

module.exports = router;
