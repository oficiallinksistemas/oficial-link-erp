'use strict';

/**
 * PLATAFORMA — Master Platform Admin (Oficial Link Sistemas).
 *
 * Acesso administrativo GLOBAL, por permissão explícita de plataforma
 * (ver middleware requireMaster + requirePermission). O Master administra
 * qualquer tenant SEM precisar entrar na conta de cada empresa. Todas as
 * ações são autenticadas, autorizadas, validadas e auditadas.
 *
 * O Master NUNCA visualiza senha de ninguém: apenas define nova senha
 * (com troca obrigatória no próximo acesso) e revoga sessões.
 */

const express = require('express');
const db = require('../../database/connection');
const { ok } = require('../../core/http');
const {
  pagination, reqString, optString, optEnum, optInt, reqInt, reqEmail, reqPassword,
} = require('../../core/validate');
const { notFound, conflict, badRequest, forbidden } = require('../../core/errors');
const {
  requirePermission, requireMaster, revokeUserSessions, revokeCompanySessions,
} = require('../../middlewares/auth');
const { audit } = require('../../core/audit');
const { hashPassword } = require('../../core/security');
const { formatInTz } = require('../../core/businessDate');

const router = express.Router();

/** Data corrente (AAAA-MM-DD) no fuso da plataforma (Oficial Link). */
function platformToday() { return formatInTz(new Date(), 'America/Fortaleza'); }

router.use(requireMaster);

// ===========================================================================
// VISÃO GERAL
// ===========================================================================
router.get('/overview', requirePermission('platform.overview.view', 'platform.companies.view'), async (req, res) => {
  const one = async (sql, ...p) => (await db.prepare(sql).get(...p)).c;
  const data = {
    companies: {
      total: await one('SELECT COUNT(*) AS c FROM companies'),
      active: await one(`SELECT COUNT(*) AS c FROM companies WHERE status = 'active'`),
      suspended: await one(`SELECT COUNT(*) AS c FROM companies WHERE status = 'suspended'`),
    },
    stores: await one('SELECT COUNT(*) AS c FROM stores'),
    users: await one('SELECT COUNT(*) AS c FROM users WHERE company_id IS NOT NULL'),
    sessions_active: await one('SELECT COUNT(*) AS c FROM sessions WHERE revoked_at IS NULL AND expires_at > datetime(\'now\')'),
    // "Hoje" no calendário comercial da plataforma (America/Fortaleza) —
    // created_at é instante UTC; o corte do dia segue o fuso da plataforma.
    audits_today: await one('SELECT COUNT(*) AS c FROM audit_logs WHERE created_at >= ?', platformToday()),
    logins_today: await one(`SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'auth.login' AND created_at >= ?`, platformToday()),
  };
  return ok(res, data);
});

// ===========================================================================
// EMPRESAS
// ===========================================================================
router.get('/companies', requirePermission('platform.companies.view', 'platform.companies.manage'), async (req, res) => {
  const pg = pagination(req.query);
  const search = req.query.search ? String(req.query.search).slice(0, 80) : undefined;
  let where = '';
  const params = [];
  if (search) {
    where = ' WHERE (c.name LIKE ? OR c.trade_name LIKE ? OR c.document LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const total = (await db.prepare(`SELECT COUNT(*) AS c FROM companies c${where}`).get(...params)).c;
  const items = await db.prepare(
    `SELECT c.id, c.name, c.trade_name, c.document, c.email, c.phone, c.status, c.plan,
            c.subscription_status, c.created_at,
       (SELECT COUNT(*) FROM stores s WHERE s.company_id = c.id) AS stores_count,
       (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id) AS users_count
     FROM companies c${where}
     ORDER BY c.name LIMIT ? OFFSET ?`
  ).all(...params, pg.perPage, pg.offset);
  return ok(res, { items, total, page: pg.page, perPage: pg.perPage });
});

router.post('/companies', requirePermission('platform.companies.manage'), async (req, res, next) => {
  try {
    const data = {
      name: reqString(req.body?.name, 'Nome', { min: 2, max: 120 }),
      trade_name: optString(req.body?.trade_name, 'Nome fantasia', { max: 120 }),
      document: optString(req.body?.document, 'CNPJ', { max: 20 }),
      email: optString(req.body?.email, 'E-mail', { max: 190 }),
      phone: optString(req.body?.phone, 'Telefone', { max: 30 }),
    };
    let id;
    try {
      id = (await db.prepare(
        `INSERT INTO companies (name, trade_name, document, email, phone, settings)
         VALUES (?, ?, ?, ?, ?, '{}')`
      ).run(data.name, data.trade_name ?? null, data.document ?? null, data.email ?? null, data.phone ?? null)).lastInsertRowid;
    } catch (err) {
      if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
        throw conflict('Já existe uma empresa cadastrada com este CNPJ.');
      }
      throw err;
    }
    audit({ req, userId: req.auth.user.id, action: 'platform.company.create', entity: 'companies', entityId: id, metadata: { name: data.name } });
    return ok(res, await getCompany(id), 201);
  } catch (err) {
    next(err);
  }
});

