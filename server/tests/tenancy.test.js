'use strict';

/** Multi-tenancy: EMPRESA A (Anjos) × EMPRESA B — ataques cruzados bloqueados. */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { login, authed, createTenant, shutdown } = require('./helpers');

let masterClient;   // cliente autenticado do Master
let tenantB;        // { company, store, user } criado via API
let bClient;        // sessão do admin da empresa B
let aClient;        // sessão do admin da Anjos

before(async () => {
  const master = await login('master@oficiallink.com.br', 'Master@2026');
  assert.equal(master.status, 200);
  masterClient = authed(master.cookie);
  tenantB = await createTenant(masterClient, 'EmpresaB');
  const bLogin = await login(`admin@empresab.com`, 'Temp@123456');
  assert.equal(bLogin.status, 200);
  bClient = authed(bLogin.cookie);
  const aLogin = await login('admin@anjos.com.br', 'Anjos@2026');
  aClient = authed(aLogin.cookie);
});

after(shutdown);

test('B vê apenas seus próprios dados', async () => {
  const stores = await bClient('/stores');
  assert.equal(stores.data.total, 1);
  assert.equal(stores.data.items[0].name, 'EmpresaB - Matriz');
  const users = await bClient('/users');
  assert.equal(users.data.total, 1);
  assert.equal(users.data.items[0].email, 'admin@empresab.com');
});

test('leitura cruzada: A não acessa loja de B (por ID)', async () => {
  const r = await aClient(`/stores/${tenantB.store.id}`);
  assert.equal(r.status, 404);
});

test('leitura cruzada inversa: B não acessa loja da Anjos (por ID)', async () => {
  const anjosStores = await aClient('/stores');
  const target = anjosStores.data.items[0];
  const r = await bClient(`/stores/${target.id}`);
  assert.equal(r.status, 404);
});

test('alteração cruzada: A não edita loja de B', async () => {
  const r = await aClient(`/stores/${tenantB.store.id}`, { method: 'PATCH', body: { name: 'Hackeada' } });
  assert.equal(r.status, 404);
  const still = await masterClient(`/platform/stores?company_id=${tenantB.company.id}`);
  assert.equal(still.data.items[0].name, 'EmpresaB - Matriz');
});

test('alteração cruzada de usuário: A não acessa/edita usuário de B', async () => {
  const get = await aClient(`/users/${tenantB.user.id}`);
  assert.equal(get.status, 404);
  const patch = await aClient(`/users/${tenantB.user.id}`, { method: 'PATCH', body: { status: 'inactive' } });
  assert.equal(patch.status, 404);
  const reset = await aClient(`/users/${tenantB.user.id}/reset-password`, { method: 'POST', body: { password: 'HackSenha@1' } });
  assert.equal(reset.status, 404);
});

test('B não acessa usuário da Anjos nem a plataforma', async () => {
  const anjosUsers = await aClient('/users');
  const target = anjosUsers.data.items[0];
  assert.equal((await bClient(`/users/${target.id}`)).status, 404);
  assert.equal((await bClient('/platform/companies')).status, 403);
  assert.equal((await bClient('/platform/audit')).status, 403);
});

test('cada empresa edita apenas os dados da própria empresa', async () => {
  const bCompany = await bClient('/company');
  assert.equal(bCompany.data.name, 'EmpresaB');
  const r = await bClient('/company', { method: 'PATCH', body: { name: 'EmpresaB Ltda' } });
  assert.equal(r.status, 200);
  const aCompany = await aClient('/company');
  assert.equal(aCompany.data.name, 'Anjos', 'Anjos não pode ter sido alterada');
  await bClient('/company', { method: 'PATCH', body: { name: 'EmpresaB' } });
});

test('unicidade de código de loja é por empresa (isolamento real)', async () => {
  const anjosStore = (await aClient('/stores')).data.items[0];
  const dup = await bClient('/stores', { method: 'POST', body: { name: 'Filiação', code: anjosStore.code, state: 'MA' } });
  assert.equal(dup.status, 201, 'mesmo código em outra empresa deve ser permitido');
  const sameTenant = await aClient('/stores', { method: 'POST', body: { name: 'Duplicata', code: anjosStore.code } });
  assert.equal(sameTenant.status, 409);
});

test('dashboard de B nunca mostra dados da Anjos', async () => {
  const dash = await bClient('/dashboard/summary');
  assert.equal(dash.data.company.name, 'EmpresaB');
  const stores = await bClient('/stores');
  const activeCount = stores.data.items.filter((s) => s.status === 'active').length;
  assert.equal(dash.data.cards[0].value, activeCount, 'card de lojas ativas deve refletir apenas as lojas de B');
});
