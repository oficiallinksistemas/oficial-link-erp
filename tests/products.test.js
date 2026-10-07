'use strict';

/**
 * Módulo PRODUTOS (v1.7) — CRUD, categorias, validações, SKU/barcode,
 * multi-tenancy, RBAC, module gating e integração com Sales (snapshot).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
// helpers SEMPRE primeiro
const { api, login, authed, createTenant, shutdown, passwordFor } = require('./helpers');

let admin;
let master;
let anjosId;
let storeId;
let sellerId;
let tenantB;
let category;

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

  tenantB = await createTenant(master, 'EmpresaProd');
  category = (await admin('/products/categories', { method: 'POST', body: { name: 'Calçados' } })).data;
});

after(shutdown);

const P = (extra = {}) => ({
  name: 'Tênis Corrida', sku: 'TEN-001', barcode: '7891234567890',
  unit: 'un', price: '199,90', category_id: category.id, ...extra,
});

// ---------------------------------------------------------------------------
// Auth, módulo, RBAC
// ---------------------------------------------------------------------------

test('não autenticado → 401; módulo inativo → MODULE_INACTIVE; reativação libera', async () => {
  assert.equal((await api('/products')).status, 401);

  await master(`/platform/companies/${anjosId}/modules/products`, { method: 'PUT', body: { status: 'inactive' } });
  const blocked = await admin('/products');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.error.code, 'MODULE_INACTIVE');

  await master(`/platform/companies/${anjosId}/modules/products`, { method: 'PUT', body: { status: 'active' } });
  assert.equal((await admin('/products')).status, 200);
});

test('RBAC: seller visualiza mas não cria/edita/exclui', async () => {
  const s = await login('vendedor@anjos.com.br', passwordFor('vendedor@anjos.com.br') || 'Anjos@2026');
  const seller = authed(s.cookie);
  assert.equal((await seller('/products')).status, 200);
  assert.equal((await seller('/products', { method: 'POST', body: P({ sku: 'SELLER-1' }) })).status, 403);
  const created = await admin('/products', { method: 'POST', body: P() });
  assert.equal(created.status, 201);
  assert.equal((await seller(`/products/${created.data.id}`, { method: 'PATCH', body: { price: '99,90' } })).status, 403);
  assert.equal((await seller(`/products/${created.data.id}`, { method: 'DELETE' })).status, 403);
});

// ---------------------------------------------------------------------------
// CRUD e validações
// ---------------------------------------------------------------------------

test('criação: centavos, unidade normalizada (un → UN), SKU/barcode preservados', async () => {
  const r = await admin('/products', { method: 'POST', body: P({ sku: 'TEN-MAIN', barcode: '7890000000001' }) });
  assert.equal(r.status, 201, JSON.stringify(r.error));
  assert.equal(r.data.price_cents, 19990);
  assert.equal(r.data.unit, 'UN');
  assert.equal(r.data.category_name, 'Calçados');
  assert.ok(r.data.id > 0);
});

test('validações: nome vazio, preço inválido, unidade inválida, categoria de outra empresa', async () => {
  assert.equal((await admin('/products', { method: 'POST', body: P({ name: '' }) })).status, 400);
  assert.equal((await admin('/products', { method: 'POST', body: P({ sku: 'X1', price: '0,00' }) })).status, 400);
  assert.equal((await admin('/products', { method: 'POST', body: P({ sku: 'X2', unit: 'CAIXA' }) })).status, 400);
  // categoria da Empresa B (criada lá) não pode ser usada pela Anjos
  const bLogin = await login('admin@empresaprod.com', 'Temp@123456');
  const b = authed(bLogin.cookie);
  await master(`/platform/companies/${tenantB.company.id}/modules/products`, { method: 'PUT', body: { status: 'active' } });
  const catB = (await b('/products/categories', { method: 'POST', body: { name: 'Categoria B' } })).data;
  const cross = await admin('/products', { method: 'POST', body: P({ sku: 'X3', category_id: catB.id }) });
  assert.equal(cross.status, 400, 'categoria de outra empresa rejeitada');
});

test('SKU e barcode únicos por empresa; mesmos valores em outra empresa são permitidos', async () => {
  const dup = await admin('/products', { method: 'POST', body: P() });
  assert.equal(dup.status, 409, 'SKU duplicado na mesma empresa');

  const bLogin = await login('admin@empresaprod.com', 'Temp@123456');
  const b = authed(bLogin.cookie);
  const inB = await b('/products', { method: 'POST', body: { name: 'Tênis Corrida', sku: 'TEN-001', barcode: '7891234567890', price: '250,00' } });
  assert.equal(inB.status, 201, 'mesmo SKU/barcode em OUTRA empresa é permitido');
});

test('busca por nome/SKU/barcode, filtros e paginação server-side', async () => {
  assert.ok((await admin('/products?search=Tênis')).data.items.length >= 1);
  assert.ok((await admin('/products?search=TEN-001')).data.items.length >= 1);
  assert.ok((await admin('/products?search=7891234')).data.items.length >= 1);
  const byCat = await admin(`/products?category_id=${category.id}`);
  assert.ok(byCat.data.items.every((p) => p.category_id === category.id));
  const paged = await admin('/products?per_page=5&page=1');
  assert.ok(paged.data.items.length <= 5 && typeof paged.data.total === 'number');
});

test('edição e exclusão: exclusão protegida quando há vendas; sem vendas → 200', async () => {
  const created = await admin('/products', { method: 'POST', body: { name: 'Produto Temp', price: '10,00' } });
  const del = await admin(`/products/${created.data.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200, 'produto sem vendas pode ser excluído');

  const main = (await admin('/products?search=Tênis')).data.items[0];
  // V1.9: estoque é real — entrada antes de vender com produto
  await admin('/stock/entry', { method: 'POST', body: { store_id: storeId, product_id: main.id, quantity: 50 } });
  const sale = await admin('/sales', {
    method: 'POST',
    body: { store_id: storeId, seller_id: sellerId, customer_name: 'Cliente Prod', product_id: main.id, amount: '199,90', sold_at: '2026-10-05' },
  });
  assert.equal(sale.status, 201);
  const delBlocked = await admin(`/products/${main.id}`, { method: 'DELETE' });
  assert.equal(delBlocked.status, 409, 'produto com vendas não pode ser excluído');
});

// ---------------------------------------------------------------------------
// Integração com Sales: snapshot, preço histórico, produto inativo
// ---------------------------------------------------------------------------

test('integração Sales: venda com produto guarda snapshot; repricing não altera histórico', async () => {
  const prod = await admin('/products', { method: 'POST', body: { name: 'Snapshot Prod', sku: 'SNAP-1', price: '100,00' } });
  assert.equal(prod.status, 201);
  // V1.9: estoque é real — entrada antes de vender com produto
  await admin('/stock/entry', { method: 'POST', body: { store_id: storeId, product_id: prod.data.id, quantity: 20 } });

  const sale = await admin('/sales', {
    method: 'POST',
    body: { store_id: storeId, seller_id: sellerId, customer_name: 'Cliente Snap', product_id: prod.data.id, amount: '100,00', sold_at: '2026-10-05' },
  });
  assert.equal(sale.status, 201);
  assert.equal(sale.data.product_name, 'Snapshot Prod');
  assert.equal(sale.data.product_price_cents, 10000);

  // repricing + rename + desativação NÃO alteram a venda histórica
  await admin(`/products/${prod.data.id}`, { method: 'PATCH', body: { price: '250,00', name: 'Snapshot Novo', status: 'inactive' } });
  const after1 = await admin(`/sales/${sale.data.id}`);
  assert.equal(after1.data.product_price_cents, 10000, 'preço histórico preservado');
  assert.equal(after1.data.product_name, 'Snapshot Prod', 'nome histórico preservado');

  // produto inativo NÃO entra em novos lançamentos
  const blocked = await admin('/sales', {
    method: 'POST',
    body: { store_id: storeId, seller_id: sellerId, customer_name: 'Cliente X', product_id: prod.data.id, amount: '100,00', sold_at: '2026-10-06' },
  });
  assert.equal(blocked.status, 400);

  // produto de OUTRA empresa rejeitado
  const other = await admin('/products', { method: 'POST', body: { name: 'Outro', sku: 'OT-1', price: '10,00' } });
  const bLogin = await login('admin@empresaprod.com', 'Temp@123456');
  const b = authed(bLogin.cookie);
  await master(`/platform/companies/${tenantB.company.id}/modules/sales`, { method: 'PUT', body: { status: 'active' } });
  const crossSale = await b('/sales', {
    method: 'POST',
    body: { store_id: tenantB.store.id, seller_id: tenantB.user.id, customer_name: 'X', product_id: other.data.id, amount: '10,00', sold_at: '2026-10-05' },
  });
  assert.equal(crossSale.status, 400, 'produto da Anjos não pode ser vendido pela Empresa B');
});

// ---------------------------------------------------------------------------
// Multi-tenancy e auditoria
// ---------------------------------------------------------------------------

test('Empresa B não acessa, edita nem exclui produtos da Anjos (IDOR)', async () => {
  const p = (await admin('/products?search=Tênis')).data.items[0];
  const bLogin = await login('admin@empresaprod.com', 'Temp@123456');
  const b = authed(bLogin.cookie);
  assert.equal((await b(`/products/${p.id}`)).status, 404);
  assert.equal((await b(`/products/${p.id}`, { method: 'PATCH', body: { price: '1,00' } })).status, 404);
  assert.equal((await b(`/products/${p.id}`, { method: 'DELETE' })).status, 404);
  const searchB = await b('/products?search=Tênis');
  assert.ok(searchB.data.items.every((x) => x.id !== p.id), 'busca de B não vaza o produto da Anjos (por ID)');
});

test('auditoria registra product.create/update e product_category.create', async () => {
  const audit = await master(`/platform/audit?company_id=${anjosId}&action=product`);
  const actions = new Set(audit.data.items.map((a) => a.action));
  assert.ok(actions.has('product.create') && actions.has('product.update'), 'eventos de produto na auditoria');
  assert.ok(actions.has('product_category.create'), 'evento de categoria na auditoria');
});

// ---------------------------------------------------------------------------
// Consolidação — module gating em Sales, categorias, unidades
// ---------------------------------------------------------------------------

test('Products INATIVO: bypass via product_id na venda é bloqueado; histórico preservado', async () => {
  const prod = await admin('/products', { method: 'POST', body: { name: 'Gating Prod', sku: 'GATE-1', price: '50,00' } });
  assert.equal(prod.status, 201);
  // V1.9: estoque é real — entrada antes de vender com produto
  await admin('/stock/entry', { method: 'POST', body: { store_id: storeId, product_id: prod.data.id, quantity: 10 } });

  // venda com produto enquanto ativo
  const sale = await admin('/sales', {
    method: 'POST',
    body: { store_id: storeId, seller_id: sellerId, customer_name: 'Cliente Gate', product_id: prod.data.id, amount: '50,00', sold_at: '2026-10-05' },
  });
  assert.equal(sale.status, 201);

  // desativa o módulo: nova venda com product_id → 400 (sem bypass)
  await master(`/platform/companies/${anjosId}/modules/products`, { method: 'PUT', body: { status: 'inactive' } });
  const bypass = await admin('/sales', {
    method: 'POST',
    body: { store_id: storeId, seller_id: sellerId, customer_name: 'Cliente Gate', product_id: prod.data.id, amount: '50,00', sold_at: '2026-10-06' },
  });
  assert.equal(bypass.status, 400, 'product_id com módulo inativo deve ser rejeitado');

  // mas Sales continua funcionando SEM produto
  const plain = await admin('/sales', {
    method: 'POST',
    body: { store_id: storeId, seller_id: sellerId, customer_name: 'Cliente Sem Produto', amount: '10,00', sold_at: '2026-10-06' },
  });
  assert.equal(plain.status, 201, 'venda sem produto funciona com módulo inativo');

  // e a venda histórica com produto continua exibindo o snapshot
  const historic = await admin(`/sales/${sale.data.id}`);
  assert.equal(historic.status, 200);
  assert.equal(historic.data.product_name, 'Gating Prod', 'snapshot acessível com módulo inativo');

  await master(`/platform/companies/${anjosId}/modules/products`, { method: 'PUT', body: { status: 'active' } });
});

test('categorias: exclusão protegida quando em uso; livre quando vazia; IDOR 404', async () => {
  const cat = (await admin('/products/categories', { method: 'POST', body: { name: 'Cat Exclusão' } })).data;
  const prod = await admin('/products', { method: 'POST', body: { name: 'Prod Cat', price: '10,00', category_id: cat.id } });
  assert.equal(prod.status, 201);

  const inUse = await admin(`/products/categories/${cat.id}`, { method: 'DELETE' });
  assert.equal(inUse.status, 409, 'categoria em uso não pode ser excluída');

  // reatribuir o produto para "sem categoria" e excluir
  await admin(`/products/${prod.data.id}`, { method: 'PATCH', body: { category_id: null } });
  const del = await admin(`/products/categories/${cat.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200, 'categoria vazia pode ser excluída');

  // IDOR: categoria de B não pode ser gerenciada pela Anjos
  const bLogin = await login('admin@empresaprod.com', 'Temp@123456');
  const b = authed(bLogin.cookie);
  const catB = (await b('/products/categories', { method: 'POST', body: { name: 'Cat B' } })).data;
  assert.equal((await admin(`/products/categories/${catB.id}`, { method: 'DELETE' })).status, 404);

  // rename + status via API
  const cat2 = (await admin('/products/categories', { method: 'POST', body: { name: 'Cat Rename' } })).data;
  const ren = await admin(`/products/categories/${cat2.id}`, { method: 'PATCH', body: { name: 'Cat Renomeada', status: 'inactive' } });
  assert.equal(ren.data.name, 'Cat Renomeada');
  assert.equal(ren.data.status, 'inactive');
  await admin(`/products/categories/${cat2.id}`, { method: 'DELETE' });
});

test('unidades expandidas são aceitas e normalizadas (g, ml, pct)', async () => {
  const r = await admin('/products', { method: 'POST', body: { name: 'Arroz 5kg', sku: 'UN-1', unit: 'g', price: '5,00' } });
  assert.equal(r.status, 201);
  assert.equal(r.data.unit, 'G');
  const r2 = await admin('/products', { method: 'POST', body: { name: 'Óleo', sku: 'UN-2', unit: 'ml', price: '8,00' } });
  assert.equal(r2.data.unit, 'ML');
  const bad = await admin('/products', { method: 'POST', body: { name: 'X', sku: 'UN-3', unit: 'FAZENDA', price: '1,00' } });
  assert.equal(bad.status, 400);
});
