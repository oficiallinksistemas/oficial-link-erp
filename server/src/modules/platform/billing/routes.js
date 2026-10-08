'use strict';

/**
 * BILLING SaaS — rotas da camada comercial da plataforma.
 *
 * Montado em modules/platform/routes.js sob /billing: HERDA o
 * router.use(requireMaster) do router de plataforma (acesso só Master) e
 * aplica permissões de plataforma por rota (platform.billing.view/manage).
 *
 * Isolamento: endpoints são de PLATAFORMA — um tenant jamais os alcança
 * (requireMaster exige company_id NULL). O company_id usado nas consultas
 * SEMPRE vem do parâmetro da rota validado contra o cadastro, nunca de
 * confiança cega no cliente: cada escrita verifica que a empresa existe.
 */

const express = require('express');
const db = require('../../../database/connection');
const { ok } = require('../../../core/http');
const { pagination, reqInt, optEnum, optString } = require('../../../core/validate');
const { notFound } = require('../../../core/errors');
const { requirePermission } = require('../../../middlewares/auth');
const { audit } = require('../../../core/audit');
const svc = require('./service');

const router = express.Router();

const VIEW = [requirePermission('platform.billing.view', 'platform.billing.manage')];
const MANAGE = [requirePermission('platform.billing.manage')];

async function companyExists(companyId) {
  return !!await db.prepare('SELECT id FROM companies WHERE id = ?').get(companyId);
}

function chargeAuditMeta(charge) {
  return {
    company_id: charge.company_id, type: charge.type,
    amount_cents: charge.amount_cents, status: charge.status,
  };
}

// ---------------------------------------------------------------------------
// Dashboard comercial
// ---------------------------------------------------------------------------
router.get('/overview', ...VIEW, async (req, res) => ok(res, await svc.overview()));

// ---------------------------------------------------------------------------
// Empresas (visão comercial)
// ---------------------------------------------------------------------------
router.get('/companies', ...VIEW, async (req, res) => {
  const pg = pagination(req.query);
  const data = await svc.listCompaniesCommercial({
    search: optString(req.query.search, 'Busca', { max: 80 }),
    plan: optString(req.query.plan, 'Plano', { max: 30 }),
    subscription: optEnum(req.query.subscription, 'Status da assinatura', ['active', 'past_due', 'canceled']),
    situation: optEnum(req.query.situation, 'Situação', ['overdue', 'due_soon', 'none']),
    page: pg.page,
    perPage: pg.perPage,
  });
  return ok(res, data);
});

router.get('/companies/:id', ...VIEW, async (req, res, next) => {
  try {
    const id = reqInt(req.params.id, 'ID');
    return ok(res, await svc.companyCommercialDetail(id));
  } catch (err) { next(err); }
});

