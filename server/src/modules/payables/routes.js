'use strict';

const express = require('express');
const { ok } = require('../../core/http');
const { pagination, optInt, optString, reqString } = require('../../core/validate');
const { requirePermission, tenantId } = require('../../middlewares/auth');
const { audit } = require('../../core/audit');
const service = require('./service');

const router = express.Router();

router.use((req, res, next) => {
  if (tenantId(req) === null) return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Módulo exclusivo de empresas.' } });
  next();
});

router.get('/', requirePermission('payables.view'), async (req, res, next) => {
  try {
    const pg = pagination(req.query);
    const data = await service.list(tenantId(req), {
      ...pg,
      status: req.query.status ? String(req.query.status).slice(0, 10) : undefined,
      supplier_id: optInt(req.query.supplier_id, 'Fornecedor'),
      store_id: optInt(req.query.store_id, 'Loja'),
      purchase_id: optInt(req.query.purchase_id, 'Compra'),
      due_from: req.query.due_from ? String(req.query.due_from).slice(0, 10) : undefined,
      due_to: req.query.due_to ? String(req.query.due_to).slice(0, 10) : undefined,
      search: req.query.search ? String(req.query.search).slice(0, 80) : undefined,
    });
    return ok(res, { ...data, summary: await service.summary(tenantId(req)) });
  } catch (err) { next(err); }
});

router.get('/summary', requirePermission('payables.view'), async (req, res) => {
  return ok(res, await service.summary(tenantId(req)));
});

router.post('/', requirePermission('payables.create'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const t = await service.create(companyId, req.auth.user.id, req.body || {});
    audit({ req, companyId, userId: req.auth.user.id, action: 'payable.create', entity: 'accounts_payable', entityId: t.id, metadata: { amount_cents: t.amount_cents, due: t.due_date } });
    return ok(res, t, 201);
  } catch (err) { next(err); }
});

router.get('/:id', requirePermission('payables.view'), async (req, res, next) => {
  try { return ok(res, await service.getScoped(tenantId(req), optInt(req.params.id, 'ID'))); } catch (err) { next(err); }
});

router.patch('/:id', requirePermission('payables.update'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const t = await service.update(companyId, optInt(req.params.id, 'ID'), req.auth.user.id, req.body || {});
    audit({ req, companyId, userId: req.auth.user.id, action: 'payable.update', entity: 'accounts_payable', entityId: t.id });
    return ok(res, t);
  } catch (err) { next(err); }
});

router.post('/:id/pay', requirePermission('payables.pay'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const t = await service.pay(companyId, optInt(req.params.id, 'ID'), req.auth.user.id);
    audit({ req, companyId, userId: req.auth.user.id, action: 'payable.pay', entity: 'accounts_payable', entityId: t.id, metadata: { amount_cents: t.paid_amount_cents } });
    return ok(res, t);
  } catch (err) { next(err); }
});

router.post('/:id/cancel', requirePermission('payables.cancel'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const t = await service.cancel(companyId, optInt(req.params.id, 'ID'), req.body?.reason, req.auth.user.id);
    audit({ req, companyId, userId: req.auth.user.id, action: 'payable.cancel', entity: 'accounts_payable', entityId: t.id, metadata: { reason: req.body?.reason } });
    return ok(res, t);
  } catch (err) { next(err); }
});

router.delete('/:id', requirePermission('payables.delete'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const t = await service.remove(companyId, optInt(req.params.id, 'ID'));
    audit({ req, companyId, userId: req.auth.user.id, action: 'payable.delete', entity: 'accounts_payable', entityId: t.id, metadata: { description: t.description } });
    return ok(res, { deleted: true });
  } catch (err) { next(err); }
});

module.exports = router;
