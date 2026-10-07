'use strict';

/** Autenticação: login, sessão, logout, revogação, expiração, troca obrigatória. */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
// helpers DEVE ser o primeiro require: ele define DB_FILE do banco de teste
// antes de qualquer importação de config/banco.
const { api, login, authed, shutdown, dbFile } = require('./helpers');
const db = require('../src/database/connection');

after(shutdown);

test('login correto retorna cookie de sessão', async () => {
  const r = await login('admin@anjos.com.br', 'Anjos@2026');
  assert.equal(r.status, 200);
  assert.ok(r.cookie, 'cookie de sessão ausente');
});

test('senha incorreta → 401 com mensagem genérica', async () => {
  const r = await login('admin@anjos.com.br', 'senha-errada-123');
  assert.equal(r.status, 401);
  assert.match(r.error.message, /E-mail ou senha inválidos/);
});

test('usuário inexistente → mesma mensagem genérica (anti-enumeração)', async () => {
  const r = await login('ninguem@lugarnenhum.com', 'qualquercoisa1');
  assert.equal(r.status, 401);
  assert.match(r.error.message, /E-mail ou senha inválidos/);
});

test('sessão válida: /me retorna o contexto da empresa', async () => {
  const { cookie } = await login('admin@anjos.com.br', 'Anjos@2026');
  const me = await authed(cookie)('/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.company.name, 'Anjos');
  assert.equal(typeof me.data.user.mustChangePassword, 'boolean');
});

test('sessão inválida: /me sem cookie → 401', async () => {
  const r = await api('/auth/me');
  assert.equal(r.status, 401);
});

test('logout encerra a sessão', async () => {
  const { cookie } = await login('admin@anjos.com.br', 'Anjos@2026');
  const out = await authed(cookie)('/auth/logout', { method: 'POST' });
  assert.equal(out.status, 200);
  const me = await authed(cookie)('/auth/me');
  assert.equal(me.status, 401);
});

test('revogação por redefinição de senha mata a sessão ativa', async () => {
  const v = await login('vendedor@anjos.com.br', 'Anjos@2026');
  assert.equal(v.status, 200);
  const admin = await login('admin@anjos.com.br', 'Anjos@2026');
  const users = await authed(admin.cookie)('/users?search=vendedor');
  const target = users.data.items[0];
  const reset = await authed(admin.cookie)(`/users/${target.id}/reset-password`, {
    method: 'POST', body: { password: 'NovaSenha@789' },
  });
  assert.equal(reset.status, 200);
  const me = await authed(v.cookie)('/auth/me');
  assert.equal(me.status, 401, 'sessão deveria estar revogada');
});

test('usuário desativado não loga e sessão ativa morre', async () => {
  const seller = await login('vendedor@anjos.com.br', 'NovaSenha@789');
  assert.equal(seller.status, 200);
  const admin = await login('admin@anjos.com.br', 'Anjos@2026');
  const users = await authed(admin.cookie)('/users?search=vendedor');
  const target = users.data.items[0];
  await authed(admin.cookie)(`/users/${target.id}`, { method: 'PATCH', body: { status: 'inactive' } });
  const relogin = await login('vendedor@anjos.com.br', 'NovaSenha@789');
  assert.equal(relogin.status, 401, 'login de usuário inativo deveria falhar');
  const me = await authed(seller.cookie)('/auth/me');
  assert.equal(me.status, 401);
  await authed(admin.cookie)(`/users/${target.id}`, { method: 'PATCH', body: { status: 'active' } });
});

test('empresa suspensa: login e sessão bloqueados; reativação restaura', async () => {
  const admin = await login('admin@anjos.com.br', 'Anjos@2026');
  const master = await login('master@oficiallink.com.br', 'Master@2026');
  const companies = await authed(master.cookie)('/platform/companies?search=Anjos');
  const anjos = companies.data.items[0];
  const susp = await authed(master.cookie)(`/platform/companies/${anjos.id}`, { method: 'PATCH', body: { status: 'suspended' } });
  assert.equal(susp.status, 200);
  const blockedLogin = await login('admin@anjos.com.br', 'Anjos@2026');
  assert.equal(blockedLogin.status, 401);
  assert.match(blockedLogin.error.message, /suspensa/i);
  const blockedSession = await authed(admin.cookie)('/auth/me');
  assert.equal(blockedSession.status, 401);
  const reat = await authed(master.cookie)(`/platform/companies/${anjos.id}`, { method: 'PATCH', body: { status: 'active' } });
  assert.equal(reat.status, 200);
  const relogin = await login('admin@anjos.com.br', 'Anjos@2026');
  assert.equal(relogin.status, 200);
});

test('sessão expirada é rejeitada', async () => {
  const { cookie } = await login('admin@anjos.com.br', 'Anjos@2026');
  db.prepare(`UPDATE sessions SET expires_at = '2000-01-01 00:00:00' WHERE revoked_at IS NULL`).run();
  const me = await authed(cookie)('/auth/me');
  assert.equal(me.status, 401);
  assert.match(me.error.message, /expirou/i);
});

test('troca de senha obrigatória: bloqueia uso até trocar', async () => {
  const master = await login('master@oficiallink.com.br', 'Master@2026');
  assert.equal(master.status, 200, 'login do master falhou');

  const companies = await authed(master.cookie)('/platform/companies?search=Anjos');
  assert.equal(companies.status, 200, 'listagem de empresas falhou');
  const anjos = companies.data.items[0];

  const users = await authed(master.cookie)(`/platform/users?company_id=${anjos.id}&search=vendedor`);
  assert.equal(users.status, 200, 'listagem de usuários falhou');
  assert.ok(users.data.items.length >= 1, 'vendedor não encontrado');
  const seller = users.data.items[0];

  const reset = await authed(master.cookie)(`/platform/users/${seller.id}/reset-password`, {
    method: 'POST', body: { password: 'Temporaria@1' },
  });
  assert.equal(reset.status, 200, 'reset de senha falhou');

  // login direto (sem o auto-troca do helper) para inspecionar o flag real
  const relogin = await api('/auth/login', { method: 'POST', body: { email: 'vendedor@anjos.com.br', password: 'Temporaria@1' } });
  assert.equal(relogin.status, 200, 'relogin com senha temporária falhou');
  assert.ok(relogin.cookie, 'cookie do relogin ausente');

  const me = await authed(relogin.cookie)('/auth/me');
  assert.equal(me.status, 200, `/auth/me falhou: ${JSON.stringify(me.error)}`);
  assert.equal(me.data.user.mustChangePassword, true);

  const blocked = await authed(relogin.cookie)('/dashboard/summary');
  assert.equal(blocked.status, 403);
  assert.match(blocked.error.message, /trocar sua senha/i);

  const changed = await authed(relogin.cookie)('/auth/change-password', {
    method: 'POST', body: { current_password: 'Temporaria@1', new_password: 'SenhaFinal@9' },
  });
  assert.equal(changed.status, 200, 'troca de senha falhou');

  const me2 = await authed(relogin.cookie)('/auth/me');
  assert.equal(me2.data.user.mustChangePassword, false);

  const ok = await authed(relogin.cookie)('/dashboard/summary');
  assert.equal(ok.status, 200);
});
