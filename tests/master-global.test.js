'use strict';

/**
 * Autoridade global do Master Platform Admin:
 * - o Master possui TODAS as permissões (presentes e futuras), decidido no
 *   backend, SEM depender de vínculos individuais em role_permissions;
 * - novas permissões inseridas no catálogo são automaticamente concedidas;
 * - usuários comuns seguem o RBAC normal.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
// helpers SEMPRE primeiro (define DB_FILE antes de qualquer require do src/)
const { login, authed, createTenant, shutdown } = require('./helpers');
const db = require('../src/database/connection');

let masterClient;

before(async () => {
  const master = await login('master@oficiallink.com.br', 'Master@2026');
  assert.equal(master.status, 200);
  masterClient = authed(master.cookie);
});

after(shutdown);

test('Master possui globalAdmin=true e catálogo completo no /me', async () => {
  const me = await masterClient('/auth/me');
  assert.equal(me.data.globalAdmin, true);
  const catalog = db.prepare('SELECT code FROM permissions').all().map((p) => p.code);
  assert.deepEqual([...me.data.permissions].sort(), catalog.sort());
});

test('autoridade global NÃO depende de role_permissions: mesmo sem nenhum vínculo, Master administra', async () => {
  const masterRole = db.prepare(`SELECT id FROM roles WHERE slug = 'master'`).get();
  const backup = db.prepare('SELECT permission_code FROM role_permissions WHERE role_id = ?').all(masterRole.id);
  db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(masterRole.id);

  try {
    const me = await masterClient('/auth/me');
    assert.equal(me.data.globalAdmin, true);
    assert.ok(me.data.permissions.length >= 17, 'catálogo completo mesmo sem vínculos');

    const overview = await masterClient('/platform/overview');
    assert.equal(overview.status, 200, 'Master bloqueado sem vínculos — autoridade global falhou');

    const companies = await masterClient('/platform/companies');
    assert.equal(companies.status, 200);

    // tenant continua sujeito ao RBAC normal
    const admin = await login('admin@anjos.com.br', 'Anjos@2026');
    assert.equal((await authed(admin.cookie)('/platform/companies')).status, 403);
    assert.equal((await authed(admin.cookie)('/users')).status, 200, 'RBAC do tenant não pode quebrar');
  } finally {
    const restore = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_code) VALUES (?, ?)');
    for (const row of backup) restore.run(masterRole.id, row.permission_code);
  }
});

test('permissão FUTURA é automaticamente concedida ao Master e negada aos demais', async () => {
  // simula o cenário futuro: nova permissão de módulo ainda inexistente
  db.prepare(`INSERT OR IGNORE INTO permissions (code, module, description) VALUES ('sales.manage', 'Vendas', 'Permissão futura de teste')`).run();
  try {
    const meMaster = await masterClient('/auth/me');
    assert.ok(meMaster.data.permissions.includes('sales.manage'), 'Master deveria ter a permissão futura automaticamente');

    const admin = await login('admin@anjos.com.br', 'Anjos@2026');
    const meAdmin = await authed(admin.cookie)('/auth/me');
    assert.notEqual(meAdmin.data.globalAdmin, true);
    assert.ok(!meAdmin.data.permissions.includes('sales.manage'), 'tenant não pode ter permissão futura não atribuída');
  } finally {
    db.prepare(`DELETE FROM role_permissions WHERE permission_code = 'sales.manage'`).run();
    db.prepare(`DELETE FROM permissions WHERE code = 'sales.manage'`).run();
  }
});

test('Master altera função e loja de usuário de qualquer empresa', async () => {
  const tenant = await createTenant(masterClient, 'EmpresaD');
  const created = await masterClient('/platform/users', {
    method: 'POST',
    body: {
      company_id: tenant.company.id, name: 'Vendedor D', email: 'vendedor@empresad.com',
      password: 'Inicial@123', role_slug: 'seller', store_id: tenant.store.id,
    },
  });
  assert.equal(created.status, 201);

  const edited = await masterClient(`/platform/users/${created.data.id}`, {
    method: 'PATCH',
    body: { role_slug: 'supervisor', store_id: null },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.role_slug, 'supervisor');
  assert.equal(edited.data.store_id, null);
  assert.equal(edited.data.store_name || '', '');
});

test('auditoria registra as ações administrativas do Master', async () => {
  // executa uma ação de cada tipo e verifica o respectivo evento na auditoria
  const anjos = (await masterClient('/platform/companies?search=Anjos')).data.items[0];

  const co = await masterClient('/platform/companies', { method: 'POST', body: { name: 'Empresa Auditoria' } });
  const st = await masterClient('/platform/stores', {
    method: 'POST', body: { company_id: co.data.id, name: 'Loja Audit', code: 'AUDIT1' },
  });
  const us = await masterClient('/platform/users', {
    method: 'POST',
    body: { company_id: co.data.id, name: 'User Audit', email: 'audit@auditoria.com', password: 'Audit@123', role_slug: 'seller' },
  });
  await masterClient(`/platform/users/${us.data.id}/reset-password`, { method: 'POST', body: { password: 'Audit@456' } });
  await masterClient(`/platform/users/${us.data.id}/revoke-sessions`, { method: 'POST' });
  await masterClient(`/platform/companies/${co.data.id}`, { method: 'PATCH', body: { status: 'suspended' } });
  await masterClient(`/platform/companies/${anjos.id}`, { method: 'PATCH', body: { status: 'suspended' } });
  await masterClient(`/platform/companies/${anjos.id}`, { method: 'PATCH', body: { status: 'active' } });
  await masterClient('/platform/settings', { method: 'PATCH', body: { maintenance_mode: true } });
  await masterClient('/platform/settings', { method: 'PATCH', body: { maintenance_mode: false } });

  const expected = [
    'platform.company.create', 'platform.store.create', 'platform.user.create',
    'platform.user.reset_password', 'platform.user.revoke_sessions',
    'platform.company.update', 'platform.settings.update',
  ];
  const audit = await masterClient('/platform/audit?per_page=50');
  assert.equal(audit.status, 200);
  const actions = new Set(audit.data.items.map((a) => a.action));
  for (const code of expected) {
    assert.ok(actions.has(code), `evento ausente na auditoria: ${code}`);
  }
  // nenhum evento pode conter dado sensível
  const raw = JSON.stringify(audit.data.items);
  assert.ok(!raw.includes('Audit@456') && !raw.includes('Audit@123'), 'senha vazou na auditoria!');
});
