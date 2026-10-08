'use strict';

/**
 * Módulo PRODUTOS — rotas (padrão V1.2+: tenant only → permissão → escopo).
 * Categorias são endpoints internos do próprio módulo (não viram módulo
 * separado — evita arquitetura excessiva).
 */

const express = require('express');
const { ok } = require('../../core/http');
const { pagination, optInt, reqString } = require('../../core/validate');
const { requirePermission, tenantId } = require('../../middlewares/auth');
const { audit } = require('../../core/audit');
const service = require('./service');

const router = express.Router();

// Módulo exclusivo de tenants
router.use((req, res, next) => {
  if (tenantId(req) === null) {
    return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Módulo exclusivo de empresas.' } });
  }
  next();
});

// ---------------------------------------------------------------------------
// Categorias (entidade interna — products.view para ler, products.create para gerenciar)
// ---------------------------------------------------------------------------
router.get('/categories', requirePermission('products.view'), async (req, res) => {
  return ok(res, await service.listCategories(tenantId(req)));
});

router.post('/categories', requirePermission('products.create'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const cat = await service.createCategory(companyId, reqString(req.body?.name, 'Nome', { min: 2, max: 80 }));
    audit({ req, companyId, userId: req.auth.user.id, action: 'product_category.create', entity: 'product_categories', entityId: cat.id, metadata: { name: cat.name } });
    return ok(res, cat, 201);
  } catch (err) {
    next(err);
  }
});

router.patch('/categories/:id', requirePermission('products.edit'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const cat = await service.updateCategory(companyId, optInt(req.params.id, 'ID'), req.body || {});
    audit({ req, companyId, userId: req.auth.user.id, action: 'product_category.update', entity: 'product_categories', entityId: cat.id, metadata: { status: cat.status } });
    return ok(res, cat);
  } catch (err) {
    next(err);
  }
});

router.delete('/categories/:id', requirePermission('products.delete'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const cat = await service.removeCategory(companyId, optInt(req.params.id, 'ID'));
    audit({ req, companyId, userId: req.auth.user.id, action: 'product_category.delete', entity: 'product_categories', entityId: cat.id, metadata: { name: cat.name } });
    return ok(res, { deleted: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Produtos
// ---------------------------------------------------------------------------
router.get('/', requirePermission('products.view'), async (req, res) => {
  const pg = pagination(req.query);
  const search = req.query.search ? String(req.query.search).slice(0, 80) : undefined;
  const status = req.query.status === 'active' || req.query.status === 'inactive' ? req.query.status : undefined;
  return ok(res, await service.list(tenantId(req), {
    ...pg, search, status, category_id: optInt(req.query.category_id, 'Categoria'),
  }));
});

router.post('/', requirePermission('products.create'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const product = await service.create(companyId, req.body || {});
    audit({ req, companyId, userId: req.auth.user.id, action: 'product.create', entity: 'products', entityId: product.id, metadata: { sku: product.sku, price_cents: product.price_cents } });
    return ok(res, product, 201);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requirePermission('products.view'), async (req, res, next) => {
  try {
    return ok(res, await service.getScoped(tenantId(req), optInt(req.params.id, 'ID')));
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', requirePermission('products.edit'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const product = await service.update(companyId, optInt(req.params.id, 'ID'), req.body || {});
    audit({ req, companyId, userId: req.auth.user.id, action: 'product.update', entity: 'products', entityId: product.id, metadata: { status: product.status, price_cents: product.price_cents } });
    return ok(res, product);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requirePermission('products.delete'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const product = await service.remove(companyId, optInt(req.params.id, 'ID'));
    audit({ req, companyId, userId: req.auth.user.id, action: 'product.delete', entity: 'products', entityId: product.id, metadata: { name: product.name } });
    return ok(res, { deleted: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
