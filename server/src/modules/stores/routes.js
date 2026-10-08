'use strict';

/**
 * Módulo de Lojas — CRUD com escopo obrigatório por empresa.
 */

const express = require('express');
const db = require('../../database/connection');
const { ok } = require('../../core/http');
const { pagination, reqString, optString, optEnum, optInt, reqInt } = require('../../core/validate');
const { notFound, conflict, badRequest } = require('../../core/errors');
const { requirePermission, tenantId } = require('../../middlewares/auth');
const { audit } = require('../../core/audit');

const router = express.Router();

// Módulo exclusivo de tenants — o Master (company_id NULL) não acessa
router.use((req, res, next) => {
  if (tenantId(req) === null) {
    return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Módulo exclusivo de empresas.' } });
  }
  next();
});

const BASE_SQL = `SELECT id, name, code, city, state, status, created_at FROM stores WHERE company_id = ?`;

async function getScoped(companyId, id) {
  const store = await db.prepare(`${BASE_SQL} AND id = ?`).get(companyId, id);
  if (!store) throw notFound('Loja não encontrada.');
  return store;
}

router.use(requirePermission('stores.view', 'stores.manage'));

router.get('/', async (req, res) => {
  const companyId = tenantId(req);
  const pg = pagination(req.query);
  const search = req.query.search ? String(req.query.search).slice(0, 80) : undefined;
  let where = '';
  const params = [companyId];
  if (search) {
    where = ' AND (name LIKE ? OR code LIKE ? OR city LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const total = (await db.prepare(`SELECT COUNT(*) AS c FROM stores WHERE company_id = ?${where}`).get(...params)).c;
  const items = await db.prepare(`${BASE_SQL}${where} ORDER BY name LIMIT ? OFFSET ?`).all(...params, pg.perPage, pg.offset);
  return ok(res, { items, total, page: pg.page, perPage: pg.perPage });
});

router.post('/', requirePermission('stores.manage'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const data = {
      name: reqString(req.body?.name, 'Nome', { min: 2, max: 120 }),
      code: reqString(req.body?.code, 'Código', { min: 2, max: 30 }).toUpperCase(),
      city: optString(req.body?.city, 'Cidade', { max: 80 }),
      state: (optString(req.body?.state, 'UF', { min: 2, max: 2 }) || '').toUpperCase() || undefined,
    };
    let id;
    try {
      id = db
        .prepare(`INSERT INTO stores (company_id, name, code, city, state) VALUES (?, ?, ?, ?, ?)`)
        .run(companyId, data.name, data.code, data.city ?? null, data.state ?? null).lastInsertRowid;
    } catch (err) {
      if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
        throw conflict('Já existe uma loja com este código nesta empresa.');
      }
      throw err;
    }
    audit({ req, companyId, userId: req.auth.user.id, action: 'store.create', entity: 'stores', entityId: id, metadata: { code: data.code } });
    return ok(res, await getScoped(companyId, id), 201);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    return ok(res, await getScoped(tenantId(req), reqInt(req.params.id, 'ID')));
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', requirePermission('stores.manage'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const id = reqInt(req.params.id, 'ID');
    await getScoped(companyId, id); // garante escopo antes de alterar
    const data = {
      name: optString(req.body?.name, 'Nome', { min: 2, max: 120 }),
      city: optString(req.body?.city, 'Cidade', { max: 80 }),
      state: (optString(req.body?.state, 'UF', { min: 2, max: 2 }) || '').toUpperCase() || undefined,
      status: optEnum(req.body?.status, 'Status', ['active', 'inactive']),
    };
    await db.prepare(
      `UPDATE stores SET
         name = COALESCE(?, name),
         city = COALESCE(?, city),
         state = COALESCE(?, state),
         status = COALESCE(?, status),
         updated_at = datetime('now')
       WHERE id = ? AND company_id = ?`
    ).run(data.name ?? null, data.city ?? null, data.state ?? null, data.status ?? null, id, companyId);
    audit({ req, companyId, userId: req.auth.user.id, action: 'store.update', entity: 'stores', entityId: id, metadata: { status: data.status } });
    return ok(res, await getScoped(companyId, id));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
