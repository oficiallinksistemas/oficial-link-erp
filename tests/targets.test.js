'use strict';

/**
 * Módulo METAS (v1.3) — CRUD, validações, desempenho sobre Vendas,
 * anti-duplicidade, RBAC e isolamento multi-tenant. Padrão idêntico ao Vendas.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
// helpers SEMPRE primeiro
const { login, authed, createTenant, shutdown, passwordFor } = require('./helpers');

let admin;      // Anjos admin
let master;     // Master (plataforma)
let anjosId;
let storeId;
let sellerId;
let tenantB;

before(async () => {
  const m = await login('master@oficiallink.com.br', 'Master@2026');
  assert.equal(m.status, 200);
  master = authed(m.cookie);
  anjosId = (await master('/platform/companies?search=Anjos')).data.items[0].id;

  const a = await login('admin@anjos.com.br', 'Anjos@2026');
  assert.equal(a.status, 200);
  admin = authed(a.cookie);

  storeId = (await admin('/stores')).data.items[0].id;
  const users = (await admin('/users?per_page=50')).data.items;
  sellerId = users.find((u) => u.role_slug === 'seller').id;

  tenantB = await createTenant(master, 'EmpresaMetas');
});

after(shutdown);

const T = {
  seller: (extra = {}) => ({
    type: 'seller', user_id: sellerId, start_date: '2026-10-01', end_date: '2026-10-31',
    target_value: '50.000,00', ...extra,
  }),
  store: (extra = {}) => ({
    type: 'store', store_id: storeId, start_date: '2026-10-01', end_date: '2026-10-31',
    target_value: '200.000,00', ...extra,
  }),
};

function addSale(cookie, amount, soldAt = '2026-10-10', store = storeId, seller = sellerId) {
  return cookie('/sales', {
    method: 'POST',
    body: { store_id: store, seller_id: seller, customer_name: 'Cliente Meta', amount, sold_at: soldAt },
  });
}

// ---------------------------------------------------------------------------
// Módulo e permissões
// ---------------------------------------------------------------------------

test('módulo inativo bloqueia APIs (MODULE_INACTIVE) e reativação libera', async () => {
  await master(`/platform/companies/${anjosId}/modules/targets`, { method: 'PUT', body: { status: 'active' } });
  assert.equal((await admin('/targets')).status, 200);

  await master(`/platform/companies/${anjosId}/modules/targets`, { method: 'PUT', body: { status: 'inactive' } });
  const blocked = await admin('/targets');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.error.code, 'MODULE_INACTIVE');

  await master(`/platform/companies/${anjosId}/modules/targets`, { method: 'PUT', body: { status: 'active' } });
  assert.equal((await admin('/targets')).status, 200);
});

test('RBAC: seller visualiza mas não cria/edita/exclui; admin faz tudo', async () => {
  const created = await admin('/targets', { method: 'POST', body: T.seller() });
  assert.equal(created.status, 201, JSON.stringify(created.error));

  const s = await login('vendedor@anjos.com.br', passwordFor('vendedor@anjos.com.br') || 'Anjos@2026');
  const seller = authed(s.cookie);
  assert.equal((await seller('/targets')).status, 200, 'seller com targets.view visualiza');
  assert.equal((await seller('/targets', { method: 'POST', body: T.seller({ start_date: '2026-11-01', end_date: '2026-11-30' }) })).status, 403);
  assert.equal((await seller(`/targets/${created.data.id}`, { method: 'PATCH', body: { target_value: '60.000,00' } })).status, 403);
  assert.equal((await seller(`/targets/${created.data.id}`, { method: 'DELETE' })).status, 403);
});

// ---------------------------------------------------------------------------
// CRUD e validações
// ---------------------------------------------------------------------------

test('criação: valores em centavos e vínculos por tipo (vendedor/loja)', async () => {
  const bySeller = await admin('/targets', { method: 'POST', body: T.seller({ start_date: '2026-10-01', end_date: '2026-10-15' }) });
  assert.equal(bySeller.status, 201);
  assert.equal(bySeller.data.target_cents, 5000000);
  assert.equal(bySeller.data.type, 'seller');
  assert.ok(bySeller.data.user_id > 0);
  assert.equal(bySeller.data.store_id, null);

  const byStore = await admin('/targets', { method: 'POST', body: T.store() });
  assert.equal(byStore.status, 201);
  assert.equal(byStore.data.target_cents, 20000000);
  assert.equal(byStore.data.type, 'store');
  assert.ok(byStore.data.store_id > 0);
  assert.equal(byStore.data.user_id, null);

  const audit = await master(`/platform/audit?company_id=${anjosId}&action=target.create`);
  assert.ok(audit.data.items.length >= 2);
});

test('validações: tipo inválido, escopo cruzado, período invertido, valor inválido', async () => {
  assert.equal((await admin('/targets', { method: 'POST', body: { ...T.seller(), type: 'produto' } })).status, 400);
  assert.equal((await admin('/targets', { method: 'POST', body: { ...T.seller(), user_id: tenantB.user.id } })).status, 400, 'vendedor de outra empresa');
  assert.equal((await admin('/targets', { method: 'POST', body: { ...T.store(), store_id: tenantB.store.id } })).status, 400, 'loja de outra empresa');
  assert.equal((await admin('/targets', { method: 'POST', body: { ...T.seller({ start_date: '2026-10-31', end_date: '2026-10-01' }), start_date: '2026-11-02', end_date: '2026-11-01' } })).status, 400, 'período invertido');
  assert.equal((await admin('/targets', { method: 'POST', body: { ...T.seller(), target_value: '0,00' } })).status, 400);
  assert.equal((await admin('/targets', { method: 'POST', body: { ...T.seller(), start_date: '2026-13-40' } })).status, 400);
  // meta de vendedor exige user_id; de loja exige store_id
  assert.equal((await admin('/targets', { method: 'POST', body: { type: 'seller', start_date: '2026-10-01', end_date: '2026-10-31', target_value: 100 } })).status, 400);
});

test('anti-duplicidade: mesmo escopo + período exato → 409; período diferente → 201', async () => {
  const a = await admin('/targets', { method: 'POST', body: T.seller({ start_date: '2026-12-01', end_date: '2026-12-31' }) });
  assert.equal(a.status, 201);
  const dup = await admin('/targets', { method: 'POST', body: T.seller({ start_date: '2026-12-01', end_date: '2026-12-31' }) });
  assert.equal(dup.status, 409, 'meta idêntica deve conflitar');
  const otherPeriod = await admin('/targets', { method: 'POST', body: T.seller({ start_date: '2026-12-15', end_date: '2026-12-31' }) });
  assert.equal(otherPeriod.status, 201, 'períodos diferentes podem coexistir');
});

test('edição e exclusão funcionam e são auditadas', async () => {
  const created = await admin('/targets', { method: 'POST', body: T.seller({ start_date: '2026-09-01', end_date: '2026-09-30' }) });
  const id = created.data.id;

  const edited = await admin(`/targets/${id}`, { method: 'PATCH', body: { target_value: '75.000,00', notes: 'ajustada' } });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.target_cents, 7500000);

  const del = await admin(`/targets/${id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal((await admin(`/targets/${id}`)).status, 404);

  const audit = await master(`/platform/audit?company_id=${anjosId}&action=target`);
  const actions = new Set(audit.data.items.map((a) => a.action));
  assert.ok(actions.has('target.update') && actions.has('target.delete'));
});

// ---------------------------------------------------------------------------
// Desempenho (agregação sobre Vendas — vendas canceladas NÃO contam)
// ---------------------------------------------------------------------------

test('desempenho: realizado, percentual e "falta"; venda cancelada não conta', async () => {
  // Meta do vendedor: 50.000 (período único cobrindo outubro/2026)
  const target = await admin('/targets', { method: 'POST', body: T.seller({ start_date: '2026-09-01', end_date: '2026-10-31' }) });
  const tid = target.data.id;

  const s1 = await addSale(admin, '30.000,00', '2026-10-05');
  assert.equal(s1.status, 201);
  const s2 = await addSale(admin, '10.000,00', '2026-10-20');
  assert.equal(s2.status, 201);
  const s3 = await addSale(admin, '20.000,00', '2026-10-25');
  await admin(`/sales/${s3.data.id}/cancel`, { method: 'POST', body: { reason: 'não deve contar' } });
  // Fora do período da meta
  await addSale(admin, '99.000,00', '2026-11-05');

  const perf = await admin(`/targets/${tid}/performance`);
  assert.equal(perf.status, 200);
  assert.equal(perf.data.target_cents, 5000000);
  assert.equal(perf.data.achieved_cents, 4000000, '30k + 10k; cancelada e fora do período fora');
  assert.equal(perf.data.percent, 80);
  assert.equal(perf.data.missing_cents, 1000000);
  assert.equal(perf.data.reached, false);

  // Meta da loja considera vendas da loja (mesmo vendedor acima vendeu nessa loja)
  const tStore = await admin('/targets', { method: 'POST', body: T.store({ start_date: '2026-09-01', end_date: '2026-10-31' }) });
  const perfStore = await admin(`/targets/${tStore.data.id}/performance`);
  assert.equal(perfStore.data.achieved_cents, 4000000);
});

test('filtros e paginação server-side por tipo/vendedor/loja/período', async () => {
  const bySeller = await admin('/targets?type=seller');
  assert.ok(bySeller.data.items.every((t) => t.type === 'seller'));
  const byStore = await admin('/targets?type=store');
  assert.ok(byStore.data.items.every((t) => t.type === 'store'));
  const byUser = await admin(`/targets?user_id=${sellerId}`);
  assert.ok(byUser.data.items.every((t) => t.user_id === sellerId));
  const october = await admin('/targets?from=2026-10-01&to=2026-10-31');
  assert.ok(october.data.items.every((t) => t.end_date >= '2026-10-01' && t.start_date <= '2026-10-31'));
  const paged = await admin('/targets?per_page=5&page=1');
  assert.ok(paged.data.items.length <= 5);
});

// ---------------------------------------------------------------------------
// Isolamento multi-tenant e Master
// ---------------------------------------------------------------------------

test('Empresa B não acessa metas da Anjos por ID (404) e vínculo cruzado é rejeitado', async () => {
  const t = await admin('/targets', { method: 'POST', body: T.seller({ start_date: '2026-08-01', end_date: '2026-08-31' }) });
  const bLogin = await login('admin@empresametas.com', 'Temp@123456');
  const b = authed(bLogin.cookie);
  await master(`/platform/companies/${tenantB.company.id}/modules/targets`, { method: 'PUT', body: { status: 'active' } });

  assert.equal((await b(`/targets/${t.data.id}`)).status, 404);
  assert.equal((await b(`/targets/${t.data.id}`, { method: 'PATCH', body: { target_value: '1,00' } })).status, 404);
  assert.equal((await b(`/targets/${t.data.id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await b(`/targets/${t.data.id}/performance`)).status, 404);

  const cross = await b('/targets', {
    method: 'POST',
    body: { type: 'seller', user_id: sellerId, start_date: '2026-10-01', end_date: '2026-10-31', target_value: '1.000,00' },
  });
  assert.equal(cross.status, 400, 'vendedor da Anjos não pode ser meta da Empresa B');

  // dashboard da Anjos inclui card de metas (módulo ativo)
  const dash = await admin('/dashboard/summary');
  assert.ok(dash.data.cards.some((c) => c.key === 'targets_month'));
});

test('Master: autoridade global preservada (administra módulo; APIs de tenant seguem restritas)', async () => {
  const me = await master('/auth/me');
  assert.equal(me.data.globalAdmin, true);
  assert.ok(me.data.permissions.includes('targets.delete'), 'Master possui targets.delete automaticamente');
  assert.equal((await master('/targets')).status, 403, 'APIs de negócio são de tenants (padrão v1.1.3)');
});

// ---------------------------------------------------------------------------
// V1.3.1 — correções do módulo Metas
// ---------------------------------------------------------------------------

test('V1.3.1: apenas usuários com função "seller" podem ser vinculados como vendedor', async () => {
  const users = (await admin('/users?per_page=50')).data.items;
  const adminUser = users.find((u) => u.role_slug === 'company_admin');
  const supervisor = users.find((u) => u.role_slug === 'supervisor');

  const r1 = await admin('/targets', {
    method: 'POST',
    body: { type: 'seller', user_id: adminUser.id, start_date: '2026-07-01', end_date: '2026-07-31', target_value: '10.000,00' },
  });
  assert.equal(r1.status, 400, 'administrador não é vendedor');

  const r2 = await admin('/targets', {
    method: 'POST',
    body: { type: 'seller', user_id: supervisor.id, start_date: '2026-07-01', end_date: '2026-07-31', target_value: '10.000,00' },
  });
  assert.equal(r2.status, 400, 'supervisor não é vendedor');

  const r3 = await admin('/targets', {
    method: 'POST',
    body: { type: 'seller', user_id: sellerId, start_date: '2026-07-01', end_date: '2026-07-31', target_value: '10.000,00' },
  });
  assert.equal(r3.status, 201, 'vendedor (seller) é aceito');

  // edição trocando para escopo inválido também é rejeitada
  assert.equal((await admin(`/targets/${r3.data.id}`, { method: 'PATCH', body: { type: 'seller', user_id: adminUser.id } })).status, 400);
  await admin(`/targets/${r3.data.id}`, { method: 'DELETE' });
});

test('V1.3.1: listagem embute o desempenho (sem N+1) com cálculo correto', async () => {
  const target = await admin('/targets', {
    method: 'POST',
    body: { type: 'seller', user_id: sellerId, start_date: '2026-10-05', end_date: '2026-10-20', target_value: '20.000,00' },
  });
  assert.equal(target.status, 201);

  const sale = await admin('/sales', {
    method: 'POST',
    body: { store_id: storeId, seller_id: sellerId, customer_name: 'V131', amount: '5.000,00', sold_at: '2026-10-15' },
  });
  assert.equal(sale.status, 201);

  const list = await admin('/targets?type=seller');
  assert.equal(list.status, 200);
  const item = list.data.items.find((t) => t.id === target.data.id);
  assert.ok(item, 'meta presente na listagem');
  assert.equal(typeof item.achieved_cents, 'number', 'achieved embutido');
  assert.equal(typeof item.percent, 'number', 'percent embutido');
  assert.equal(typeof item.missing_cents, 'number', 'missing embutido');
  assert.equal(typeof item.reached, 'boolean', 'reached embutido');
  assert.ok(item.achieved_cents >= 500000, 'realizado inclui a venda do período');
  assert.ok(item.percent > 0);

  await admin(`/targets/${target.data.id}`, { method: 'DELETE' });
});
