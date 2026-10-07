'use strict';

/**
 * v1.1.2 — polimento de segurança e produção:
 * - usuários do seed nascem com troca de senha obrigatória;
 * - senha nunca aparece em resposta nem em auditoria;
 * - TRUST_PROXY configurável (sem aceitar valor do cliente);
 * - APP_ORIGIN configurável: CSRF com allowlist fixa em produção.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
// helpers SEMPRE primeiro (define DB_FILE antes de qualquer require do src/)
const { api, authed, shutdown, dbFile } = require('./helpers');
const config = require('../src/config');

after(shutdown);

// Usa api() direto (sem o auto-troca do helper) para inspecionar o flag.
async function rawLogin(email, password) {
  return api('/auth/login', { method: 'POST', body: { email, password } });
}

test('usuários do seed nascem com must_change_password=1', async () => {
  for (const email of ['master@oficiallink.com.br', 'admin@anjos.com.br',
    'supervisor@anjos.com.br', 'vendedor@anjos.com.br']) {
    const r = await rawLogin(email, email.startsWith('master') ? 'Master@2026' : 'Anjos@2026');
    assert.equal(r.status, 200, `login do seed falhou para ${email}`);
    const me = await api('/auth/me', { cookie: r.cookie });
    assert.equal(me.data.user.mustChangePassword, true, `${email} deveria exigir troca de senha`);
  }
});

test('fluxo completo: dashboard bloqueado → troca permitida → acesso liberado', async () => {
  const r = await rawLogin('admin@anjos.com.br', 'Anjos@2026');
  assert.equal(r.status, 200);

  const blocked = await api('/dashboard/summary', { cookie: r.cookie });
  assert.equal(blocked.status, 403);
  assert.match(blocked.error.message, /trocar sua senha/i);

  // rotas essenciais continuam permitidas durante a troca obrigatória
  assert.equal((await api('/auth/me', { cookie: r.cookie })).status, 200);

  const changed = await api('/auth/change-password', {
    method: 'POST', cookie: r.cookie,
    body: { current_password: 'Anjos@2026', new_password: 'SenhaDefinitiva@99' },
  });
  assert.equal(changed.status, 200);

  assert.equal((await api('/auth/me', { cookie: r.cookie })).data.user.mustChangePassword, false);
  assert.equal((await api('/dashboard/summary', { cookie: r.cookie })).status, 200);
  assert.equal((await rawLogin('admin@anjos.com.br', 'Anjos@2026')).status, 401, 'senha inicial deve morrer após a troca');
  assert.equal((await rawLogin('admin@anjos.com.br', 'SenhaDefinitiva@99')).status, 200);
});

test('senha nunca aparece na resposta da API nem na auditoria', async () => {
  const r = await rawLogin('supervisor@anjos.com.br', 'Anjos@2026');
  const loginBody = JSON.stringify(r);
  assert.ok(!loginBody.includes('Anjos@2026'), 'senha vazou no login');
  assert.ok(!('password' in (r.data || {})), 'campo password na resposta');

  await api('/auth/change-password', {
    method: 'POST', cookie: r.cookie,
    body: { current_password: 'Anjos@2026', new_password: 'SupDefinitiva@77' },
  });

  const master = await rawLogin('master@oficiallink.com.br', 'Master@2026');
  await api('/auth/change-password', {
    method: 'POST', cookie: master.cookie,
    body: { current_password: 'Master@2026', new_password: 'MasterDefinitiva@55' },
  });
  const audit = await api('/platform/audit?per_page=50', { cookie: master.cookie });
  const auditBody = JSON.stringify(audit.data);
  assert.ok(!auditBody.includes('Anjos@2026'), 'senha inicial vazou na auditoria');
  assert.ok(!auditBody.includes('SupDefinitiva@77'), 'nova senha vazou na auditoria');
  assert.ok(!auditBody.includes('Master@2026') && !auditBody.includes('MasterDefinitiva@55'), 'senha do master vazou');
  assert.ok(!auditBody.includes('password_hash') && !auditBody.includes('token_hash'), 'hash vazou');
});

test('TRUST_PROXY configurável via ambiente (padrão seguro em produção)', () => {
  const cfgPath = path.join(__dirname, '..', 'src', 'config', 'index.js');
  const run = (env) => {
    const setup = env.TRUST_PROXY === undefined
      ? 'delete process.env.TRUST_PROXY;'
      : `process.env.TRUST_PROXY='${env.TRUST_PROXY}';`;
    return execFileSync(process.execPath, ['-p',
      `process.env.NODE_ENV='${env.NODE_ENV}'; ${setup} require('${cfgPath}').trustProxy`],
      { encoding: 'utf8' }).replace(/\x1b\[[0-9;]*m/g, '').trim();
  };

  assert.equal(run({ NODE_ENV: 'test' }), '1', 'dev/test deve manter comportamento funcional');
  assert.equal(run({ NODE_ENV: 'production' }), 'false', 'produção sem proxy deve IGNORAR X-Forwarded-For');
  assert.equal(run({ NODE_ENV: 'production', TRUST_PROXY: '1' }), '1', 'produção com proxy configurado');
  assert.equal(run({ NODE_ENV: 'production', TRUST_PROXY: 'loopback' }), 'loopback');
});

test('CSRF com APP_ORIGIN: compara ORIGEM COMPLETA (protocolo + host + porta)', async () => {
  const port = (await require('./helpers').boot()).split(':').pop();

  // 1) sem APP_ORIGIN: localhost funciona, externo bloqueia
  const localhost = await api('/auth/login', {
    method: 'POST', body: { email: 'admin@anjos.com.br', password: 'x' },
    origin: `http://127.0.0.1:${port}`,
  });
  assert.equal(localhost.status, 401, 'origin local deve passar (401 = credencial, não CSRF)');
  const external = await api('/auth/login', {
    method: 'POST', body: { email: 'admin@anjos.com.br', password: 'x' },
    origin: 'https://evil.example.com',
  });
  assert.equal(external.status, 403);

  // 2) APP_ORIGIN fixada: SOMENTE a origem exata (protocolo + host + porta)
  config.appOrigin = 'https://erp.oficiallink.com';
  try {
    const exact = await api('/auth/login', {
      method: 'POST', body: { email: 'admin@anjos.com.br', password: 'x' },
      origin: 'https://erp.oficiallink.com',
    });
    assert.equal(exact.status, 401, 'origem exata deve passar');

    const httpVariant = await api('/auth/login', {
      method: 'POST', body: { email: 'admin@anjos.com.br', password: 'x' },
      origin: 'http://erp.oficiallink.com',
    });
    assert.equal(httpVariant.status, 403, 'HTTP deve ser bloqueado quando APP_ORIGIN é HTTPS');

    const portVariant = await api('/auth/login', {
      method: 'POST', body: { email: 'admin@anjos.com.br', password: 'x' },
      origin: 'https://erp.oficiallink.com:8443',
    });
    assert.equal(portVariant.status, 403, 'porta diferente deve ser bloqueada');

    const otherDomain = await api('/auth/login', {
      method: 'POST', body: { email: 'admin@anjos.com.br', password: 'x' },
      origin: 'https://outrodominio.com',
    });
    assert.equal(otherDomain.status, 403, 'domínio diferente deve ser bloqueado');

    const localhostBlocked = await api('/auth/login', {
      method: 'POST', body: { email: 'admin@anjos.com.br', password: 'x' },
      origin: `http://127.0.0.1:${port}`,
    });
    assert.equal(localhostBlocked.status, 403, 'localhost deve bloquear quando APP_ORIGIN está fixada');
  } finally {
    config.appOrigin = null;
  }

  // 3) destravou: localhost volta a funcionar
  const back = await api('/auth/login', {
    method: 'POST', body: { email: 'admin@anjos.com.br', password: 'x' },
    origin: `http://127.0.0.1:${port}`,
  });
  assert.equal(back.status, 401);
});

test('APP_ORIGIN inválida rejeita o boot da configuração', () => {
  const cfgPath = path.join(__dirname, '..', 'src', 'config', 'index.js');
  assert.throws(() => execFileSync(process.execPath, ['-p',
    `process.env.APP_ORIGIN='nao-e-url'; require('${cfgPath}').appOrigin`],
    { encoding: 'utf8' }), /APP_ORIGIN inválida/i);
});

// ---------------------------------------------------------------------------
// Seed em produção: credenciais obrigatórias, nenhum padrão conhecido
// ---------------------------------------------------------------------------
const os = require('node:os');
const SERVER_DIR = path.join(__dirname, '..');

function bootAppChild(env) {
  const setup = Object.entries(env)
    .map(([k, v]) => `process.env.${k}=${JSON.stringify(v)};`).join(' ');
  try {
    const out = execFileSync(process.execPath, ['-e',
      `${setup} require(${JSON.stringify(path.join(SERVER_DIR, 'src', 'app'))}); console.log('BOOT_OK')`],
      { encoding: 'utf8', cwd: SERVER_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: out.includes('BOOT_OK'), stderr: '' };
  } catch (err) {
    return { ok: false, stderr: String(err.stderr || err.message) };
  }
}

function tmpDb() {
  return path.join(os.tmpdir(), `olerp-seedtest-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.db`);
}

test('produção sem SEED_MASTER_PASSWORD aborta a instalação inicial', () => {
  const r = bootAppChild({ NODE_ENV: 'production', DB_FILE: tmpDb(), SEED_ANJOS_PASSWORD: 'SoAnjos@1' });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /SEED_MASTER_PASSWORD/);
  assert.match(r.stderr, /Inicialização abortada/i);
});

test('produção sem SEED_ANJOS_PASSWORD aborta a instalação inicial', () => {
  const r = bootAppChild({ NODE_ENV: 'production', DB_FILE: tmpDb(), SEED_MASTER_PASSWORD: 'SoMaster@1' });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /SEED_ANJOS_PASSWORD/);
});

test('produção com ambas as credenciais: seed permitido', () => {
  const r = bootAppChild({
    NODE_ENV: 'production', DB_FILE: tmpDb(),
    SEED_MASTER_PASSWORD: 'ProdMaster@99', SEED_ANJOS_PASSWORD: 'ProdAnjos@99',
  });
  assert.equal(r.ok, true, `boot falhou: ${r.stderr.slice(0, 200)}`);
});

test('desenvolvimento continua usando valores padrão do seed', () => {
  const r = bootAppChild({ NODE_ENV: 'development', DB_FILE: tmpDb() });
  assert.equal(r.ok, true, `boot falhou: ${r.stderr.slice(0, 200)}`);
});

test('banco já inicializado não é alterado nem bloqueado (produção sem seed env)', () => {
  const dbFile = tmpDb();
  // 1ª execução: produção com credenciais → semeia
  const first = bootAppChild({
    NODE_ENV: 'production', DB_FILE: dbFile,
    SEED_MASTER_PASSWORD: 'Keep@123', SEED_ANJOS_PASSWORD: 'Keep@456',
  });
  assert.equal(first.ok, true);
  // 2ª execução: produção SEM credenciais → seed é pulado (banco existe), boot ok
  const second = bootAppChild({ NODE_ENV: 'production', DB_FILE: dbFile });
  assert.equal(second.ok, true, `banco existente não deveria exigir seed: ${second.stderr.slice(0, 200)}`);
});
