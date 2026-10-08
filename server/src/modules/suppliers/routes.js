'use strict';

const express = require('express');
const { ok } = require('../../core/http');
const { pagination, optInt } = require('../../core/validate');
const { requirePermission, tenantId } = require('../../middlewares/auth');
const { audit } = require('../../core/audit');
const service = require('./service');

const router = express.Router();

router.use((req, res, next) => {
  if (tenantId(req) === null) return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Módulo exclusivo de empresas.' } });
  next();
});

router.get('/', requirePermission('suppliers.view'), async (req, res) => {
  const pg = pagination(req.query);
  const search = req.query.search ? String(req.query.search).slice(0, 80) : undefined;
  const status = req.query.status === 'active' || req.query.status === 'inactive' ? req.query.status : undefined;
  return ok(res, await service.list(tenantId(req), { ...pg, search, status }));
});

router.post('/', requirePermission('suppliers.create'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const s = await service.create(companyId, req.body || {});
    audit({ req, companyId, userId: req.auth.user.id, action: 'supplier.create', entity: 'suppliers', entityId: s.id, metadata: { name: s.name } });
    return ok(res, s, 201);
  } catch (err) { next(err); }
});

router.get('/:id', requirePermission('suppliers.view'), async (req, res, next) => {
  try { return ok(res, await service.getScoped(tenantId(req), optInt(req.params.id, 'ID'))); } catch (err) { next(err); }
});

router.patch('/:id', requirePermission('suppliers.edit'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const s = await service.update(companyId, optInt(req.params.id, 'ID'), req.body || {});
    audit({ req, companyId, userId: req.auth.user.id, action: 'supplier.update', entity: 'suppliers', entityId: s.id, metadata: { status: s.status } });
    return ok(res, s);
  } catch (err) { next(err); }
});

router.delete('/:id', requirePermission('suppliers.delete'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const s = await service.remove(companyId, optInt(req.params.id, 'ID'));
    audit({ req, companyId, userId: req.auth.user.id, action: 'supplier.delete', entity: 'suppliers', entityId: s.id, metadata: { name: s.name } });
    return ok(res, { deleted: true });
  } catch (err) { next(err); }
});

module.exports = router;
