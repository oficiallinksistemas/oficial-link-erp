'use strict';

/**
 * Autenticação e autorização — validadas SEMPRE no backend.
 *
 * Fluxo: cookie httpOnly → token opaco → SHA-256 → sessão no banco → usuário,
 * função, permissões e empresa. O company_id usado em toda consulta vem da
 * SESSÃO, nunca de parâmetro enviado pelo cliente. É isso que garante o
 * isolamento absoluto entre empresas.
 *
 * Hierarquia: Oficial Link Sistemas → Master Platform Admin → Empresas →
 * Lojas → Usuários → Funções/Permissões. O Master (company_id NULL + slug
 * 'master') possui acesso administrativo global por permissão explícita de
 * plataforma — decidido AQUI, no servidor, nunca no frontend.
 */

const db = require('../database/connection');
const config = require('../config');
const { sha256 } = require('../core/security');
const { unauthorized, forbidden } = require('../core/errors');

const COOKIE_NAME = config.cookieName;

const SESSION_SQL = `
  SELECT
    s.id          AS session_id,
    s.expires_at  AS session_expires_at,
    u.id          AS user_id,
    u.company_id  AS company_id,
    u.store_id    AS store_id,
    u.name        AS user_name,
    u.email       AS user_email,
    u.status      AS user_status,
    u.must_change_password,
    u.last_login_at,
    r.id          AS role_id,
    r.slug        AS role_slug,
    r.name        AS role_name
  FROM sessions s
  JOIN users u ON u.id = s.user_id
  JOIN roles r ON r.id = u.role_id
  WHERE s.token_hash = ? AND s.revoked_at IS NULL
`;

const PERMISSIONS_SQL = `
  SELECT permission_code FROM role_permissions WHERE role_id = ?
`;

const COMPANY_SQL = `SELECT id, name, trade_name, status FROM companies WHERE id = ?`;

/** Rotas liberadas para quem está com troca de senha obrigatória. */
const ALLOWED_WITH_FORCED_CHANGE = new Set([
  '/api/auth/me',
  '/api/auth/logout',
  '/api/auth/change-password',
]);

function extractToken(req) {
  const cookies = req.cookies || {};
  if (cookies[COOKIE_NAME]) return cookies[COOKIE_NAME];
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

/** Modo de manutenção da plataforma (configuração em banco, auditável). */
async function isMaintenanceMode() {
  const row = await db.prepare('SELECT value FROM platform_settings WHERE key = ?').get('maintenance_mode');
  return row ? row.value === '1' : false;
}

/** Carrega o contexto de autenticação na requisição (req.auth). */
async function authenticate(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) throw unauthorized('Faça login para continuar.');

    const row = await db.prepare(SESSION_SQL).get(sha256(token));
    if (!row) throw unauthorized();
    if (row.session_expires_at <= new Date().toISOString().slice(0, 19).replace('T', ' ')) {
      throw unauthorized('Sua sessão expirou. Faça login novamente.');
    }
    if (row.user_status !== 'active') {
      throw unauthorized('Usuário desativado. Contate o administrador.');
    }

    const permissions = new Set(
      (await db.prepare(PERMISSIONS_SQL).all(row.role_id)).map((p) => p.permission_code)
    );

    const isMaster = row.company_id === null && row.role_slug === 'master';

    let company = null;
    if (row.company_id !== null) {
      company = await db.prepare(COMPANY_SQL).get(row.company_id);
      if (!company) throw unauthorized('Empresa não encontrada.');
      if (company.status !== 'active') {
        throw forbidden('Empresa suspensa. Contate a Oficial Link Sistemas.');
      }
      // Modo de manutenção: afeta tenants, nunca o Master
      if (await isMaintenanceMode()) {
        throw forbidden('Sistema em manutenção. Tente novamente em alguns minutos.');
      }
    }

    let store = null;
    if (row.store_id !== null) {
      // Só aceita loja que pertença à mesma empresa (defesa em profundidade)
      store = db
        .prepare('SELECT id, name, code FROM stores WHERE id = ? AND company_id = ?')
        .get(row.store_id, row.company_id);
    }

    req.auth = {
      sessionId: row.session_id,
      user: {
        id: row.user_id,
        companyId: row.company_id,
        storeId: row.store_id,
        name: row.user_name,
        email: row.user_email,
        lastLoginAt: row.last_login_at,
        mustChangePassword: row.must_change_password === 1,
      },
      role: { id: row.role_id, slug: row.role_slug, name: row.role_name },
      permissions,
      company,
      store,
    };

    // Troca de senha obrigatória: bloqueia tudo, exceto me/logout/trocar senha.
    // originalUrl é o caminho completo da requisição, independente de como os
    // routers foram montados (req.path muda conforme o nível do middleware).
    const fullPath = (req.originalUrl || '').split('?')[0];
    if (req.auth.user.mustChangePassword && !ALLOWED_WITH_FORCED_CHANGE.has(fullPath)) {
      throw forbidden('Você precisa trocar sua senha antes de continuar.');
    }

    next();
  } catch (err) {
    next(err);
  }
}

/** Verdadeiro se o contexto é Master Platform Admin (decisão do SERVIDOR). */
function isGlobalAdmin(auth) {
  return !!auth && auth.user.companyId === null && auth.role.slug === 'master';
}

/**
 * Exige uma permissão específica (RBAC real, no servidor).
 *
 * Regra da autoridade global: o Master Platform Admin possui TODAS as
 * permissões — presentes e FUTURAS — independentemente de atribuição
 * individual em role_permissions. Novas permissões de módulos futuros
 * (sales.manage, targets.manage, …) são automaticamente concedidas ao
 * Master sem operação manual. Usuários comuns seguem o RBAC normal.
 */
function requirePermission(...codes) {
  return (req, res, next) => {
    const a = req.auth;
    if (!a) return next(forbidden());
    if (isGlobalAdmin(a)) return next();
    if (codes.some((c) => a.permissions.has(c))) return next();
    return next(forbidden());
  };
}

/** Exige usuário Master (plataforma Oficial Link) — decisão do SERVIDOR. */
function requireMaster(req, res, next) {
  const a = req.auth;
  if (!a || a.user.companyId !== null || a.role.slug !== 'master') {
    return next(forbidden('Acesso restrito à Oficial Link Sistemas.'));
  }
  next();
}

/** companyId do tenant atual (null para Master). */
function tenantId(req) {
  return req.auth.user.companyId;
}

/** Revoga todas as sessões de usuários de uma empresa (ex.: suspensão). */
async function revokeCompanySessions(companyId) {
  await db.prepare(
    `UPDATE sessions SET revoked_at = datetime('now')
     WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE company_id = ?)`
  ).run(companyId);
}

/** Revoga todas as sessões de um usuário (exceto a atual, se informada). */
async function revokeUserSessions(userId, exceptSessionId = null) {
  await db.prepare(
    `UPDATE sessions SET revoked_at = datetime('now')
     WHERE user_id = ? AND revoked_at IS NULL AND id != ?`
  ).run(userId, exceptSessionId ?? -1);
}

module.exports = {
  authenticate,
  requirePermission,
  requireMaster,
  tenantId,
  revokeCompanySessions,
  revokeUserSessions,
  isMaintenanceMode,
};
