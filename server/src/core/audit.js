'use strict';

/**
 * Trilha de auditoria para ações importantes.
 * Registrar falhas nunca deve derrubar a requisição principal.
 */

const db = require('../database/connection');

/**
 * @param {object} p
 * @param {object} [p.req]       requisição Express (ip/user-agent)
 * @param {number|null} p.companyId  empresa do contexto (null para ações do Master)
 * @param {number} [p.userId]    usuário que executou a ação
 * @param {string} p.action      código da ação (ex.: 'auth.login', 'user.create')
 * @param {string} [p.entity]    entidade afetada (ex.: 'users')
 * @param {number} [p.entityId]  id do registro afetado
 * @param {object} [p.metadata]  dados extras (nunca senhas nem segredos)
 */
async function audit({ req, companyId = null, userId = null, action, entity = null, entityId = null, metadata = null }) {
  try {
    await db.prepare(
      `INSERT INTO audit_logs (company_id, user_id, action, entity, entity_id, metadata, ip, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run(
      companyId,
      userId,
      action,
      entity,
      entityId,
      metadata ? JSON.stringify(metadata).slice(0, 2000) : null,
      req ? req.ip : null,
      req ? String(req.headers['user-agent'] || '').slice(0, 255) : null
    );
  } catch (err) {
    console.error('[audit] falha ao registrar evento:', err.message);
  }
}

module.exports = { audit };
