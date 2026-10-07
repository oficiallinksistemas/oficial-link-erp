'use strict';

/** Segurança: endpoints protegidos, injeção, privilégio, CSRF, rate limit, headers. */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { api, login, authed, boot, shutdown, passwordFor } = require('./helpers');

after(shutdown);

test('endpoints protegidos exigem autenticação', async () => {
  for (const p of ['/auth/me', '/stores', '/users', '/company', '/dashboard/summary', '/platform/companies']) {
    const r = await api(p);
    assert.equal(r.status, 401, `${p} deveria exigir autenticação`);
  }
});

test('SQL injection no login é bloqueado (400 validação ou 401 — nunca 500)', async () => {
  const r = await login("' OR '1'='1", 'x');
  assert.ok([400, 401].includes(r.status), `status inesperado: ${r.status}`);
  assert.notEqual(r.status, 500);
});

test('SQL injection em parâmetro de busca não quebra nem vaza dados', async () => {
  const { cookie } = await login('admin@anjos.com.br', 'Anjos@2026');
  const r = await authed(cookie)('/stores?search=' + encodeURIComponent("' OR 1=1 --"));
  assert.equal(r.status, 200);
  assert.equal(r.data.total, 0, 'busca com injeção deve retornar vazio, não tudo');
});

test('payload JSON malformado → 400 controlado', async () => {
  const r = await api('/auth/login', { method: 'POST', body: undefined, raw: '{quebrado' });
  assert.equal(r.status, 400);
  assert.equal(r.error.code, 'BAD_JSON');
});

test('payload excedendo limite → 413', async () => {
  const big = { name: 'x'.repeat(300 * 1024) };
  const r = await api('/auth/login', { method: 'POST', body: big });
  assert.equal(r.status, 413);
});

test('privilege escalation: usuário não vira Master via API', async () => {
  const { cookie } = await login('admin@anjos.com.br', 'Anjos@2026');
  const create = await authed(cookie)('/users', {
    method: 'POST',
    body: { name: 'Hack', email: 'hack@x.com', password: '12345678', role_slug: 'master' },
  });
  assert.equal(create.status, 400);
  const me = await authed(cookie)('/auth/me');
  const selfPatch = await authed(cookie)(`/users/${me.data.user.id}`, { method: 'PATCH', body: { role_slug: 'master' } });
  assert.equal(selfPatch.status, 403);
});

test('usuário não altera a própria função/status (anti-autoescalação)', async () => {
  const { cookie } = await login('admin@anjos.com.br', 'Anjos@2026');
  const me = await authed(cookie)('/auth/me');
  const r = await authed(cookie)(`/users/${me.data.user.id}`, { method: 'PATCH', body: { role_slug: 'seller', status: 'inactive' } });
  assert.equal(r.status, 403);
});

test('company_id enviado pelo cliente é ignorado', async () => {
  const { cookie } = await login('admin@anjos.com.br', 'Anjos@2026');
  const me = await authed(cookie)('/auth/me');
  const r = await authed(cookie)(`/users/${me.data.user.id}`, { method: 'PATCH', body: { company_id: 999, name: 'Novo Nome' } });
  assert.equal(r.status, 200);
  const me2 = await authed(cookie)('/auth/me');
  assert.equal(me2.data.company.id, me.data.company.id, 'empresa não pode mudar');
});

test('CSRF: Origin divergente em escrita é bloqueado; Origin correto passa', async () => {
  const port = (await boot()).split(':').pop();
  const pwd = passwordFor('admin@anjos.com.br') || 'Anjos@2026';
  const evil = await api('/auth/login', {
    method: 'POST', body: { email: 'admin@anjos.com.br', password: pwd },
    origin: 'http://evil.example.com',
  });
  assert.equal(evil.status, 403);
  assert.equal(evil.error.code, 'BAD_ORIGIN');
  const good = await api('/auth/login', {
    method: 'POST', body: { email: 'admin@anjos.com.br', password: pwd },
    origin: `http://127.0.0.1:${port}`,
  });
  assert.equal(good.status, 200);
});

test('rate limiting: 6ª tentativa de login seguida → 429', async () => {
  const codes = [];
  for (let i = 0; i < 6; i++) {
    const r = await login('ratelimit@seguranca.com', 'errada123');
    codes.push(r.status);
  }
  assert.deepEqual(codes, [401, 401, 401, 401, 401, 429]);
});

test('headers de segurança presentes e X-Powered-By removido', async () => {
  const res = await fetch((await boot()) + '/');
  assert.ok(res.headers.get('content-security-policy'), 'CSP ausente');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.ok(!res.headers.get('x-powered-by'));
});

test('erro interno não expõe stack trace ao cliente', async () => {
  const r = await api('/definitivamente-nao-existe');
  assert.equal(r.status, 404);
  assert.ok(!JSON.stringify(r).match(/at Object|node_modules|\.js:\d+/), 'stack vazado na resposta');
});
