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

router.get('/', requirePermission('receivables.view'), async (req, res, next) => {
  try {
    const pg = pagination(req.query);
    const data = await service.list(tenantId(req), {
      ...pg,
      status: req.query.status ? String(req.query.status).slice(0, 10) : undefined,
      customer_id: optInt(req.query.customer_id, 'Cliente'),
      store_id: optInt(req.query.store_id, 'Loja'),
      sale_id: optInt(req.query.sale_id, 'Venda'),
      due_from: req.query.due_from ? String(req.query.due_from).slice(0, 10) : undefined,
      due_to: req.query.due_to ? String(req.query.due_to).slice(0, 10) : undefined,
      search: req.query.search ? String(req.query.search).slice(0, 80) : undefined,
    });
    return ok(res, { ...data, summary: await service.summary(tenantId(req)) });
  } catch (err) { next(err); }
});

router.get('/summary', requirePermission('receivables.view'), async (req, res) => {
  return ok(res, await service.summary(tenantId(req)));
});

router.post('/', requirePermission('receivables.create'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const t = await service.create(companyId, req.auth.user.id, req.body || {});
    audit({ req, companyId, userId: req.auth.user.id, action: 'receivable.create', entity: 'accounts_receivable', entityId: t.id, metadata: { origin: t.origin, amount_cents: t.amount_cents, sale_id: t.sale_id } });
    return ok(res, t, 201);
  } catch (err) { next(err); }
});

router.get('/:id', requirePermission('receivables.view'), async (req, res, next) => {
  try { return ok(res, await service.getScoped(tenantId(req), optInt(req.params.id, 'ID'))); } catch (err) { next(err); }
});

router.patch('/:id', requirePermission('receivables.update'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const t = await service.update(companyId, optInt(req.params.id, 'ID'), req.auth.user.id, req.body || {});
    audit({ req, companyId, userId: req.auth.user.id, action: 'receivable.update', entity: 'accounts_receivable', entityId: t.id });
    return ok(res, t);
  } catch (err) { next(err); }
});

router.post('/:id/receive', requirePermission('receivables.receive'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const t = await service.receive(companyId, optInt(req.params.id, 'ID'), req.auth.user.id);
    audit({ req, companyId, userId: req.auth.user.id, action: 'receivable.receive', entity: 'accounts_receivable', entityId: t.id, metadata: { amount_cents: t.received_amount_cents } });
    return ok(res, t);
  } catch (err) { next(err); }
});

router.post('/:id/cancel', requirePermission('receivables.cancel'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const t = await service.cancel(companyId, optInt(req.params.id, 'ID'), req.auth.user.id);
    audit({ req, companyId, userId: req.auth.user.id, action: 'receivable.cancel', entity: 'accounts_receivable', entityId: t.id, metadata: { reason: req.body?.reason } });
    return ok(res, t);
  } catch (err) { next(err); }
});

router.delete('/:id', requirePermission('receivables.delete'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const t = await service.remove(companyId, optInt(req.params.id, 'ID'));
    audit({ req, companyId, userId: req.auth.user.id, action: 'receivable.delete', entity: 'accounts_receivable', entityId: t.id, metadata: { description: t.description } });
    return ok(res, { deleted: true });
  } catch (err) { next(err); }
});

module.exports = router;
