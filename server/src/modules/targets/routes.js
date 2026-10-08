'use strict';

/**
 * Módulo METAS — rotas (mesmo padrão do módulo Vendas).
 * Mount em app.js: authenticate → requireModule('targets') → permissão → escopo.
 */

const express = require('express');
const { ok } = require('../../core/http');
const { pagination, optInt } = require('../../core/validate');
const { requirePermission, tenantId } = require('../../middlewares/auth');
const { audit } = require('../../core/audit');
const service = require('./service');

const router = express.Router();

// Módulo exclusivo de tenants — o Master administra via plataforma
router.use((req, res, next) => {
  if (tenantId(req) === null) {
    return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Módulo exclusivo de empresas.' } });
  }
  next();
});

router.get('/', requirePermission('targets.view'), async (req, res) => {
  const pg = pagination(req.query);
  const data = await service.list(tenantId(req), {
    ...pg,
    type: req.query.type === 'seller' || req.query.type === 'store' ? req.query.type : undefined,
    user_id: optInt(req.query.user_id, 'Vendedor'),
    store_id: optInt(req.query.store_id, 'Loja'),
    from: req.query.from ? String(req.query.from).slice(0, 10) : undefined,
    to: req.query.to ? String(req.query.to).slice(0, 10) : undefined,
  });
  return ok(res, data);
});

router.post('/', requirePermission('targets.create'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const target = await service.create(companyId, req.auth.user.id, req.body || {});
    audit({ req, companyId, userId: req.auth.user.id, action: 'target.create', entity: 'targets', entityId: target.id, metadata: { type: target.type, target_cents: target.target_cents, start: target.start_date, end: target.end_date } });
    return ok(res, target, 201);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requirePermission('targets.view'), async (req, res, next) => {
  try {
    return ok(res, await service.getScoped(tenantId(req), optInt(req.params.id, 'ID')));
  } catch (err) {
    next(err);
  }
});

router.get('/:id/performance', requirePermission('targets.view'), async (req, res, next) => {
  try {
    return ok(res, await service.performance(tenantId(req), optInt(req.params.id, 'ID')));
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', requirePermission('targets.edit'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const target = await service.update(companyId, optInt(req.params.id, 'ID'), req.body || {});
    audit({ req, companyId, userId: req.auth.user.id, action: 'target.update', entity: 'targets', entityId: target.id, metadata: { target_cents: target.target_cents } });
    return ok(res, target);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requirePermission('targets.delete'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const target = await service.remove(companyId, optInt(req.params.id, 'ID'));
    audit({ req, companyId, userId: req.auth.user.id, action: 'target.delete', entity: 'targets', entityId: target.id, metadata: { type: target.type } });
    return ok(res, { deleted: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
