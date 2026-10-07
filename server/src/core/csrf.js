'use strict';

/**
 * Proteção CSRF / validação de Origin.
 *
 * A sessão usa cookie HttpOnly + SameSite=Lax (o Lax já bloqueia POST
 * cross-site na maioria dos casos). Esta camada reforça: toda requisição que
 * ALTERA dados (POST/PUT/PATCH/DELETE) e trouxer um cabeçalho Origin precisa
 * ter origem permitida:
 *
 *  - APP_ORIGIN configurada (produção): aceita APENAS essa origem — sem
 *    depender do Host recebido na requisição.
 *  - APP_ORIGIN ausente (dev/test): aceita somente se a origem bater com o
 *    Host da própria requisição (localhost e IPs locais seguem funcionando).
 *
 * Requisições sem Origin (integrações server-to-server, CLI) seguem — a
 * autenticação por cookie continua sendo o fator decisivo.
 */

const config = require('../config');

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function reject(res) {
  return res.status(403).json({
    ok: false,
    error: { code: 'BAD_ORIGIN', message: 'Origem da requisição não permitida.' },
  });
}

function csrfOriginProtection(req, res, next) {
  if (!MUTATING.has(req.method)) return next();

  const origin = req.headers.origin;
  if (!origin) return next();

  let requestOrigin = null;
  try {
    requestOrigin = new URL(origin).origin; // protocolo + host + porta, normalizado
  } catch {
    return reject(res);
  }

  // Modo produção: allowlist fixa (ORIGEM COMPLETA — protocolo, host e porta)
  if (config.appOrigin) {
    if (requestOrigin !== config.appOrigin) return reject(res);
    return next();
  }

  // Modo desenvolvimento/teste: origem deve bater com o Host da requisição
  if (new URL(origin).host !== req.headers.host) return reject(res);
  next();
}

module.exports = { csrfOriginProtection };
