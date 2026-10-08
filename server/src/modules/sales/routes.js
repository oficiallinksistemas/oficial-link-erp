'use strict';

/**
 * Módulo VENDAS — rotas (tenant only; exige módulo ativo via requireModule no
 * mount e permissão por rota). O company_id vem SEMPRE da sessão.
 */

const express = require('express');
const db = require('../../database/connection');
const { ok } = require('../../core/http');
const { pagination, reqString, optString, optInt, reqInt } = require('../../core/validate');
const { requirePermission, tenantId } = require('../../middlewares/auth');
const { audit } = require('../../core/audit');
const service = require('./service');

const router = express.Router();

// Módulo exclusivo de tenants — o Master administra dados via plataforma
router.use((req, res, next) => {
  if (tenantId(req) === null) {
    return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Módulo exclusivo de empresas.' } });
  }
  next();
});

router.get('/', requirePermission('sales.view'), async (req, res) => {
  const pg = pagination(req.query);
  const search = req.query.search ? String(req.query.search).slice(0, 80) : undefined;
  const data = await service.list(tenantId(req), {
    ...pg, search,
    store_id: optInt(req.query.store_id, 'Loja'),
    seller_id: optInt(req.query.seller_id, 'Vendedor'),
    status: req.query.status === 'canceled' ? 'canceled' : (req.query.status === 'active' ? 'active' : undefined),
  });
  return ok(res, data);
});

router.post('/', requirePermission('sales.create'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const sale = await service.create(companyId, req.auth.user.id, {
      store_id: reqInt(req.body?.store_id, 'Loja'),
      seller_id: reqInt(req.body?.seller_id, 'Vendedor'),
      customer_id: optInt(req.body?.customer_id, 'Cliente'),
      customer_name: reqString(req.body?.customer_name, 'Cliente', { min: 2, max: 120 }),
      product_id: optInt(req.body?.product_id, 'Produto'),
      items: Array.isArray(req.body?.items) ? req.body.items : undefined,
      amount: req.body?.amount,
      sold_at: reqString(req.body?.sold_at, 'Data da venda', { max: 20 }),
      note: optString(req.body?.note, 'Observação', { max: 500 }),
    });
    audit({ req, companyId, userId: req.auth.user.id, action: 'sale.create', entity: 'sales', entityId: sale.id, metadata: { amount_cents: sale.amount_cents, store_id: sale.store_id } });
    return ok(res, sale, 201);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requirePermission('sales.view'), async (req, res, next) => {
  try {
    return ok(res, await service.getDetail(tenantId(req), reqInt(req.params.id, 'ID')));
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', requirePermission('sales.edit'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const sale = await service.update(companyId, reqInt(req.params.id, 'ID'), {
      store_id: req.body?.store_id === undefined ? undefined : reqInt(req.body.store_id, 'Loja'),
      seller_id: req.body?.seller_id === undefined ? undefined : reqInt(req.body.seller_id, 'Vendedor'),
      customer_id: req.body?.customer_id === undefined ? undefined : (req.body.customer_id === null ? null : optInt(req.body.customer_id, 'Cliente')),
      product_id: req.body?.product_id === undefined ? undefined : (req.body.product_id === null ? null : optInt(req.body.product_id, 'Produto')),
      customer_name: optString(req.body?.customer_name, 'Cliente', { min: 2, max: 120 }),
      amount: req.body?.amount,
      sold_at: optString(req.body?.sold_at, 'Data da venda', { max: 20 }),
      note: req.body?.note === undefined ? undefined : optString(req.body.note, 'Observação', { max: 500 }),
    });
    audit({ req, companyId, userId: req.auth.user.id, action: 'sale.update', entity: 'sales', entityId: sale.id });
    return ok(res, sale);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/cancel', requirePermission('sales.cancel'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const id = reqInt(req.params.id, 'ID');
    // título vinculado (auditoria coerente quando o cancelamento o acompanhar)
    const linked = await db.prepare('SELECT id, status FROM accounts_receivable WHERE company_id = ? AND sale_id = ?').get(companyId, id);
    const sale = await service.cancel(companyId, id, req.body?.reason, req.auth.user.id);
    audit({ req, companyId, userId: req.auth.user.id, action: 'sale.cancel', entity: 'sales', entityId: sale.id, metadata: { reason: sale.cancel_reason } });
    // Auditoria SOMENTE se o título realmente foi cancelado nesta operação
    // (estado pós-transação, não suposição prévia).
    if (linked && linked.status !== 'canceled' && sale.status === 'canceled') {
      const after = await db.prepare('SELECT status FROM accounts_receivable WHERE id = ?').get(linked.id);
      if (after && after.status === 'canceled') {
        audit({ req, companyId, userId: req.auth.user.id, action: 'receivable.cancel', entity: 'accounts_receivable', entityId: linked.id, metadata: { reason: `Cancelado em consequência do cancelamento da venda #${id}` } });
      }
    }
    return ok(res, sale);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
