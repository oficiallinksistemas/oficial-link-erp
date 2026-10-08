'use strict';

/**
 * Módulo "Minha empresa" — dados cadastrais e configurações do tenant.
 * Apenas usuários vinculados a uma empresa (nunca o Master) acessam aqui.
 */

const express = require('express');
const db = require('../../database/connection');
const { ok } = require('../../core/http');
const { optString, badRequest } = require('../../core/validate');
const { requirePermission, tenantId } = require('../../middlewares/auth');
const { audit } = require('../../core/audit');
const brandingSvc = require('./branding');

const router = express.Router();

const TIMEZONES = ['America/Fortaleza', 'America/Sao_Paulo', 'America/Belem', 'America/Manaus', 'America/Cuiaba'];

function parseSettings(raw) {
  try {
    const s = JSON.parse(raw || '{}');
    return {
      timezone: TIMEZONES.includes(s.timezone) ? s.timezone : 'America/Fortaleza',
      currency: 'BRL',
    };
  } catch {
    return { timezone: 'America/Fortaleza', currency: 'BRL' };
  }
}

// Este módulo é exclusivo de tenants — o Master (company_id NULL) não acessa
router.use((req, res, next) => {
  if (tenantId(req) === null) {
    return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Módulo exclusivo de empresas.' } });
  }
  next();
});

router.get('/', requirePermission('company.settings.view', 'company.settings.manage'), async (req, res) => {
  const company = await db.prepare('SELECT * FROM companies WHERE id = ?').get(tenantId(req));
  const branding = brandingSvc.parseBranding(company.settings);
  const logo = await brandingSvc.getLogo(company.id);
  return ok(res, {
    id: company.id,
    name: company.name,
    trade_name: company.trade_name,
    document: company.document,
    email: company.email,
    phone: company.phone,
    status: company.status,
    settings: parseSettings(company.settings),
    branding: {
      ...branding,
      logo_url: logo ? `/api/company/branding/logo?t=${encodeURIComponent(logo.updated_at)}` : null,
    },
    created_at: company.created_at,
  });
});

/** Logotipo da empresa autenticada (BLOB; cookie de sessão enviado pelo
 *  navegador em <img> same-origin). Isolamento: somente a própria empresa. */
router.get('/branding/logo', requirePermission('dashboard.view', 'company.settings.view', 'company.settings.manage'), async (req, res) => {
  const logo = await brandingSvc.getLogo(tenantId(req));
  if (!logo) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Logotipo não configurado.' } });
  res.set('Content-Type', logo.mime);
  res.set('Cache-Control', 'private, max-age=3600');
  return res.send(logo.data);
});

router.patch('/', requirePermission('company.settings.manage'), async (req, res, next) => {
  try {
    const companyId = tenantId(req);
    const data = {
      name: optString(req.body?.name, 'Nome', { min: 2, max: 120 }),
      trade_name: optString(req.body?.trade_name, 'Nome fantasia', { max: 120 }),
      document: optString(req.body?.document, 'CNPJ', { max: 20 }),
      email: optString(req.body?.email, 'E-mail', { max: 190 }),
      phone: optString(req.body?.phone, 'Telefone', { max: 30 }),
      timezone: optString(req.body?.timezone, 'Fuso horário', { max: 60 }),
    };
    if (data.timezone && !TIMEZONES.includes(data.timezone)) {
      throw badRequest('Fuso horário inválido.');
    }
    // Branding (v3.1): validado no backend; logo_data=null remove o logo.
    const brandingPatch = req.body?.branding ? brandingSvc.validateBrandingPayload(req.body.branding) : {};
    const logoData = req.body?.logo_data;

    const current = await db.prepare('SELECT settings FROM companies WHERE id = ?').get(companyId);
    // PRESERVAÇÃO DE SETTINGS (V3.1.1): partir do JSON completo armazenado e
    // alterar APENAS as propriedades solicitadas — chaves desconhecidas/futuras
    // nunca são descartadas (não é whitelist; é merge seguro).
    let rawSettings = {};
    try { rawSettings = JSON.parse(current.settings || '{}'); } catch { rawSettings = {}; }
    if (!rawSettings || typeof rawSettings !== 'object' || Array.isArray(rawSettings)) rawSettings = {};
    if (data.timezone) rawSettings.timezone = data.timezone;
    const currentBranding = (rawSettings.branding && typeof rawSettings.branding === 'object') ? rawSettings.branding : {};
    rawSettings.branding = { ...currentBranding, ...brandingPatch };
    const settingsJson = JSON.stringify(rawSettings);

    // Guard-first (mesma semântica da transação original): logo primeiro
    // (operação separada, sem rollback possível), depois UPDATE único da
    // empresa — atômico por si só.
    if (logoData !== undefined) {
      if (logoData === null) {
        await brandingSvc.clearLogo(companyId);
      } else {
        await brandingSvc.saveLogo(companyId, brandingSvc.decodeLogo(logoData));
      }
    }
    await db.prepare(
      `UPDATE companies SET
         name = COALESCE(?, name),
         trade_name = COALESCE(?, trade_name),
         document = COALESCE(?, document),
         email = COALESCE(?, email),
         phone = COALESCE(?, phone),
         settings = ?,
         updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      data.name ?? null,
      data.trade_name ?? null,
      data.document ?? null,
      data.email ?? null,
      data.phone ?? null,
      settingsJson,
      companyId
    );
    audit({
      req, companyId, userId: req.auth.user.id, action: 'company.branding.update',
      entity: 'companies', entityId: companyId,
      metadata: { fields: Object.keys(brandingPatch), logo: logoData === undefined ? 'unchanged' : logoData === null ? 'cleared' : 'updated' },
    });

    const company = await db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
    const logo = await brandingSvc.getLogo(company.id);
    return ok(res, {
      id: company.id, name: company.name, trade_name: company.trade_name,
      document: company.document, email: company.email, phone: company.phone,
      status: company.status, settings: parseSettings(company.settings),
      branding: {
        ...brandingSvc.parseBranding(company.settings),
        logo_url: logo ? `/api/company/branding/logo?t=${encodeURIComponent(logo.updated_at)}` : null,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
