'use strict';

/**
 * Módulo VENDAS (v1.2) — arquitetura modular, CRUD, permissões e isolamento.
 * Banco temporário isolado (helpers). Anjos já nasce com dashboard+sales ativos.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
// helpers SEMPRE primeiro
const { login, authed, createTenant, api, shutdown, passwordFor } = require('./helpers');
const db = require('../src/database/connection');

let admin;       // cliente autenticado do admin da Anjos
let master;      // cliente autenticado do Master
let anjosId;     // id da empresa Anjos
let storeId;     // loja da Anjos
let sellerId;    // vendedor da Anjos
let tenantB;     // empresa B completa

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

  tenantB = await createTenant(master, 'EmpresaVendas');
});

after(shutdown);

// ---------------------------------------------------------------------------
// Módulo: ativação/desativação e bloqueio backend
// ---------------------------------------------------------------------------

test('módulo pode ser desativado e reativado pela plataforma', async () => {
  const off = await master(`/platform/companies/${anjosId}/modules/sales`, { method: 'PUT', body: { status: 'inactive' } });
  assert.equal(off.status, 200);
  assert.equal(off.data.status, 'inactive');

  // frontend não pode contornar: API bloqueia com 403 MODULE_INACTIVE
  const blocked = await admin('/sales');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.error.code, 'MODULE_INACTIVE');

  const on = await master(`/platform/companies/${anjosId}/modules/sales`, { method: 'PUT', body: { status: 'active' } });
  assert.equal(on.status, 200);
  assert.equal((await admin('/sales')).status, 200);
});

test('empresa nova: módulos essenciais ativos; empresa sem módulo não acessa', async () => {
  // Anjos tem sales ativo (seed/migration); empresa B criada agora não tem
  const bLogin = await login(`admin@empresavendas.com`, 'Temp@123456');
  const b = authed(bLogin.cookie);
  const blocked = await b('/sales');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.error.code, 'MODULE_INACTIVE');

  // Master ativa sales para B → passa a acessar
  await master(`/platform/companies/${tenantB.company.id}/modules/sales`, { method: 'PUT', body: { status: 'active' } });
  assert.equal((await b('/sales')).status, 200);
});

// ---------------------------------------------------------------------------
// CRUD de vendas
// ---------------------------------------------------------------------------

test('criação: valores em centavos, vínculos validados, auditoria registrada', async () => {
  const r = await admin('/sales', {
    method: 'POST',
    body: { store_id: storeId, seller_id: sellerId, customer_name: 'Maria Silva', amount: '1.234,56', sold_at: '2026-10-05', note: 'venda balcão' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.error));
  assert.equal(r.data.amount_cents, 123456);
  assert.equal(r.data.status, 'active');
  assert.ok(r.data.id > 0);

  const audit = await master(`/platform/audit?company_id=${anjosId}&action=sale.create`);
  assert.ok(audit.data.items.some((a) => a.entity_id === r.data.id));
});

test('validações: campos obrigatórios, loja/vendedor de outra empresa, valor inválido', async () => {
  const base = { store_id: storeId, seller_id: sellerId, customer_name: 'X', amount: '100,00', sold_at: '2026-10-05' };

  assert.equal((await admin('/sales', { method: 'POST', body: { ...base, customer_name: '' } })).status, 400);
  assert.equal((await admin('/sales', { method: 'POST', body: { ...base, amount: '0,00' } })).status, 400);
  assert.equal((await admin('/sales', { method: 'POST', body: { ...base, amount: 'abc' } })).status, 400);
  assert.equal((await admin('/sales', { method: 'POST', body: { ...base, sold_at: '35/13/2026' } })).status, 400);
  assert.equal((await admin('/sales', { method: 'POST', body: { ...base, store_id: tenantB.store.id } })).status, 400, 'loja de outra empresa');
  assert.equal((await admin('/sales', { method: 'POST', body: { ...base, seller_id: tenantB.user.id } })).status, 400, 'vendedor de outra empresa');
  assert.equal((await admin('/sales', { method: 'POST', body: { ...base, customer_name: 'X' } })).status, 400, 'nome curto');
});

test('edição e cancelamento: cancelada é imutável e auditada', async () => {
  const created = await admin('/sales', {
    method: 'POST',
    body: { store_id: storeId, seller_id: sellerId, customer_name: 'João Souza', amount: 500, sold_at: '2026-10-04' },
  });
  const id = created.data.id;

  const edited = await admin(`/sales/${id}`, { method: 'PATCH', body: { amount: '750,00' } });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.amount_cents, 75000);

  // motivo ausente → 400 (venda ainda ativa neste ponto)
  assert.equal((await admin(`/sales/${id}/cancel`, { method: 'POST', body: {} })).status, 400);

  const canceled = await admin(`/sales/${id}/cancel`, { method: 'POST', body: { reason: 'cliente desistiu' } });
  assert.equal(canceled.status, 200);
  assert.equal(canceled.data.status, 'canceled');
  assert.equal(canceled.data.cancel_reason, 'cliente desistiu');

  assert.equal((await admin(`/sales/${id}`, { method: 'PATCH', body: { amount: '900,00' } })).status, 409, 'venda cancelada é imutável');
  assert.equal((await admin(`/sales/${id}/cancel`, { method: 'POST', body: { reason: 'de novo' } })).status, 409);
});

test('filtros e paginação funcionam com escopo da empresa', async () => {
  const active = await admin('/sales?status=active');
  assert.equal(active.status, 200);
  assert.ok(active.data.total >= 1);
  assert.ok(active.data.items.every((s) => s.status === 'active'));

  const byStore = await admin(`/sales?store_id=${storeId}`);
  assert.ok(byStore.data.items.every((s) => s.store_id === storeId));

  const search = await admin('/sales?search=Maria');
  assert.ok(search.data.items.some((s) => s.customer_name.includes('Maria')));
});

// ---------------------------------------------------------------------------
// Permissões por função
// ---------------------------------------------------------------------------

test('Seller: cria e visualiza, mas não edita nem cancela', async () => {
  // vendedor da Anjos — senha efetiva resolvida pelo helper (troca obrigatória do seed)
  const s = await login('vendedor@anjos.com.br', passwordFor('vendedor@anjos.com.br') || 'Anjos@2026');
  const seller = authed(s.cookie);

  const created = await seller('/sales', {
    method: 'POST',
    body: { store_id: storeId, seller_id: sellerId, customer_name: 'Cliente do Vendedor', amount: '99,90', sold_at: '2026-10-05' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.error));

  assert.equal((await seller(`/sales/${created.data.id}`, {})).status, 200);
  assert.equal((await seller(`/sales/${created.data.id}`, { method: 'PATCH', body: { amount: '199,90' } })).status, 403);
  assert.equal((await seller(`/sales/${created.data.id}/cancel`, { method: 'POST', body: { reason: 'sem permissão' } })).status, 403);
});

test('usuário sem sales.view não visualiza (RBAC por função)', async () => {
  // Cria usuário na EmpresaVendas e REVOGA sales.view da função vendedor,
  // simulando um perfil real sem acesso ao módulo. Restore garantido.
  const u = await master('/platform/users', {
    method: 'POST',
    body: {
      company_id: tenantB.company.id, name: 'Só Dashboard', email: 'dash@empresavendas.com',
      password: 'Dash@12345', role_slug: 'seller', must_change_password: false,
    },
  });
  assert.equal(u.status, 201);

  const sellerRole = db.prepare(`SELECT id FROM roles WHERE slug = 'seller'`).get();
  const backup = db.prepare(`SELECT permission_code FROM role_permissions WHERE role_id = ? AND permission_code LIKE 'sales.%'`).all(sellerRole.id);
  db.prepare(`DELETE FROM role_permissions WHERE role_id = ? AND permission_code LIKE 'sales.%'`).run(sellerRole.id);
  try {
    const d = await login('dash@empresavendas.com', 'Dash@12345');
    const dash = authed(d.cookie);
    assert.equal((await dash('/sales')).status, 403, 'sem sales.view');
    assert.equal((await dash('/sales', { method: 'POST', body: {} })).status, 403);
  } finally {
    const restore = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_code) VALUES (?, ?)');
    for (const row of backup) restore.run(sellerRole.id, row.permission_code);
  }
});

// ---------------------------------------------------------------------------
// Isolamento multi-tenant nas vendas
// ---------------------------------------------------------------------------

test('Empresa B não acessa, edita nem cancela vendas da Anjos (por ID)', async () => {
  const created = await admin('/sales', {
    method: 'POST',
    body: { store_id: storeId, seller_id: sellerId, customer_name: 'Segredo Anjos', amount: '10.000,00', sold_at: '2026-10-05' },
  });
  const id = created.data.id;

  const bLogin = await login('admin@empresavendas.com', 'Temp@123456');
  const b = authed(bLogin.cookie);

  assert.equal((await b(`/sales/${id}`)).status, 404);
  assert.equal((await b(`/sales/${id}`, { method: 'PATCH', body: { amount: '1,00' } })).status, 404);
  assert.equal((await b(`/sales/${id}/cancel`, { method: 'POST', body: { reason: 'hack' } })).status, 404);
  const bList = await b('/sales?search=Segredo');
  assert.equal(bList.data.total, 0, 'listagem de B não pode conter venda da Anjos');

  // e a Anjos não lista as vendas de B
  const bSale = await b('/sales', {
    method: 'POST',
    body: { store_id: tenantB.store.id, seller_id: tenantB.user.id, customer_name: 'Cliente B', amount: '250,00', sold_at: '2026-10-05' },
  });
  assert.equal(bSale.status, 201);
  const aList = await admin(`/sales/${bSale.data.id}`);
  assert.equal(aList.status, 404, 'Anjos não acessa venda de B');
});

test('cliente mínimo: cadastro e vínculo em venda, com escopo por empresa', async () => {
  const c = await admin('/customers', { method: 'POST', body: { name: 'Cliente Cadastrado', phone: '(99) 99999-9999' } });
  assert.equal(c.status, 201);

  const sale = await admin('/sales', {
    method: 'POST',
    body: { store_id: storeId, seller_id: sellerId, customer_id: c.data.id, customer_name: c.data.name, amount: '320,00', sold_at: '2026-10-05' },
  });
  assert.equal(sale.status, 201);
  assert.equal(sale.data.customer_id, c.data.id);

  // customer_id de outra empresa é rejeitado
  const bLogin = await login('admin@empresavendas.com', 'Temp@123456');
  const b = authed(bLogin.cookie);
  const bad = await b('/sales', {
    method: 'POST',
    body: { store_id: tenantB.store.id, seller_id: tenantB.user.id, customer_id: c.data.id, customer_name: 'X', amount: '10,00', sold_at: '2026-10-05' },
  });
  assert.equal(bad.status, 400);
});

test('Master administra módulos mas não usa APIs de tenant de vendas', async () => {
  // Master: autoridade global nas permissões, porém módulos de negócio são
  // operados pelos tenants (decisão de arquitetura v1.1.3 preservada)
  assert.equal((await master('/sales')).status, 403);
  assert.equal((await master('/modules')).status, 403);
  // e a plataforma do Master segue com acesso total aos módulos
  const mods = await master('/platform/modules');
  assert.equal(mods.status, 200);
  assert.ok(mods.data.some((m) => m.slug === 'sales'));
});
