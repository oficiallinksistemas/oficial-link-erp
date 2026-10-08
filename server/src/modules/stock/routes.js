'use strict';

/**
 * Módulo ESTOQUE — rotas (padrão V1.2+: tenant only → permissão → escopo).
 */

const express = require('express');
const { ok } = require('../../core/http');
const { pagination, optInt } = require('../../core/validate');
const { requirePermission, tenantId } = require('../../middlewares/auth');
const { audit } = require('../../core/audit');
const service = require('./service');

const router = express.Router();

router.use((req, res, next) => {
  if (tenantId(req) === null) {
    return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Módulo exclusivo de empresas.' } });
  }
  next();
});

router.get('/', requirePermission('stock.view'), async (req, res, next) => {
  try {
    const pg = pagination(req.query);
    const data = await service.listBalances(tenantId(req), {
      ...pg,
      store_id: optInt(req.query.store_id, 'Loja'),
      search: req.query.search ? String(req.query.search).slice(0, 80) : undefined,
      category_id: optInt(req.query.category_id, 'Categoria'),
      low: req.query.low === '1' ? '1' : undefined,
      zero: req.query.zero === '1' ? '1' : undefined,
      status: req.query.status === 'active' || req.query.status === 'inactive' ? req.query.status : undefined,
    });
    const storeId = optInt(req.query.store_id, 'Loja');
    return ok(res, { ...data, summary: await service.summary(tenantId(req), storeId || null) });
  } catch (err) {
    next(err);
  }
});

router.get('/movements', requirePermission('stock.view'), async (req, res, next) => {
  try {
    const pg = pagination(req.query);
    const data = await service.listMovements(tenantId(req), {
      ...pg,
      store_id: optInt(req.query.store_id, 'Loja'),
      product_id: optInt(req.query.product_id, 'Produto'),
      type: req.query.type ? String(req.query.type).slice(0, 20).toUpperCase() : undefined,
      from: req.query.from ? String(req.query.from).slice(0, 10) : undefined,
      to: req.query.to ? String(req.query.to).slice(0, 10) : undefined,
    });
    return ok(res, data);
  } catch (err) {
    next(err);
  }
});

function manualRoute(action, permission, auditAction) {
  return async (req, res, next) => {
    try {
      const companyId = tenantId(req);
      const result = await service[action](companyId, req.auth.user.id, req.body || {});
      audit({
        req, companyId, userId: req.auth.user.id, action: auditAction,
        entity: 'stock_movements', metadata: { product: result.product, quantity: result.after - result.before, balance_after: result.after },
      });
      return ok(res, result);
    } catch (err) {
      next(err);
    }
  };
}

router.post('/entry', requirePermission('stock.move'),  manualRoute('entry', 'stock.move', 'stock.entry'));
router.post('/exit', requirePermission('stock.move'),  manualRoute('exit', 'stock.move', 'stock.exit'));
router.post('/adjust', requirePermission('stock.adjust'),  manualRoute('adjust', 'stock.adjust', 'stock.adjust'));

module.exports = router;
