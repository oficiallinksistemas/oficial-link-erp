'use strict';

/**
 * NOTIFICAÇÕES — rotas da central (v3.4).
 * Escopo SEMPRE por usuário (user_id da sessão): um usuário nunca lê a
 * notificação de outro. company_id da sessão.
 */

const express = require('express');
const { ok } = require('../../core/http');
const { pagination, optEnum, reqInt } = require('../../core/validate');
const { notFound } = require('../../core/errors');
const { requirePermission } = require('../../middlewares/auth');
const svc = require('./service');

const router = express.Router();
const VIEW = [requirePermission('notifications.view')];

/** Badge do sino + últimas (para o dropdown do layout). */
router.get('/summary', ...VIEW, async (req, res, next) => {
  try {
    await svc.generateFinancialOverdue(req.auth.user.companyId);
    return ok(res, {
      unread: await svc.unreadCount(req.auth.user.id),
      recent: await svc.recent(req.auth.user.id, 6),
    });
  } catch (err) { next(err); }
});

router.get('/', ...VIEW, async (req, res, next) => {
  try {
    const pg = pagination(req.query);
    const data = await svc.list({
      userId: req.auth.user.id,
      read: optEnum(req.query.read, 'Leitura', ['unread', 'read']),
      type: optEnum(req.query.type, 'Tipo', svc.TYPES),
      page: pg.page,
      perPage: pg.perPage,
    });
    return ok(res, data);
  } catch (err) { next(err); }
});

router.post('/:id/read', ...VIEW, async (req, res, next) => {
  try {
    const id = reqInt(req.params.id, 'ID');
    if (!await svc.markRead(id, req.auth.user.id)) throw notFound('Notificação não encontrada.');
    return ok(res, { read: true });
  } catch (err) { next(err); }
});

router.post('/read-all', ...VIEW, async (req, res, next) => {
  try {
    return ok(res, { updated: await svc.markAllRead(req.auth.user.id) });
  } catch (err) { next(err); }
});

module.exports = router;
