'use strict';

/**
 * Configuração central do servidor.
 * - Variáveis de ambiente + arquivo .env na raiz do server/ (loader próprio,
 *   sem dependências).
 * - Caminhos sempre resolvidos a partir da RAIZ DO PROJETO (a pasta
 *   oficial-link-erp/), em qualquer ambiente:
 *     dev/teste/produção → <raiz>/data/erp.db   (padrão de DB_FILE)
 *   Em testes automatizados, exporte DB_FILE apontando para um arquivo
 *   temporário ANTES de importar o app (ver server/tests/helpers.js).
 */

const fs = require('fs');
const path = require('path');

function loadEnvFile() {
  // No Worker não há filesystem: wrangler [vars]/secrets populam process.env
  // (nodejs_compat_populate_process_env). Falhas de fs são ignoradas.
  let envPath;
  try {
    envPath = path.join(__dirname, '..', '..', '.env');
    if (!fs.existsSync(envPath)) return;
  } catch {
    return;
  }
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

loadEnvFile();

const isProd = process.env.NODE_ENV === 'production';
const projectRoot = path.join(__dirname, '..', '..', '..');

const config = {
  isProd,
  isTest: process.env.NODE_ENV === 'test',
  port: parseInt(process.env.PORT || '3000', 10),
  cookieName: 'ol_session',
  secureCookies: process.env.SECURE_COOKIES === '1' || isProd,
  sessionTtlHours: parseInt(process.env.SESSION_TTL_HOURS || '8', 10),
  // Sempre relativo à raiz do projeto — nunca a server/data nem ao cwd.
  dbFile: path.resolve(projectRoot, process.env.DB_FILE || path.join('data', 'erp.db')),
  projectRoot,
  /**
   * Proxy confiável para req.ip (usado em rate limit e logs de auditoria).
   * SOMENTE desta variável de ambiente — nunca de valor enviado pelo cliente.
   * Dev/test: 1 (aceita o proxy local). Prod: DESLIGADO por padrão — o
   * X-Forwarded-For do cliente é ignorado, a menos que você configure
   * explicitamente (ex.: TRUST_PROXY=1 atrás de um proxy reverso, ou
   * TRUST_PROXY=loopback).
   */
  trustProxy: process.env.TRUST_PROXY !== undefined
    ? (Number.isNaN(Number(process.env.TRUST_PROXY)) ? process.env.TRUST_PROXY : Number(process.env.TRUST_PROXY))
    : (isProd ? false : 1),
  /**
   * Origem pública do app (produção, ex.: https://erp.oficiallink.com).
   * Quando definida, a proteção CSRF aceita APENAS esta origem — sem depender
   * do Host recebido. Dev/test: null → validação pelo Host da requisição
   * (localhost continua funcionando).
   */
  appOrigin: (() => {
    const v = process.env.APP_ORIGIN;
    if (!v) return null;
    try {
      return new URL(v).origin;
    } catch {
      throw new Error('APP_ORIGIN inválida: use uma URL absoluta (ex.: https://erp.oficiallink.com)');
    }
  })(),
  // Senhas do seed. DEV/TEST: valores padrão conhecidos são aceitos.
  // PRODUÇÃO: NENHUM padrão — as duas são obrigatórias para a instalação
  // inicial (o seed aborta a inicialização se faltarem; bancos já
  // inicializados nunca são afetados, pois o seed só roda com banco vazio).
  seedPasswords: {
    master: process.env.SEED_MASTER_PASSWORD || (isProd ? null : 'Master@2026'),
    anjos: process.env.SEED_ANJOS_PASSWORD || (isProd ? null : 'Anjos@2026'),
  },
};

if (!isProd && !config.isTest) {
  console.log('[config] Modo de desenvolvimento. Defina NODE_ENV=production em produção.');
}

module.exports = config;
