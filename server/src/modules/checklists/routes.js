'use strict';

/**
 * CHECKLISTS — rotas (v3.4). company_id SEMPRE da sessão.
 */

const express = require('express');
const { ok } = require('../../core/http');
const { pagination, reqString, optEnum, optString, reqInt } = require('../../core/validate');
const { notFound } = require('../../core/errors');
const { requirePermission } = require('../../middlewares/auth');
const { audit } = require('../../core/audit');
const svc = require('./service');

const router = express.Router();
const VIEW = [requirePermission('checklists.view')];
const CREATE = [requirePermission('checklists.create')];
const EDIT = [requirePermission('checklists.edit')];
const DELETE = [requirePermission('checklists.delete')];
const COMPLETE = [requirePermission('checklists.complete')];

router.get('/', ...VIEW, async (req, res, next) => {
  try {
    const pg = pagination(req.query);
    const data = await svc.list(req.auth.user.companyId, {
      search: optString(req.query.search, 'Busca', { max: 80 }),
      status: optEnum(req.query.status, 'Status', svc.STATUSES),
      assigned_to: req.query.assigned_to ? reqInt(req.query.assigned_to, 'Responsável') : undefined,
      page: pg.page,
      perPage: pg.perPage,
    });
    return ok(res, data);
  } catch (err) { next(err); }
});

router.get('/:id', ...VIEW, async (req, res, next) => {
  try {
    const id = reqInt(req.params.id, 'ID');
    return ok(res, await svc.getWithItems(req.auth.user.companyId, id));
  } catch (err) { next(err); }
});

router.post('/', ...CREATE, async (req, res, next) => {
  try {
    reqString(req.body?.title, 'Título', { min: 3, max: 120 });
    const cl = await svc.create(req.auth.user.companyId, req.body || {}, req.auth.user.id);
    audit({
      req, companyId: req.auth.user.companyId, userId: req.auth.user.id,
      action: 'checklist.create', entity: 'checklists', entityId: cl.id,
      metadata: { title: cl.title, items: cl.items_total },
    });
    return ok(res, cl, 201);
  } catch (err) { next(err); }
});

router.patch('/:id', ...EDIT, async (req, res, next) => {
  try {
    const id = reqInt(req.params.id, 'ID');
    const cl = await svc.updateMeta(req.auth.user.companyId, id, req.body || {}, req.auth.user.id);
    audit({
      req, companyId: req.auth.user.companyId, userId: req.auth.user.id,
      action: 'checklist.update', entity: 'checklists', entityId: cl.id,
      metadata: { title: cl.title, status: cl.status },
    });
    return ok(res, cl);
  } catch (err) { next(err); }
});

router.post('/:id/items', ...EDIT, async (req, res, next) => {
  try {
    const id = reqInt(req.params.id, 'ID');
    reqString(req.body?.title, 'Título', { min: 2, max: 140 });
    const cl = await svc.addItem(req.auth.user.companyId, id, req.body || {}, req.auth.user.id);
    audit({
      req, companyId: req.auth.user.companyId, userId: req.auth.user.id,
      action: 'checklist.item.add', entity: 'checklists', entityId: id,
      metadata: { item: req.body.title },
    });
    return ok(res, cl, 201);
  } catch (err) { next(err); }
});

router.delete('/:id/items/:itemId', ...EDIT, async (req, res, next) => {
  try {
    const id = reqInt(req.params.id, 'ID');
    const itemId = reqInt(req.params.itemId, 'Item');
    const cl = await svc.removeItem(req.auth.user.companyId, id, itemId, req.auth.user.id);
    audit({
      req, companyId: req.auth.user.companyId, userId: req.auth.user.id,
      action: 'checklist.item.remove', entity: 'checklists', entityId: id,
      metadata: { item_id: itemId },
    });
    return ok(res, cl);
  } catch (err) { next(err); }
});

router.post('/:id/items/:itemId/toggle', ...COMPLETE, async (req, res, next) => {
  try {
    const id = reqInt(req.params.id, 'ID');
    const itemId = reqInt(req.params.itemId, 'Item');
    const completed = req.body?.completed === false || req.body?.completed === 0 ? false : true;
    const cl = await svc.setItem(req.auth.user.companyId, id, itemId, completed, req.auth.user.id);
    audit({
      req, companyId: req.auth.user.companyId, userId: req.auth.user.id,
      action: completed ? 'checklist.item.complete' : 'checklist.item.reopen',
      entity: 'checklists', entityId: id, metadata: { item_id: itemId },
    });
    return ok(res, cl);
  } catch (err) { next(err); }
});

router.post('/:id/complete', ...COMPLETE, async (req, res, next) => {
  try {
    const id = reqInt(req.params.id, 'ID');
    const cl = await svc.complete(req.auth.user.companyId, id, req.auth.user.id);
    audit({
      req, companyId: req.auth.user.companyId, userId: req.auth.user.id,
      action: 'checklist.complete', entity: 'checklists', entityId: cl.id,
      metadata: { title: cl.title, progress: cl.progress },
    });
    return ok(res, cl);
  } catch (err) { next(err); }
});

router.post('/:id/cancel', ...DELETE, async (req, res, next) => {
  try {
    const id = reqInt(req.params.id, 'ID');
    const cl = await svc.cancel(req.auth.user.companyId, id, req.auth.user.id);
    audit({
      req, companyId: req.auth.user.companyId, userId: req.auth.user.id,
      action: 'checklist.cancel', entity: 'checklists', entityId: cl.id,
      metadata: { title: cl.title },
    });
    return ok(res, cl);
  } catch (err) { next(err); }
});

router.delete('/:id', ...DELETE, async (req, res, next) => {
  try {
    const id = reqInt(req.params.id, 'ID');
    await svc.remove(req.auth.user.companyId, id);
    audit({
      req, companyId: req.auth.user.companyId, userId: req.auth.user.id,
      action: 'checklist.delete', entity: 'checklists', entityId: id,
    });
    return ok(res, { deleted: true });
  } catch (err) { next(err); }
});

module.exports = router;
