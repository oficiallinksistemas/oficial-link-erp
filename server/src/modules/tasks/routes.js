'use strict';

/**
 * TAREFAS — rotas (v3.4). company_id SEMPRE da sessão (req.auth.user.companyId).
 */

const express = require('express');
const { ok } = require('../../core/http');
const { pagination, reqString, optEnum, optString, reqInt } = require('../../core/validate');
const { notFound } = require('../../core/errors');
const { requirePermission } = require('../../middlewares/auth');
const { audit } = require('../../core/audit');
const svc = require('./service');

const router = express.Router();
const VIEW = [requirePermission('tasks.view')];
const CREATE = [requirePermission('tasks.create')];
const EDIT = [requirePermission('tasks.edit')];
const DELETE = [requirePermission('tasks.delete')];
const COMPLETE = [requirePermission('tasks.complete')];

router.get('/', ...VIEW, async (req, res, next) => {
  try {
    const pg = pagination(req.query);
    const data = await svc.list(req.auth.user.companyId, {
      search: optString(req.query.search, 'Busca', { max: 80 }),
      status: optEnum(req.query.status, 'Status', svc.STATUSES),
      priority: optEnum(req.query.priority, 'Prioridade', svc.PRIORITIES),
      assigned_to: req.query.assigned_to ? reqInt(req.query.assigned_to, 'Responsável') : undefined,
      store_id: req.query.store_id ? reqInt(req.query.store_id, 'Loja') : undefined,
      due_from: req.query.due_from && svc.isValidDate(req.query.due_from) ? req.query.due_from : undefined,
      due_to: req.query.due_to && svc.isValidDate(req.query.due_to) ? req.query.due_to : undefined,
      overdue: req.query.overdue === '1' ? '1' : undefined,
      mine: req.query.mine === '1' ? '1' : undefined,
      userId: req.auth.user.id,
      page: pg.page,
      perPage: pg.perPage,
    });
    return ok(res, data);
  } catch (err) { next(err); }
});

router.get('/:id', ...VIEW, async (req, res, next) => {
  try {
    const id = reqInt(req.params.id, 'ID');
    const t = await svc.getTask(req.auth.user.companyId, id);
    if (!t) throw notFound('Tarefa não encontrada.');
    return ok(res, t);
  } catch (err) { next(err); }
});

router.post('/', ...CREATE, async (req, res, next) => {
  try {
    reqString(req.body?.title, 'Título', { min: 3, max: 120 });
    const t = await svc.create(req.auth.user.companyId, req.body || {}, req.auth.user.id);
    audit({
      req, companyId: req.auth.user.companyId, userId: req.auth.user.id,
      action: 'task.create', entity: 'tasks', entityId: t.id,
      metadata: { title: t.title, priority: t.priority },
    });
    return ok(res, t, 201);
  } catch (err) { next(err); }
});

router.patch('/:id', ...EDIT, async (req, res, next) => {
  try {
    const id = reqInt(req.params.id, 'ID');
    const t = await svc.update(req.auth.user.companyId, id, req.body || {}, req.auth.user.id);
    audit({
      req, companyId: req.auth.user.companyId, userId: req.auth.user.id,
      action: 'task.update', entity: 'tasks', entityId: t.id,
      metadata: { title: t.title, status: t.status, priority: t.priority },
    });
    return ok(res, t);
  } catch (err) { next(err); }
});

router.post('/:id/complete', ...COMPLETE, async (req, res, next) => {
  try {
    const id = reqInt(req.params.id, 'ID');
    const t = await svc.complete(req.auth.user.companyId, id, req.auth.user.id);
    audit({
      req, companyId: req.auth.user.companyId, userId: req.auth.user.id,
      action: 'task.complete', entity: 'tasks', entityId: t.id,
      metadata: { title: t.title },
    });
    return ok(res, t);
  } catch (err) { next(err); }
});

router.post('/:id/reopen', ...COMPLETE, async (req, res, next) => {
  try {
    const id = reqInt(req.params.id, 'ID');
    const t = await svc.reopen(req.auth.user.companyId, id, req.auth.user.id);
    audit({
      req, companyId: req.auth.user.companyId, userId: req.auth.user.id,
      action: 'task.reopen', entity: 'tasks', entityId: t.id,
      metadata: { title: t.title },
    });
    return ok(res, t);
  } catch (err) { next(err); }
});

router.delete('/:id', ...DELETE, async (req, res, next) => {
  try {
    const id = reqInt(req.params.id, 'ID');
    await svc.remove(req.auth.user.companyId, id);
    audit({
      req, companyId: req.auth.user.companyId, userId: req.auth.user.id,
      action: 'task.delete', entity: 'tasks', entityId: id,
    });
    return ok(res, { deleted: true });
  } catch (err) { next(err); }
});

module.exports = router;