async function getCompany(id) {
  return await db.prepare(
    'SELECT id, name, trade_name, document, email, phone, status, plan, subscription_status, created_at FROM companies WHERE id = ?'
  ).get(id);
}

router.get('/companies/:id', requirePermission('platform.companies.view', 'platform.companies.manage'), async (req, res, next) => {
  try {
    const company = await getCompany(reqInt(req.params.id, 'ID'));
    if (!company) throw notFound('Empresa não encontrada.');
    company.stores = await db.prepare(
      'SELECT id, name, code, city, state, status FROM stores WHERE company_id = ? ORDER BY name'
    ).all(company.id);
    company.users = await db.prepare(
      `SELECT u.id, u.name, u.email, u.status, u.last_login_at, u.must_change_password,
              r.name AS role_name, s.name AS store_name
       FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN stores s ON s.id = u.store_id
       WHERE u.company_id = ? ORDER BY u.name`
    ).all(company.id);
    return ok(res, company);
  } catch (err) {
    next(err);
  }
});

router.patch('/companies/:id', requirePermission('platform.companies.manage'), async (req, res, next) => {
  try {
    const id = reqInt(req.params.id, 'ID');
    const existing = await db.prepare('SELECT id, status FROM companies WHERE id = ?').get(id);
    if (!existing) throw notFound('Empresa não encontrada.');

    const data = {
      name: optString(req.body?.name, 'Nome', { min: 2, max: 120 }),
      trade_name: optString(req.body?.trade_name, 'Nome fantasia', { max: 120 }),
      email: optString(req.body?.email, 'E-mail', { max: 190 }),
      phone: optString(req.body?.phone, 'Telefone', { max: 30 }),
      plan: optString(req.body?.plan, 'Plano', { max: 40 }),
      status: optEnum(req.body?.status, 'Status', ['active', 'suspended']),
    };

    await db.prepare(
      `UPDATE companies SET
         name = COALESCE(?, name),
         trade_name = COALESCE(?, trade_name),
         email = COALESCE(?, email),
         phone = COALESCE(?, phone),
         plan = COALESCE(?, plan),
         status = COALESCE(?, status),
         updated_at = datetime('now')
       WHERE id = ?`
    ).run(data.name ?? null, data.trade_name ?? null, data.email ?? null, data.phone ?? null,
          data.plan ?? null, data.status ?? null, id);

    if (data.status === 'suspended' && existing.status !== 'suspended') {
      await revokeCompanySessions(id);
    }
    audit({ req, userId: req.auth.user.id, action: 'platform.company.update', entity: 'companies', entityId: id, metadata: { status: data.status, plan: data.plan } });
    return ok(res, await getCompany(id));
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// LOJAS (de qualquer empresa)
// ===========================================================================
const STORE_SQL = `
  SELECT s.id, s.company_id, s.name, s.code, s.city, s.state, s.status, s.created_at,
         c.name AS company_name
  FROM stores s JOIN companies c ON c.id = s.company_id
`;

router.get('/stores', requirePermission('platform.stores.view', 'platform.stores.manage'), async (req, res) => {
  const pg = pagination(req.query);
  const companyId = optInt(req.query.company_id, 'Empresa');
  const search = req.query.search ? String(req.query.search).slice(0, 80) : undefined;
  let where = '';
  const params = [];
  if (companyId) { where += ' WHERE s.company_id = ?'; params.push(companyId); }
  if (search) {
    where += `${where ? ' AND' : ' WHERE'} (s.name LIKE ? OR s.code LIKE ? OR s.city LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const total = (await db.prepare(`SELECT COUNT(*) AS c FROM stores s${where}`).get(...params)).c;
  const items = await db.prepare(`${STORE_SQL}${where} ORDER BY c.name, s.name LIMIT ? OFFSET ?`)
    .all(...params, pg.perPage, pg.offset);
  return ok(res, { items, total, page: pg.page, perPage: pg.perPage });
});

async function companyExists(id) {
  const c = await db.prepare('SELECT id, status FROM companies WHERE id = ?').get(id);
  if (!c) throw notFound('Empresa não encontrada.');
  return c;
}

router.post('/stores', requirePermission('platform.stores.manage'), async (req, res, next) => {
  try {
    const companyId = reqInt(req.body?.company_id, 'Empresa');
    await companyExists(companyId);
    const data = {
      name: reqString(req.body?.name, 'Nome', { min: 2, max: 120 }),
      code: reqString(req.body?.code, 'Código', { min: 2, max: 30 }).toUpperCase(),
      city: optString(req.body?.city, 'Cidade', { max: 80 }),
      state: (optString(req.body?.state, 'UF', { min: 2, max: 2 }) || '').toUpperCase() || undefined,
    };
    let id;
    try {
      id = (await db.prepare(
        'INSERT INTO stores (company_id, name, code, city, state) VALUES (?, ?, ?, ?, ?)'
      ).run(companyId, data.name, data.code, data.city ?? null, data.state ?? null)).lastInsertRowid;
    } catch (err) {
      if (String(err.code).startsWith('SQLITE_CONSTRAINT')) throw conflict('Já existe uma loja com este código nesta empresa.');
      throw err;
    }
    audit({ req, companyId, userId: req.auth.user.id, action: 'platform.store.create', entity: 'stores', entityId: id, metadata: { code: data.code } });
    return ok(res, await db.prepare(`${STORE_SQL} WHERE s.id = ?`).get(id), 201);
  } catch (err) {
    next(err);
  }
});

router.patch('/stores/:id', requirePermission('platform.stores.manage'), async (req, res, next) => {
  try {
    const id = reqInt(req.params.id, 'ID');
    const existing = await db.prepare(`${STORE_SQL} WHERE s.id = ?`).get(id);
    if (!existing) throw notFound('Loja não encontrada.');
    const data = {
      name: optString(req.body?.name, 'Nome', { min: 2, max: 120 }),
      city: optString(req.body?.city, 'Cidade', { max: 80 }),
      state: (optString(req.body?.state, 'UF', { min: 2, max: 2 }) || '').toUpperCase() || undefined,
      status: optEnum(req.body?.status, 'Status', ['active', 'inactive']),
    };
    await db.prepare(
      `UPDATE stores SET name = COALESCE(?, name), city = COALESCE(?, city),
         state = COALESCE(?, state), status = COALESCE(?, status), updated_at = datetime('now')
       WHERE id = ?`
    ).run(data.name ?? null, data.city ?? null, data.state ?? null, data.status ?? null, id);
    audit({ req, companyId: existing.company_id, userId: req.auth.user.id, action: 'platform.store.update', entity: 'stores', entityId: id, metadata: { status: data.status } });
    return ok(res, await db.prepare(`${STORE_SQL} WHERE s.id = ?`).get(id));
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// USUÁRIOS (de qualquer empresa)
// ===========================================================================
const USER_SQL = `
  SELECT u.id, u.company_id, u.name, u.email, u.status, u.last_login_at,
         u.must_change_password, u.store_id, s.name AS store_name,
         r.slug AS role_slug, r.name AS role_name, c.name AS company_name
  FROM users u
  JOIN roles r ON r.id = u.role_id
  JOIN companies c ON c.id = u.company_id
  LEFT JOIN stores s ON s.id = u.store_id
`;

async function platformRoleBySlug(slug) {
  const role = await db.prepare(`SELECT id, slug FROM roles WHERE slug = ? AND slug != 'master' AND company_id IS NULL`).get(slug);
  if (!role) throw badRequest('Função inválida.');
  return role;
}

async function assertStoreInCompany(companyId, storeId) {
  if (storeId === undefined || storeId === null) return null;
  const store = await db.prepare('SELECT id FROM stores WHERE id = ? AND company_id = ?').get(storeId, companyId);
  if (!store) throw badRequest('Loja não pertence a esta empresa.');
  return store.id;
}

router.get('/users', requirePermission('platform.users.view', 'platform.users.manage'), async (req, res) => {
  const pg = pagination(req.query);
  const companyId = optInt(req.query.company_id, 'Empresa');
  const search = req.query.search ? String(req.query.search).slice(0, 80) : undefined;
  let where = ' WHERE u.company_id IS NOT NULL';
  const params = [];
  if (companyId) { where += ' AND u.company_id = ?'; params.push(companyId); }
  if (search) {
    where += ' AND (u.name LIKE ? OR u.email LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  const total = (await db.prepare(`SELECT COUNT(*) AS c FROM users u${where}`).get(...params)).c;
  const items = await db.prepare(`${USER_SQL}${where} ORDER BY c.name, u.name LIMIT ? OFFSET ?`)
    .all(...params, pg.perPage, pg.offset);
  return ok(res, { items, total, page: pg.page, perPage: pg.perPage });
});

router.post('/users', requirePermission('platform.users.manage'), async (req, res, next) => {
  try {
    const companyId = reqInt(req.body?.company_id, 'Empresa');
    await companyExists(companyId);
    const role = await platformRoleBySlug(reqString(req.body?.role_slug, 'Função', { max: 40 }));
    const storeId = await assertStoreInCompany(companyId, optInt(req.body?.store_id, 'Loja'));
    const email = reqEmail(req.body?.email);
    const name = reqString(req.body?.name, 'Nome', { min: 2, max: 120 });
    const password = reqPassword(req.body?.password);
    const forceChange = req.body?.must_change_password !== false; // padrão: exigir troca
    let id;
    try {
      id = (await db.prepare(
        `INSERT INTO users (company_id, store_id, role_id, name, email, password_hash, must_change_password)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(companyId, storeId, role.id, name, email, hashPassword(password), forceChange ? 1 : 0)).lastInsertRowid;
    } catch (err) {
      if (String(err.code).startsWith('SQLITE_CONSTRAINT')) throw conflict('Já existe um usuário com este e-mail.');
      throw err;
    }
    audit({ req, companyId, userId: req.auth.user.id, action: 'platform.user.create', entity: 'users', entityId: id, metadata: { email, role: role.slug } });
    return ok(res, await db.prepare(`${USER_SQL} WHERE u.id = ?`).get(id), 201);
  } catch (err) {
    next(err);
  }
});

async function getPlatformUser(id) {
  const user = await db.prepare(`${USER_SQL} WHERE u.id = ? AND u.company_id IS NOT NULL`).get(id);
  if (!user) throw notFound('Usuário não encontrado.');
  return user;
}

router.get('/users/:id', requirePermission('platform.users.view', 'platform.users.manage'), async (req, res, next) => {
  try { return ok(res, await getPlatformUser(reqInt(req.params.id, 'ID'))); } catch (err) { next(err); }
});

router.patch('/users/:id', requirePermission('platform.users.manage'), async (req, res, next) => {
  try {
    const id = reqInt(req.params.id, 'ID');
    const target = await getPlatformUser(id); // escopo: usuário de empresa (nunca Master)
    const data = {
      name: optString(req.body?.name, 'Nome', { min: 2, max: 120 }),
      email: optString(req.body?.email, 'E-mail', { max: 190 })?.toLowerCase(),
      role_id: req.body?.role_slug ? (await platformRoleBySlug(req.body.role_slug)).id : undefined,
      store_id: req.body?.store_id === null ? null : await assertStoreInCompany(target.company_id, optInt(req.body?.store_id, 'Loja')),
      has_store: req.body?.store_id !== undefined ? 1 : 0,
      status: optEnum(req.body?.status, 'Status', ['active', 'inactive']),
    };
    await db.prepare(
      `UPDATE users SET
         name = COALESCE(?, name),
         email = COALESCE(?, email),
         role_id = COALESCE(?, role_id),
         store_id = CASE WHEN ? THEN ? ELSE store_id END,
         status = COALESCE(?, status),
         updated_at = datetime('now')
       WHERE id = ?`
    ).run(data.name ?? null, data.email ?? null, data.role_id ?? null, data.has_store,
          data.store_id ?? null, data.status ?? null, id);
    if (data.status === 'inactive') await revokeUserSessions(id);
    audit({ req, companyId: target.company_id, userId: req.auth.user.id, action: 'platform.user.update', entity: 'users', entityId: id, metadata: { status: data.status } });
    return ok(res, await getPlatformUser(id));
  } catch (err) {
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) return next(conflict('Já existe um usuário com este e-mail.'));
    next(err);
  }
});

