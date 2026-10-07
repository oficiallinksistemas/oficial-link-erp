'use strict';

/**
 * Registry de módulos — camada central da arquitetura modular.
 *
 * Conceito: PLATAFORMA → MÓDULOS OFICIAIS (tabela `modules`) → EMPRESA →
 * MÓDULOS ATIVOS (tabela `company_modules`) → PERMISSÕES → USUÁRIOS.
 *
 * - A ativação é por EMPRESA e decidida SEMPRE no backend (requireModule).
 * - Desativar um módulo NUNCA apaga dados — apenas bloqueia o uso (403).
 * - O Master (autoridade global) nunca é bloqueado por módulo.
 * - Plano/assinatura (SaaS futuro) é um conceito SEPARADO: definirá quais
 *   módulos a empresa PODE ativar; company_modules define o que ESTÁ ativo.
 */

const db = require('../database/connection');
const { notFound, badRequest } = require('./errors');

function isModuleActive(companyId, slug) {
  if (companyId === null || companyId === undefined) return true; // Master global
  const row = db
    .prepare('SELECT status FROM company_modules WHERE company_id = ? AND module_slug = ?')
    .get(companyId, slug);
  return !!row && row.status === 'active';
}

/** Middleware: exige módulo ativo para o tenant. Master passa sempre. */
function requireModule(slug) {
  return async (req, res, next) => {
    const a = req.auth;
    if (!a) return next();
    if (a.user.companyId === null) return next(); // Master Platform Admin
    if (!await isModuleActive(a.user.companyId, slug)) {
      return res.status(403).json({
        ok: false,
        error: { code: 'MODULE_INACTIVE', message: 'Este módulo não está ativo para a sua empresa.' },
      });
    }
    next();
  };
}

/** Módulos com estado para uma empresa (menu dinâmico do frontend). */
async function modulesForCompany(companyId) {
  return await db.prepare(
    `SELECT m.slug, m.name, m.description, COALESCE(cm.status, 'inactive') AS status
     FROM modules m LEFT JOIN company_modules cm ON cm.module_slug = m.slug AND cm.company_id = ?
     ORDER BY m.name`
  ).all(companyId);
}

/** Ativa/desativa um módulo para uma empresa (somente plataforma/Master). */
async function setModuleStatus(companyId, slug, status) {
  const mod = await db.prepare('SELECT slug FROM modules WHERE slug = ?').get(slug);
  if (!mod) throw notFound('Módulo não encontrado.');
  if (!['active', 'inactive'].includes(status)) throw badRequest('Status inválido.');
  await db.prepare(
    `INSERT INTO company_modules (company_id, module_slug, status, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(company_id, module_slug) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`
  ).run(companyId, slug, status);
  return { company_id: companyId, module_slug: slug, status };
}

module.exports = { isModuleActive, requireModule, modulesForCompany, setModuleStatus };
