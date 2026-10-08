'use strict';

/**
 * Serviço de autenticação: login, sessões e troca de senha.
 */

const db = require('../../database/connection');
const config = require('../../config');
const { verifyPassword, hashPassword, randomToken, sha256 } = require('../../core/security');
const { unauthorized, badRequest } = require('../../core/errors');
const { audit } = require('../../core/audit');

const FIND_USER_SQL = `SELECT * FROM users WHERE email = ?`;

function sessionExpiryDate() {
  return new Date(Date.now() + config.sessionTtlHours * 3600 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
}

/**
 * Autentica e abre uma sessão.
 * Retorna { token, user } ou lança ApiError (401) com mensagem genérica
 * (não revela se o e-mail existe — anti enumeração de contas).
 */
async function login({ email, password, req }) {
  const user = await db.prepare(FIND_USER_SQL).get(email);

  const fail = () => {
    audit({ req, userId: user ? user.id : null, action: 'auth.login_failed', metadata: { email } });
    throw unauthorized('E-mail ou senha inválidos.', undefined);
  };

  if (!user) fail();
  if (!verifyPassword(password, user.password_hash)) fail();
  if (user.status !== 'active') {
    audit({ req, userId: user.id, action: 'auth.login_blocked', metadata: { reason: 'inactive_user' } });
    throw unauthorized('Usuário desativado. Contate o administrador.');
  }

  if (user.company_id !== null) {
    const company = await db.prepare('SELECT status FROM companies WHERE id = ?').get(user.company_id);
    if (!company || company.status !== 'active') {
      throw unauthorized('Empresa suspensa. Contate a Oficial Link Sistemas.');
    }
    // Modo de manutenção da plataforma: bloqueia login de tenants (Master segue)
    const maint = await db.prepare('SELECT value FROM platform_settings WHERE key = ?').get('maintenance_mode');
    if (maint && maint.value === '1') {
      audit({ req, companyId: user.company_id, userId: user.id, action: 'auth.login_blocked', metadata: { reason: 'maintenance_mode' } });
      throw unauthorized('Sistema em manutenção. Tente novamente em alguns minutos.');
    }
  }

  const token = randomToken(32);
  await db.prepare(
    `INSERT INTO sessions (token_hash, user_id, ip, user_agent, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(sha256(token), user.id, req.ip, String(req.headers['user-agent'] || '').slice(0, 255), sessionExpiryDate());

  await db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).run(user.id);
  audit({ req, companyId: user.company_id, userId: user.id, action: 'auth.login' });

  return { token, userId: user.id };
}

async function logout(sessionId) {
  await db.prepare(`UPDATE sessions SET revoked_at = datetime('now') WHERE id = ?`).run(sessionId);
}

/**
 * Troca a própria senha: exige a senha atual e revoga as demais sessões.
 */
async function changePassword({ userId, sessionId, currentPassword, newPassword, req }) {
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw unauthorized();
  if (!verifyPassword(currentPassword, user.password_hash)) {
    throw badRequest('A senha atual está incorreta.');
  }
  if (verifyPassword(newPassword, user.password_hash)) {
    throw badRequest('A nova senha deve ser diferente da senha atual.');
  }
  await db.prepare(
    `UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = datetime('now') WHERE id = ?`
  ).run(hashPassword(newPassword), userId);
  await db.prepare(
    `UPDATE sessions SET revoked_at = datetime('now')
     WHERE user_id = ? AND revoked_at IS NULL AND id != ?`
  ).run(userId, sessionId);
  audit({ req, companyId: user.company_id, userId, action: 'auth.password_changed' });
}

module.exports = { login, logout, changePassword, sessionExpiryDate };
