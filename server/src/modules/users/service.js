'use strict';

/**
 * Serviço de usuários — escopo SEMPRE limitado à empresa do contexto.
 *
 * Regras de segurança:
 *  - nenhuma consulta aceita company_id vindo do cliente;
 *  - função "master" jamais pode ser atribuída por um tenant;
 *  - ninguém altera a própria função/status (evita autoescalação de privilégio);
 *  - loja informada precisa pertencer à mesma empresa;
 *  - desativação/redefinição de senha revogam sessões.
 */

const db = require('../../database/connection');
const { hashPassword } = require('../../core/security');
const { notFound, conflict, forbidden, badRequest } = require('../../core/errors');
const { revokeUserSessions } = require('../../middlewares/auth');

const LIST_SQL = `
  SELECT u.id, u.name, u.email, u.status, u.last_login_at, u.created_at,
         u.store_id, s.name AS store_name,
         r.slug AS role_slug, r.name AS role_name
  FROM users u
  JOIN roles r ON r.id = u.role_id
  LEFT JOIN stores s ON s.id = u.store_id
  WHERE u.company_id = ?
`;

function list(companyId, { page, perPage, offset, search }) {
  let where = '';
  const params = [companyId];
  if (search) {
    where = ' AND (u.name LIKE ? OR u.email LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  const total = db
    .prepare(`SELECT COUNT(*) AS c FROM users u WHERE u.company_id = ?${where.replace(' AND (u.name', ' AND (u.name')}`)
    .get(...params).c;
  const items = db
    .prepare(`${LIST_SQL}${where} ORDER BY u.name LIMIT ? OFFSET ?`)
    .all(...params, perPage, offset);
  return { items, total, page, perPage };
}

async function getScoped(companyId, id) {
  const user = await db.prepare(`${LIST_SQL} AND u.id = ?`).get(companyId, id);
  if (!user) throw notFound('Usuário não encontrado.');
  return user;
}

function assertStoreBelongs(companyId, storeId) {
  if (storeId === undefined || storeId === null) return null;
  const store = db
    .prepare('SELECT id FROM stores WHERE id = ? AND company_id = ?')
    .get(storeId, companyId);
  if (!store) throw badRequest('Loja inválida para esta empresa.');
  return store.id;
}

function tenantRoleBySlug(slug) {
  // Tenants nunca podem atribuir a função master
  const role = db
    .prepare(`SELECT id, slug FROM roles WHERE slug = ? AND slug != 'master' AND company_id IS NULL`)
    .get(slug);
  if (!role) throw badRequest('Função inválida.');
  return role;
}

async function create(companyId, { name, email, password, roleSlug, storeId }) {
  const role = tenantRoleBySlug(roleSlug);
  const store = assertStoreBelongs(companyId, storeId);
  try {
    const info = db
      .prepare(
        `INSERT INTO users (company_id, store_id, role_id, name, email, password_hash)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(companyId, store, role.id, name, email, hashPassword(password));
    return await getScoped(companyId, info.lastInsertRowid);
  } catch (err) {
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
      throw conflict('Já existe um usuário com este e-mail.');
    }
    throw err;
  }
}

async function update(companyId, id, { name, roleSlug, storeId, status }, actorUserId) {
  const target = await getScoped(companyId, id);

  if (id === actorUserId && ((roleSlug && roleSlug !== target.role_slug) || (status && status !== target.status))) {
    throw forbidden('Você não pode alterar a própria função ou status.');
  }

  const nextRoleId = roleSlug ? tenantRoleBySlug(roleSlug).id : undefined;
  const nextStoreId = storeId !== undefined ? assertStoreBelongs(companyId, storeId) : undefined;

  await db.prepare(
    `UPDATE users SET
       name  = COALESCE(?, name),
       role_id = COALESCE(?, role_id),
       store_id = CASE WHEN ? THEN ? ELSE store_id END,
       status = COALESCE(?, status),
       updated_at = datetime('now')
     WHERE id = ? AND company_id = ?`
  ).run(
    name ?? null,
    nextRoleId ?? null,
    storeId !== undefined ? 1 : 0,
    nextStoreId ?? null,
    status ?? null,
    id,
    companyId
  );

  if (status === 'inactive') await revokeUserSessions(id);

  return await getScoped(companyId, id);
}

async function resetPassword(companyId, id, newPassword, req) {
  const target = await getScoped(companyId, id);
  // Redefinir senha SEMPRE exige troca no próximo acesso (o administrador
  // não deve conhecer a senha definitiva do usuário)
  await db.prepare(
    `UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = datetime('now') WHERE id = ?`
  ).run(hashPassword(newPassword), id);
  await revokeUserSessions(id);
  return target;
}

module.exports = { list, getScoped, create, update, resetPassword };
