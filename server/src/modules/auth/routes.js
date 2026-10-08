'use strict';

const express = require('express');
const config = require('../../config');
const db = require('../../database/connection');
const { ok, serializeCookie } = require('../../core/http');
const { reqEmail, reqPassword, reqString } = require('../../core/validate');
const { createFailureLimiter } = require('../../core/rateLimit');
const { authenticate } = require('../../middlewares/auth');
const service = require('./service');

const router = express.Router();

// Anti força bruta: 5 FALHAS por IP + e-mail a cada 10 minutos.
// Logins corretos não contaminam o contador (nem bloqueiam o usuário legítimo).
const loginGuard = createFailureLimiter({ windowMs: 10 * 60 * 1000, max: 5 });

function setSessionCookie(res, token) {
  res.append(
    'Set-Cookie',
    serializeCookie(config.cookieName, token, {
      maxAge: config.sessionTtlHours * 3600,
      secure: config.secureCookies,
    })
  );
}

function clearSessionCookie(res) {
  res.append('Set-Cookie', serializeCookie(config.cookieName, '', { maxAge: 0, secure: config.secureCookies }));
}

async function mePayload(auth) {
  // Autoridade global: o Master recebe TODAS as permissões do catálogo —
  // incluindo permissões de módulos futuros — sem depender de vínculos
  // individuais em role_permissions. O frontend usa a flag globalAdmin
  // para refletir a mesma regra (a decisão final, porém, é sempre do backend).
  const globalAdmin = auth.user.companyId === null && auth.role.slug === 'master';
  const permissions = globalAdmin
    ? (await db.prepare('SELECT code FROM permissions ORDER BY code').all()).map((p) => p.code)
    : [...auth.permissions];
  const payload = {
    user: {
      id: auth.user.id,
      name: auth.user.name,
      email: auth.user.email,
      lastLoginAt: auth.user.lastLoginAt,
      mustChangePassword: auth.user.mustChangePassword,
    },
    role: auth.role,
    permissions,
    company: auth.company,
    store: auth.store,
    globalAdmin,
  };
  // Identidade visual da empresa (v3.1) — disponível a TODOS os usuários do
  // tenant (não exige company.settings.view, que o vendedor não tem).
  if (auth.company) {
    payload.branding = await buildBranding(auth.company.id, auth.company.name);
  }
  return payload;
}

/** Monta o branding efetivo da empresa (settings + logo versionado). */
async function buildBranding(companyId, companyName) {
  const { parseBranding } = require('../company/branding');
  const row = await db.prepare('SELECT settings FROM companies WHERE id = ?').get(companyId);
  const branding = parseBranding(row?.settings);
  const logo = await db.prepare('SELECT updated_at FROM company_assets WHERE company_id = ?').get(companyId);
  return {
    ...branding,
    company_name: companyName,
    logo_url: logo ? `/api/company/branding/logo?t=${encodeURIComponent(logo.updated_at)}` : null,
  };
}

router.post('/login', async (req, res, next) => {
  try {
    const email = reqEmail(req.body?.email);
    const password = reqString(req.body?.password, 'Senha', { max: 100 });

    const guardKey = `${req.ip}|${email}`;
    const wait = await loginGuard.isBlocked(guardKey);
    if (wait) {
      res.set('Retry-After', String(wait));
      return res.status(429).json({
        ok: false,
        error: { code: 'RATE_LIMITED', message: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' },
      });
    }

    let token;
    try {
      ({ token } = await service.login({ email, password, req }));
      await loginGuard.clear(guardKey);
    } catch (err) {
      if (err.status === 401) await loginGuard.hit(guardKey);
      throw err;
    }

    setSessionCookie(res, token);
    return ok(res, { loggedIn: true });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', authenticate, async (req, res) => {
  await service.logout(req.auth.sessionId);
  clearSessionCookie(res);
  return ok(res, { loggedOut: true });
});

router.get('/me', authenticate, async (req, res) => {
  return ok(res, await mePayload(req.auth));
});

router.post('/change-password', authenticate, async (req, res, next) => {
  try {
    const currentPassword = reqString(req.body?.current_password, 'Senha atual', { max: 100 });
    const newPassword = reqPassword(req.body?.new_password, 'Nova senha');
    await service.changePassword({
      userId: req.auth.user.id,
      sessionId: req.auth.sessionId,
      currentPassword,
      newPassword,
      req,
    });
    return ok(res, { changed: true });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, mePayload };
