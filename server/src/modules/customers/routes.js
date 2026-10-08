'use strict';

/**
 * Módulo CLIENTES — rotas (padrão V1.2+: tenant only → permissão → escopo).
 * Mount em app.js: authenticate → requireModule('customers') → este router.
 */

const express = require('express');
const { ok } = require('../../core/http');
const { pagination, optInt, optString } = require('../../core/validate');
const { requirePermission, tenantId } = require('../../middlewares/auth');
const { audit } = require('../../core/audit');
const service = require('./service');

const router = express.Router();

// Módulo exclusivo de tenants — o Master administra pela plataforma
router.use((req, res, next) => {
  if (tenantId(req) === null) {
    return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Módulo exclusivo de empresas.' } });
  }
  next();
});

router.get('/', requirePermission('customers.view'), async (req, res) => {
  const pg = pagination(req.query);
  const search = req.query.search ? String(req.query.search).slice(0, 80) : undefined;
  const status = req.query.status === 'active' || req.query.status === 'inactive' ? req.query.status : undefined;
  return ok(res, await service.list(tenantId(req), { ...pg, search, status }));
});

router.post('/', requirePermission('customers.create'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const customer = await service.create(companyId, req.body || {});
    audit({ req, companyId, userId: req.auth.user.id, action: 'customer.create', entity: 'customers', entityId: customer.id, metadata: { name: customer.name } });
    return ok(res, customer, 201);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requirePermission('customers.view'), async (req, res, next) => {
  try {
    return ok(res, await service.detail(tenantId(req), optInt(req.params.id, 'ID')));
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', requirePermission('customers.edit'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const customer = await service.update(companyId, optInt(req.params.id, 'ID'), req.body || {});
    audit({ req, companyId, userId: req.auth.user.id, action: 'customer.update', entity: 'customers', entityId: customer.id, metadata: { status: customer.status } });
    return ok(res, customer);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requirePermission('customers.delete'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const customer = await service.remove(companyId, optInt(req.params.id, 'ID'));
    audit({ req, companyId, userId: req.auth.user.id, action: 'customer.delete', entity: 'customers', entityId: customer.id, metadata: { name: customer.name } });
    return ok(res, { deleted: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
