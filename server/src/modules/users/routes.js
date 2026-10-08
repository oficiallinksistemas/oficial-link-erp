'use strict';

const express = require('express');
const { ok } = require('../../core/http');
const { pagination, reqString, reqEmail, reqPassword, optPassword, optString, optEnum, optInt } = require('../../core/validate');
const { requirePermission, tenantId } = require('../../middlewares/auth');
const { audit } = require('../../core/audit');
const service = require('./service');

const router = express.Router();

// Módulo exclusivo de tenants — o Master (company_id NULL) não acessa
router.use((req, res, next) => {
  if (tenantId(req) === null) {
    return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Módulo exclusivo de empresas.' } });
  }
  next();
});

router.use(requirePermission('users.view', 'users.manage'));

router.get('/', (req, res) => {
  const pg = pagination(req.query);
  const search = req.query.search ? String(req.query.search).slice(0, 80) : undefined;
  return ok(res, service.list(tenantId(req), { ...pg, search }));
});

router.post('/', requirePermission('users.manage'), async (req, res, next) => {
  try {
    const data = {
      name: reqString(req.body?.name, 'Nome', { min: 2, max: 120 }),
      email: reqEmail(req.body?.email),
      password: reqPassword(req.body?.password),
      roleSlug: reqString(req.body?.role_slug, 'Função', { max: 40 }),
      storeId: optInt(req.body?.store_id, 'Loja'),
    };
    const companyId = tenantId(req);
    const created = await service.create(companyId, data);
    audit({ req, companyId, userId: req.auth.user.id, action: 'user.create', entity: 'users', entityId: created.id, metadata: { email: created.email, role: created.role_slug } });
    return ok(res, created, 201);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    return ok(res, await service.getScoped(tenantId(req), Number(req.params.id)));
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', requirePermission('users.manage'), async (req, res, next) => {
  try {
    const data = {
      name: optString(req.body?.name, 'Nome', { min: 2, max: 120 }),
      roleSlug: optString(req.body?.role_slug, 'Função', { max: 40 }),
      storeId: req.body?.store_id === null ? null : optInt(req.body?.store_id, 'Loja'),
      status: optEnum(req.body?.status, 'Status', ['active', 'inactive']),
    };
    const companyId = tenantId(req);
    const updated = await service.update(companyId, Number(req.params.id), data, req.auth.user.id);
    audit({ req, companyId, userId: req.auth.user.id, action: 'user.update', entity: 'users', entityId: updated.id, metadata: { status: updated.status } });
    return ok(res, updated);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/reset-password', requirePermission('users.manage'), async (req, res, next) => {
  try {
    const newPassword = reqPassword(req.body?.password, 'Nova senha');
    const companyId = tenantId(req);
    const target = await service.resetPassword(companyId, Number(req.params.id), newPassword, req);
    audit({ req, companyId, userId: req.auth.user.id, action: 'user.reset_password', entity: 'users', entityId: target.id });
    return ok(res, { reset: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
