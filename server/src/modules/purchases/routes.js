'use strict';

const express = require('express');
const db = require('../../database/connection');
const { ok } = require('../../core/http');
const { pagination, optInt, optString } = require('../../core/validate');
const { requirePermission, tenantId } = require('../../middlewares/auth');
const { audit } = require('../../core/audit');
const service = require('./service');

const router = express.Router();

router.use((req, res, next) => {
  if (tenantId(req) === null) return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Módulo exclusivo de empresas.' } });
  next();
});

router.get('/', requirePermission('purchases.view'), async (req, res) => {
  const pg = pagination(req.query);
  return ok(res, await service.list(tenantId(req), {
    ...pg,
    status: req.query.status ? String(req.query.status).slice(0, 10) : undefined,
    store_id: optInt(req.query.store_id, 'Loja'),
    supplier_id: optInt(req.query.supplier_id, 'Fornecedor'),
    from: req.query.from ? String(req.query.from).slice(0, 10) : undefined,
    to: req.query.to ? String(req.query.to).slice(0, 10) : undefined,
  }));
});

router.post('/', requirePermission('purchases.create'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const p = await service.create(companyId, req.auth.user.id, req.body || {});
    audit({ req, companyId, userId: req.auth.user.id, action: 'purchase.create', entity: 'purchases', entityId: p.id, metadata: { total_cents: p.total_cents, items: p.items.length } });
    return ok(res, p, 201);
  } catch (err) { next(err); }
});

router.get('/:id', requirePermission('purchases.view'), async (req, res, next) => {
  try { return ok(res, await service.getScoped(tenantId(req), optInt(req.params.id, 'ID'))); } catch (err) { next(err); }
});

router.patch('/:id', requirePermission('purchases.edit'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const p = await service.update(companyId, optInt(req.params.id, 'ID'), req.body || {});
    audit({ req, companyId, userId: req.auth.user.id, action: 'purchase.update', entity: 'purchases', entityId: p.id });
    return ok(res, p);
  } catch (err) { next(err); }
});

router.post('/:id/receive', requirePermission('purchases.receive'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const p = await service.receive(companyId, optInt(req.params.id, 'ID'), req.auth.user.id);
    audit({ req, companyId, userId: req.auth.user.id, action: 'purchase.receive', entity: 'purchases', entityId: p.id, metadata: { total_cents: p.total_cents } });
    return ok(res, p);
  } catch (err) { next(err); }
});

router.post('/:id/cancel', requirePermission('purchases.cancel'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const id = optInt(req.params.id, 'ID');
    // título vinculado (para auditoria coerente quando o cancelamento o
    // acompanhar automaticamente)
    const linked = await db.prepare('SELECT id, status FROM accounts_payable WHERE company_id = ? AND purchase_id = ?').get(companyId, id);
    const p = await service.cancel(companyId, id, req.body?.reason, req.auth.user.id);
    audit({ req, companyId, userId: req.auth.user.id, action: 'purchase.cancel', entity: 'purchases', entityId: p.id, metadata: { status: p.status } });
    if (linked && linked.status === 'open' && p.status === 'canceled') {
      audit({ req, companyId, userId: req.auth.user.id, action: 'payable.cancel', entity: 'accounts_payable', entityId: linked.id, metadata: { reason: `Cancelado em consequência do cancelamento da compra #${id}` } });
    }
    return ok(res, p);
  } catch (err) { next(err); }
});

module.exports = router;
