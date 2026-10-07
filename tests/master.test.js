'use strict';

/** Master Platform Admin: controle total sobre tenants + segurança do acesso. */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { login, authed, createTenant, shutdown } = require('./helpers');

let masterClient;

before(async () => {
  const master = await login('master@oficiallink.com.br', 'Master@2026');
  assert.equal(master.status, 200);
  masterClient = authed(master.cookie);
});

after(shutdown);

test('Master tem permissões de plataforma completas', async () => {
  const me = await masterClient('/auth/me');
  for (const p of ['platform.overview.view', 'platform.companies.manage', 'platform.stores.manage',
    'platform.users.manage', 'platform.audit.view', 'platform.settings.manage']) {
    assert.ok(me.data.permissions.includes(p), `permissão ausente: ${p}`);
  }
  assert.equal(me.data.company, null);
});

test('visão geral retorna números reais da plataforma', async () => {
  const o = await masterClient('/platform/overview');
  assert.equal(o.status, 200);
  assert.ok(o.data.companies.total >= 1);
  assert.ok(o.data.users >= 3);
});

test('Master administra empresas: criar, editar, suspender, reativar', async () => {
  const created = await masterClient('/platform/companies', { method: 'POST', body: { name: 'Empresa Master Teste' } });
  assert.equal(created.status, 201);
  const id = created.data.id;
  const edited = await masterClient(`/platform/companies/${id}`, { method: 'PATCH', body: { trade_name: 'EMT', plan: 'pro' } });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.plan, 'pro');
  const suspended = await masterClient(`/platform/companies/${id}`, { method: 'PATCH', body: { status: 'suspended' } });
  assert.equal(suspended.data.status, 'suspended');
  const reactivated = await masterClient(`/platform/companies/${id}`, { method: 'PATCH', body: { status: 'active' } });
  assert.equal(reactivated.data.status, 'active');
});

test('Master administra lojas de qualquer empresa', async () => {
  const anjos = (await masterClient('/platform/companies?search=Anjos')).data.items[0];
  const created = await masterClient('/platform/stores', {
    method: 'POST', body: { company_id: anjos.id, name: 'Loja do Master', code: 'MASTER1', state: 'MA' },
  });
  assert.equal(created.status, 201);
  const edited = await masterClient(`/platform/stores/${created.data.id}`, { method: 'PATCH', body: { city: 'São Luís' } });
  assert.equal(edited.data.city, 'São Luís');
  const list = await masterClient(`/platform/stores?company_id=${anjos.id}`);
  assert.equal(list.data.total, 3);
});

test('Master administra usuários de qualquer empresa', async () => {
  const tenant = await createTenant(masterClient, 'EmpresaC');
  const anjos = (await masterClient('/platform/companies?search=Anjos')).data.items[0];
  const created = await masterClient('/platform/users', {
    method: 'POST',
    body: { company_id: anjos.id, name: 'Usuario Master', email: 'mastercriou@anjos.com', password: 'Criada@123', role_slug: 'supervisor' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.must_change_password, 1, 'troca obrigatória por padrão');
  const edited = await masterClient(`/platform/users/${created.data.id}`, { method: 'PATCH', body: { name: 'Usuario Master Editado' } });
  assert.equal(edited.data.name, 'Usuario Master Editado');
  await masterClient(`/platform/users/${created.data.id}`, { method: 'PATCH', body: { status: 'inactive' } });
  const relogin = await login('mastercriou@anjos.com', 'Criada@123');
  assert.equal(relogin.status, 401, 'usuário inativo não loga');
  await masterClient(`/platform/users/${created.data.id}`, { method: 'PATCH', body: { status: 'active' } });
  assert.equal((await login('mastercriou@anjos.com', 'Criada@123')).status, 200);
  assert.ok(tenant.company.id > 0);
});

test('Master redefini senha (com troca obrigatória) e revoga sessões', async () => {
  const anjos = (await masterClient('/platform/companies?search=Anjos')).data.items[0];
  const u = await masterClient('/platform/users', {
    method: 'POST',
    body: { company_id: anjos.id, name: 'Alvo Revogacao', email: 'alvo@anjos.com', password: 'Inicial@123', role_slug: 'seller' },
  });
  const sess = await login('alvo@anjos.com', 'Inicial@123');
  assert.equal(sess.status, 200);
  const reset = await masterClient(`/platform/users/${u.data.id}/reset-password`, { method: 'POST', body: { password: 'Temp@99999' } });
  assert.equal(reset.status, 200);
  assert.equal((await authed(sess.cookie)('/auth/me')).status, 401, 'reset revoga sessões');
  const sess2 = await login('alvo@anjos.com', 'Temp@99999');
  assert.equal(sess2.status, 200);
  const revoke = await masterClient(`/platform/users/${u.data.id}/revoke-sessions`, { method: 'POST' });
  assert.equal(revoke.status, 200);
  assert.equal((await authed(sess2.cookie)('/auth/me')).status, 401, 'revogar sessões deve derrubar o usuário');
});

test('Master NUNCA é criável/editável por tenants e não aparece na listagem', async () => {
  const users = await masterClient('/platform/users');
  assert.ok(users.data.items.every((u) => u.role_slug !== 'master'), 'master não pode aparecer entre usuários de empresa');
  const anjosAdmin = await login('admin@anjos.com.br', 'Anjos@2026');
  const r = await authed(anjosAdmin.cookie)('/platform/users', { method: 'POST', body: {} });
  assert.equal(r.status, 403);
});

test('Master não pode ser atribuído como função nem por plataforma', async () => {
  const me = await masterClient('/auth/me');
  const r = await masterClient('/platform/users', {
    method: 'POST',
    body: { company_id: 1, name: 'X', email: 'x-master@x.com', password: '12345678', role_slug: 'master' },
  });
  assert.equal(r.status, 400);
  assert.ok(me.data.user.id > 0);
});

test('auditoria registra ações administrativas do Master', async () => {
  const audit = await masterClient('/platform/audit?action=platform.company');
  assert.ok(audit.data.total >= 1, 'eventos de plataforma deveriam existir');
  assert.ok(audit.data.items.every((a) => a.action.startsWith('platform.company')));
});

test('modo de manutenção: bloqueia tenants, nunca o Master', async () => {
  const on = await masterClient('/platform/settings', { method: 'PATCH', body: { maintenance_mode: true } });
  assert.equal(on.status, 200);
  const tenantLogin = await login('admin@anjos.com.br', 'Anjos@2026');
  assert.equal(tenantLogin.status, 401);
  assert.match(tenantLogin.error.message, /manutenção/i);
  const masterLogin = await login('master@oficiallink.com.br', 'Master@2026');
  assert.equal(masterLogin.status, 200, 'Master nunca é bloqueado');
  const off = await authed(masterLogin.cookie)('/platform/settings', { method: 'PATCH', body: { maintenance_mode: false } });
  assert.equal(off.status, 200);
  assert.equal((await login('admin@anjos.com.br', 'Anjos@2026')).status, 200);
});

test('usuário comum não executa NENHUMA ação de plataforma', async () => {
  const { cookie } = await login('admin@anjos.com.br', 'Anjos@2026');
  const c = authed(cookie);
  for (const p of ['/platform/overview', '/platform/companies', '/platform/stores', '/platform/users', '/platform/audit', '/platform/settings']) {
    assert.equal((await c(p)).status, 403, `${p} deveria ser 403 para tenant`);
  }
});