router.post('/users/:id/reset-password', requirePermission('platform.users.manage'), async (req, res, next) => {
  try {
    const id = reqInt(req.params.id, 'ID');
    const target = await getPlatformUser(id);
    const password = reqPassword(req.body?.password);
    // Master define nova senha e FORÇA troca no próximo acesso; nunca vê a senha atual
    await db.prepare(
      `UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = datetime('now') WHERE id = ?`
    ).run(hashPassword(password), id);
    await revokeUserSessions(id);
    audit({ req, companyId: target.company_id, userId: req.auth.user.id, action: 'platform.user.reset_password', entity: 'users', entityId: id });
    return ok(res, { reset: true, must_change_password: true });
  } catch (err) {
    next(err);
  }
});

router.post('/users/:id/revoke-sessions', requirePermission('platform.users.manage'), async (req, res, next) => {
  try {
    const id = reqInt(req.params.id, 'ID');
    const target = await getPlatformUser(id);
    await revokeUserSessions(id);
    audit({ req, companyId: target.company_id, userId: req.auth.user.id, action: 'platform.user.revoke_sessions', entity: 'users', entityId: id });
    return ok(res, { revoked: true });
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// AUDITORIA
// ===========================================================================
router.get('/audit', requirePermission('platform.audit.view'), async (req, res) => {
  const pg = pagination(req.query);
  const companyId = optInt(req.query.company_id, 'Empresa');
  const action = req.query.action ? String(req.query.action).slice(0, 60) : undefined;
  let where = '';
  const params = [];
  if (companyId) { where = ' WHERE a.company_id = ?'; params.push(companyId); }
  if (action) {
    where += `${where ? ' AND' : ' WHERE'} a.action LIKE ?`;
    params.push(`${action}%`);
  }
  const total = (await db.prepare(`SELECT COUNT(*) AS c FROM audit_logs a${where}`).get(...params)).c;
  const items = await db.prepare(
    `SELECT a.id, a.action, a.entity, a.entity_id, a.metadata, a.ip, a.created_at,
            u.name AS user_name, u.email AS user_email, c.name AS company_name
     FROM audit_logs a
     LEFT JOIN users u ON u.id = a.user_id
     LEFT JOIN companies c ON c.id = a.company_id
     ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`
  ).all(...params, pg.perPage, pg.offset);
  return ok(res, { items, total, page: pg.page, perPage: pg.perPage });
});

// ===========================================================================
// CONFIGURAÇÕES DA PLATAFORMA
// ===========================================================================
router.get('/settings', requirePermission('platform.settings.view', 'platform.settings.manage'), async (req, res) => {
  const rows = await db.prepare('SELECT key, value, updated_at FROM platform_settings').all();
  return ok(res, { maintenance_mode: rows.find((r) => r.key === 'maintenance_mode')?.value === '1' });
});

router.patch('/settings', requirePermission('platform.settings.manage'), async (req, res, next) => {
  try {
    const maintenance = req.body?.maintenance_mode;
    if (typeof maintenance !== 'boolean') throw badRequest('maintenance_mode deve ser true ou false.');
    await db.prepare(
      `INSERT INTO platform_settings (key, value, updated_at) VALUES ('maintenance_mode', ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(maintenance ? '1' : '0');
    audit({ req, userId: req.auth.user.id, action: 'platform.settings.update', entity: 'platform_settings', metadata: { maintenance_mode: maintenance } });
    return ok(res, { maintenance_mode: maintenance });
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// MÓDULOS DA PLATAFORMA — registry e ativação por empresa (somente Master)
// ===========================================================================
const { modulesForCompany, setModuleStatus } = require('../../core/modules');

router.get('/modules', requirePermission('platform.companies.view', 'platform.settings.manage'), async (req, res) => {
  const items = await db.prepare(
    `SELECT m.slug, m.name, m.description,
       (SELECT COUNT(*) FROM company_modules cm WHERE cm.module_slug = m.slug AND cm.status = 'active') AS active_companies
     FROM modules m ORDER BY m.name`
  ).all();
  return ok(res, items);
});

router.get('/companies/:id/modules', requirePermission('platform.companies.view', 'platform.settings.manage'), async (req, res, next) => {
  try {
    const id = reqInt(req.params.id, 'ID');
    if (!await db.prepare('SELECT id FROM companies WHERE id = ?').get(id)) throw notFound('Empresa não encontrada.');
    return ok(res, await modulesForCompany(id));
  } catch (err) {
    next(err);
  }
});

router.put('/companies/:id/modules/:slug', requirePermission('platform.settings.manage'), async (req, res, next) => {
  try {
    const id = reqInt(req.params.id, 'ID');
    if (!await db.prepare('SELECT id, name FROM companies WHERE id = ?').get(id)) throw notFound('Empresa não encontrada.');
    const status = optEnum(req.body?.status, 'Status', ['active', 'inactive']);
    const result = await setModuleStatus(id, String(req.params.slug).slice(0, 40), status);
    audit({ req, companyId: id, userId: req.auth.user.id, action: 'platform.module.update', entity: 'company_modules', metadata: { module: result.module_slug, status } });
    return ok(res, result);
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// BILLING SaaS — camada comercial da plataforma (v3.3)
// Herda router.use(requireMaster): acesso somente Master. Permissões
// platform.billing.view/manage aplicadas por rota dentro do sub-router.
// ===========================================================================
router.use('/billing', require('./billing/routes'));

module.exports = router;
