'use strict';

/**
 * AGENDA — rotas (v3.4). company_id SEMPRE da sessão.
 */

const express = require('express');
const { ok } = require('../../core/http');
const { optEnum, optString, reqInt, reqString } = require('../../core/validate');
const { notFound } = require('../../core/errors');
const { requirePermission } = require('../../middlewares/auth');
const { audit } = require('../../core/audit');
const svc = require('./service');

const router = express.Router();
const VIEW = [requirePermission('agenda.view')];
const CREATE = [requirePermission('agenda.create')];
const EDIT = [requirePermission('agenda.edit')];
const DELETE = [requirePermission('agenda.delete')];

router.get('/', ...VIEW, async (req, res, next) => {
  try {
    const data = await svc.list(req.auth.user.companyId, {
      from: optString(req.query.from, 'De', { max: 10 }),
      to: optString(req.query.to, 'Até', { max: 10 }),
      status: optEnum(req.query.status, 'Status', svc.STATUSES),
      responsible: req.query.responsible ? reqInt(req.query.responsible, 'Responsável') : undefined,
    });
    return ok(res, data);
  } catch (err) { next(err); }
});

router.get('/:id', ...VIEW, async (req, res, next) => {
  try {
    const id = reqInt(req.params.id, 'ID');
    const e = await svc.getEvent(req.auth.user.companyId, id);
    if (!e) throw notFound('Compromisso não encontrado.');
    return ok(res, e);
  } catch (err) { next(err); }
});

router.post('/', ...CREATE, async (req, res, next) => {
  try {
    reqString(req.body?.title, 'Título', { min: 3, max: 120 });
    const e = await svc.create(req.auth.user.companyId, req.body || {}, req.auth.user.id);
    audit({
      req, companyId: req.auth.user.companyId, userId: req.auth.user.id,
      action: 'agenda.create', entity: 'agenda_events', entityId: e.id,
      metadata: { title: e.title, start_at: e.start_at },
    });
    return ok(res, e, 201);
  } catch (err) { next(err); }
});

router.patch('/:id', ...EDIT, async (req, res, next) => {
  try {
    const id = reqInt(req.params.id, 'ID');
    const e = await svc.update(req.auth.user.companyId, id, req.body || {}, req.auth.user.id);
    audit({
      req, companyId: req.auth.user.companyId, userId: req.auth.user.id,
      action: 'agenda.update', entity: 'agenda_events', entityId: e.id,
      metadata: { title: e.title, start_at: e.start_at },
    });
    return ok(res, e);
  } catch (err) { next(err); }
});

router.post('/:id/complete', ...EDIT, async (req, res, next) => {
  try {
    const id = reqInt(req.params.id, 'ID');
    const e = await svc.complete(req.auth.user.companyId, id, req.auth.user.id);
    audit({
      req, companyId: req.auth.user.companyId, userId: req.auth.user.id,
      action: 'agenda.complete', entity: 'agenda_events', entityId: e.id,
      metadata: { title: e.title },
    });
    return ok(res, e);
  } catch (err) { next(err); }
});

router.post('/:id/cancel', ...DELETE, async (req, res, next) => {
  try {
    const id = reqInt(req.params.id, 'ID');
    const e = await svc.cancel(req.auth.user.companyId, id);
    audit({
      req, companyId: req.auth.user.companyId, userId: req.auth.user.id,
      action: 'agenda.cancel', entity: 'agenda_events', entityId: e.id,
      metadata: { title: e.title },
    });
    return ok(res, e);
  } catch (err) { next(err); }
});

router.delete('/:id', ...DELETE, async (req, res, next) => {
  try {
    const id = reqInt(req.params.id, 'ID');
    await svc.remove(req.auth.user.companyId, id);
    audit({
      req, companyId: req.auth.user.companyId, userId: req.auth.user.id,
      action: 'agenda.delete', entity: 'agenda_events', entityId: id,
    });
    return ok(res, { deleted: true });
  } catch (err) { next(err); }
});

module.exports = router;