router.put('/companies/:id/config', ...MANAGE, async (req, res, next) => {
  try {
    const id = reqInt(req.params.id, 'ID');
    if (!await companyExists(id)) throw notFound('Empresa não encontrada.');
    const current = await svc.getConfig(id);
    const data = svc.validateConfigPayload(req.body, current);
    const config = await svc.saveConfig(id, data);
    audit({
      req, companyId: id, userId: req.auth.user.id,
      action: 'platform.billing.config',
      entity: 'saas_billing_config', entityId: id,
      metadata: {
        implementation_fee_cents: data.implementation_fee_cents,
        monthly_fee_cents: data.monthly_fee_cents,
        billing_due_day: data.billing_due_day,
        payment_method: data.payment_method,
      },
    });
    return ok(res, config);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Cobranças
// ---------------------------------------------------------------------------
router.get('/charges', ...VIEW, async (req, res, next) => {
  try {
    const pg = pagination(req.query);
    const data = await svc.listCharges({
      companyId: req.query.company_id ? reqInt(req.query.company_id, 'Empresa') : undefined,
      status: optEnum(req.query.status, 'Status', ['OPEN', 'OVERDUE', 'PAID', 'CANCELED']),
      type: optEnum(req.query.type, 'Tipo', ['implementation', 'monthly', 'custom']),
      search: optString(req.query.search, 'Busca', { max: 80 }),
      page: pg.page,
      perPage: pg.perPage,
    });
    return ok(res, data);
  } catch (err) { next(err); }
});

router.get('/charges/:id', ...VIEW, async (req, res, next) => {
  try {
    const id = reqInt(req.params.id, 'ID');
    const charge = await svc.getCharge(id);
    if (!charge) throw notFound('Cobrança não encontrada.');
    return ok(res, charge);
  } catch (err) { next(err); }
});

router.post('/charges', ...MANAGE, async (req, res, next) => {
  try {
    const companyId = reqInt(req.body?.company_id, 'Empresa');
    if (!await companyExists(companyId)) throw notFound('Empresa não encontrada.');
    const charge = await svc.createCharge({
      companyId,
      type: req.body?.type,
      reference: req.body?.reference,
      amount: req.body?.amount,
      due_date: req.body?.due_date,
      notes: req.body?.notes,
    }, req.auth.user.id);
    audit({
      req, companyId, userId: req.auth.user.id,
      action: 'platform.billing.charge.create',
      entity: 'saas_charges', entityId: charge.id,
      metadata: chargeAuditMeta(charge),
    });
    return ok(res, charge, 201);
  } catch (err) { next(err); }
});

router.put('/charges/:id', ...MANAGE, async (req, res, next) => {
  try {
    const id = reqInt(req.params.id, 'ID');
    const charge = await svc.updateCharge(id, {
      reference: req.body?.reference,
      amount: req.body?.amount,
      due_date: req.body?.due_date,
      notes: req.body?.notes,
    });
    audit({
      req, companyId: charge.company_id, userId: req.auth.user.id,
      action: 'platform.billing.charge.update',
      entity: 'saas_charges', entityId: charge.id,
      metadata: chargeAuditMeta(charge),
    });
    return ok(res, charge);
  } catch (err) { next(err); }
});

router.post('/charges/:id/cancel', ...MANAGE, async (req, res, next) => {
  try {
    const id = reqInt(req.params.id, 'ID');
    const charge = await svc.cancelCharge(id, optString(req.body?.notes, 'Motivo', { max: 500 }), req.auth.user.id);
    audit({
      req, companyId: charge.company_id, userId: req.auth.user.id,
      action: 'platform.billing.charge.cancel',
      entity: 'saas_charges', entityId: charge.id,
      metadata: chargeAuditMeta(charge),
    });
    return ok(res, charge);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Pagamentos (registro manual pelo Master — idempotente, transacional)
// ---------------------------------------------------------------------------
router.post('/charges/:id/pay', ...MANAGE, async (req, res, next) => {
  try {
    const id = reqInt(req.params.id, 'ID');
    const { charge, payment } = await svc.payCharge(id, {
      amount: req.body?.amount,
      paid_on: req.body?.paid_on,
      method: req.body?.method,
      notes: req.body?.notes,
      receipt: req.body?.receipt,
    }, req.auth.user.id);
    audit({
      req, companyId: charge.company_id, userId: req.auth.user.id,
      action: 'platform.billing.payment',
      entity: 'saas_payments', entityId: payment.id,
      metadata: {
        charge_id: charge.id, amount_cents: payment.amount_cents,
        method: payment.method, paid_on: payment.paid_on,
        receipt: !!payment.receipt_id,
      },
    });
    return ok(res, { charge, payment });
  } catch (err) { next(err); }
});

router.get('/payments', ...VIEW, async (req, res, next) => {
  try {
    const pg = pagination(req.query);
    const data = await svc.listPayments({
      companyId: req.query.company_id ? reqInt(req.query.company_id, 'Empresa') : undefined,
      chargeId: req.query.charge_id ? reqInt(req.query.charge_id, 'Cobrança') : undefined,
      page: pg.page,
      perPage: pg.perPage,
    });
    return ok(res, data);
  } catch (err) { next(err); }
});

router.get('/payments/:id/receipt', ...VIEW, async (req, res, next) => {
  try {
    const id = reqInt(req.params.id, 'ID');
    const receipt = await svc.getReceiptByPayment(id);
    if (!receipt) throw notFound('Comprovante não encontrado.');
    res.set('Content-Type', receipt.mime);
    res.set('Content-Disposition', 'inline');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'private, max-age=3600');
    return res.send(receipt.data);
  } catch (err) { next(err); }
});

module.exports = router;
