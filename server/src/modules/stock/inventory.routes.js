'use strict';

const express = require('express');
const { ok } = require('../../core/http');
const { pagination, optInt } = require('../../core/validate');
const { requirePermission, tenantId } = require('../../middlewares/auth');
const { audit } = require('../../core/audit');
const service = require('./inventory.service');

const router = express.Router();

router.use((req, res, next) => {
  if (tenantId(req) === null) return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Módulo exclusivo de empresas.' } });
  next();
});

router.get('/', requirePermission('stock.view'), async (req, res, next) => {
  try {
    const pg = pagination(req.query);
    return ok(res, await service.list(tenantId(req), {
      ...pg,
      store_id: optInt(req.query.store_id, 'Loja'),
      status: req.query.status ? String(req.query.status).slice(0, 10) : undefined,
    }));
  } catch (err) { next(err); }
});

router.post('/', requirePermission('stock.adjust'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const s = await service.open(companyId, req.auth.user.id, req.body || {});
    audit({ req, companyId, userId: req.auth.user.id, action: 'inventory.open', entity: 'inventory_sessions', entityId: s.id });
    return ok(res, s, 201);
  } catch (err) { next(err); }
});

router.get('/:id', requirePermission('stock.view'), async (req, res, next) => {
  try { return ok(res, await service.detail(tenantId(req), optInt(req.params.id, 'ID'))); } catch (err) { next(err); }
});

router.post('/:id/count', requirePermission('stock.adjust'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const s = await service.count(companyId, optInt(req.params.id, 'ID'), req.body || {});
    return ok(res, s);
  } catch (err) { next(err); }
});

router.post('/:id/finalize', requirePermission('stock.adjust'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const s = await service.finalize(companyId, optInt(req.params.id, 'ID'), req.auth.user.id);
    audit({ req, companyId, userId: req.auth.user.id, action: 'inventory.finalize', entity: 'inventory_sessions', entityId: s.id, metadata: { store: s.store_name, items: s.items.length } });
    return ok(res, s);
  } catch (err) { next(err); }
});

router.post('/:id/cancel', requirePermission('stock.adjust'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const s = await service.cancel(companyId, optInt(req.params.id, 'ID'), req.body?.reason, req.auth.user.id);
    return ok(res, s);
  } catch (err) { next(err); }
});

module.exports = router;
