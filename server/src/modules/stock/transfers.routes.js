'use strict';

const express = require('express');
const { ok } = require('../../core/http');
const { pagination, optInt } = require('../../core/validate');
const { requirePermission, tenantId } = require('../../middlewares/auth');
const { audit } = require('../../core/audit');
const service = require('./transfers.service');

const router = express.Router();

router.use((req, res, next) => {
  if (tenantId(req) === null) return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Módulo exclusivo de empresas.' } });
  next();
});

router.get('/', requirePermission('stock.view'), async (req, res) => {
  const pg = pagination(req.query);
  const status = req.query.status ? String(req.query.status).slice(0, 10) : undefined;
  return ok(res, await service.list(tenantId(req), { ...pg, status }));
});

router.post('/', requirePermission('stock.move'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const t = await service.create(companyId, req.auth.user.id, req.body || {});
    audit({ req, companyId, userId: req.auth.user.id, action: 'transfer.create', entity: 'stock_transfers', entityId: t.id });
    return ok(res, t, 201);
  } catch (err) { next(err); }
});

router.get('/:id', requirePermission('stock.view'), async (req, res, next) => {
  try { return ok(res, await service.getScoped(tenantId(req), optInt(req.params.id, 'ID'))); } catch (err) { next(err); }
});

router.post('/:id/complete', requirePermission('stock.move'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const t = await service.complete(companyId, optInt(req.params.id, 'ID'), req.auth.user.id);
    audit({ req, companyId, userId: req.auth.user.id, action: 'transfer.complete', entity: 'stock_transfers', entityId: t.id });
    return ok(res, t);
  } catch (err) { next(err); }
});

router.post('/:id/cancel', requirePermission('stock.move'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const t = await service.cancel(companyId, optInt(req.params.id, 'ID'), req.body?.reason, req.auth.user.id);
    audit({ req, companyId, userId: req.auth.user.id, action: 'transfer.cancel', entity: 'stock_transfers', entityId: t.id });
    return ok(res, t);
  } catch (err) { next(err); }
});

module.exports = router;
