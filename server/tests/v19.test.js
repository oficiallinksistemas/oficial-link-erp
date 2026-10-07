'use strict';

/**
 * V1.9 — Hardening da V1.8 + Suppliers + Purchases + Transfers + Inventory +
 * Reports + fluxos completos. Banco temporário isolado (helpers).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
// helpers SEMPRE primeiro
const { login, authed, createTenant, shutdown } = require('./helpers');
const db = require('../src/database/connection');

let admin; let master; let anjosId; let storeA; let storeB; let sellerId; let tenantB;
let prod; let supplier;

before(async () => {
  const m = await login('master@oficiallink.com.br', 'Master@2026');
  master = authed(m.cookie);
  anjosId = (await master('/platform/companies?search=Anjos')).data.items[0].id;
  const a = await login('admin@anjos.com.br', 'Anjos@2026');
  admin = authed(a.cookie);
  const stores = (await admin('/stores')).data.items;
  storeA = stores[0].id; storeB = stores[1] ? stores[1].id : stores[0].id;
  sellerId = (await admin('/users?per_page=50')).data.items.find((u) => u.role_slug === 'seller').id;
  prod = (await admin('/products', { method: 'POST', body: { name: 'V19 Prod', sku: 'V19-1', price: '10,00' } })).data;
  supplier = (await admin('/suppliers', { method: 'POST', body: { name: 'Fornecedor V19', document: '11.222.333/0001-44' } })).data;
  tenantB = await createTenant(master, 'EmpresaV19');
});

after(shutdown);

function sale(body) { return admin('/sales', { method: 'POST', body }); }
function cancelSale(id) { return admin(`/sales/${id}/cancel`, { method: 'POST', body: { reason: 'teste hardening' } }); }
function setStock(on) { return master(`/platform/companies/${anjosId}/modules/stock`, { method: 'PUT', body: { status: on ? 'active' : 'inactive' } }); }
async function balance(pid, store, search = 'V19') {
  const r = await admin(`/stock?store_id=${store}&search=${encodeURIComponent(search)}`);
  const row = r.data.items.find((p) => p.product_id === pid);
  return row ? row.quantity : 0;
}

// ============================ HARDENING =====================================

test('H1: criada ON→cancelada ON estorna (e só uma vez)', async () => {
  await setStock(true);
  const before1 = await balance(prod.id, storeA);
  await admin('/stock/entry', { method: 'POST', body: { store_id: storeA, product_id: prod.id, quantity: 50 } });
  const s = await sale({ store_id: storeA, seller_id: sellerId, customer_name: 'H1', sold_at: '2026-10-05', items: [{ product_id: prod.id, quantity: 2 }] });
  assert.equal(s.status, 201);
  assert.equal(await balance(prod.id, storeA), before1 + 50 - 2);
  assert.equal((await cancelSale(s.data.id)).status, 200);
  assert.equal(await balance(prod.id, storeA), before1 + 50);
  assert.equal((await cancelSale(s.data.id)).status, 409);
  assert.equal(await balance(prod.id, storeA), before1 + 50, 'sem estorno duplo');
});

test('H2: criada ON→Stock OFF→cancelada: estorna (olha o fato, não o módulo)', async () => {
  const before1 = await balance(prod.id, storeA);
  const s = await sale({ store_id: storeA, seller_id: sellerId, customer_name: 'H2', sold_at: '2026-10-05', items: [{ product_id: prod.id, quantity: 3 }] });
  await setStock(false);
  const c = await cancelSale(s.data.id);
  assert.equal(c.status, 200);
  await setStock(true); // API de estoque fica indisponível com módulo OFF — reativa para conferir
  assert.equal(await balance(prod.id, storeA), before1, 'estorno ocorreu com módulo OFF');
});

test('H3: criada OFF→Stock ON→cancelada: NÃO estorna (nunca houve baixa)', async () => {
  const before1 = await balance(prod.id, storeA); // captura com módulo ON
  await setStock(false);
  const s = await sale({ store_id: storeA, seller_id: sellerId, customer_name: 'H3', sold_at: '2026-10-05', items: [{ product_id: prod.id, quantity: 4 }] });
  assert.equal(s.data.stock_was_applied, 0);
  await setStock(true);
  assert.equal((await cancelSale(s.data.id)).status, 200);
  assert.equal(await balance(prod.id, storeA), before1, 'sem estorno fantasma');
});

test('H4: criada OFF→cancelada OFF: nada muda no estoque', async () => {
  const before1 = await balance(prod.id, storeA); // captura com módulo ON
  await setStock(false);
  const s = await sale({ store_id: storeA, seller_id: sellerId, customer_name: 'H4', sold_at: '2026-10-05', items: [{ product_id: prod.id, quantity: 1 }] });
  assert.equal((await cancelSale(s.data.id)).status, 200);
  await setStock(true);
  assert.equal(await balance(prod.id, storeA), before1);
});

test('H5: produto com histórico de estoque/compra não pode ser excluído (409)', async () => {
  const r = await admin(`/products/${prod.id}`, { method: 'DELETE' });
  assert.equal(r.status, 409);
  assert.ok(/histórico/i.test(r.error.message));
});

test('H6: venda legada product_id+amount → item com preço praticado (sem divergência)', async () => {
  const s = await sale({ store_id: storeA, seller_id: sellerId, customer_name: 'H6', product_id: prod.id, amount: '33,00', sold_at: '2026-10-05' });
  assert.equal(s.data.amount_cents, 3300);
  assert.equal(s.data.items[0].unit_price_cents, 3300, 'unit_price = preço praticado');
  assert.equal(s.data.items[0].subtotal_cents, 3300);
});

test('H7: GET /stock sem loja agrega por produto (sem duplicar); summary rotulado', async () => {
  const r = await admin('/stock?search=V19-1');
  assert.equal(r.data.items.length, 1, 'uma linha por produto (agregado)');
  const withStore = await admin(`/stock?store_id=${storeA}`);
  assert.equal(withStore.data.summary.scope, 'store');
  const global = await admin('/stock');
  assert.equal(global.data.summary.scope, 'company');
});

// ============================ SUPPLIERS =====================================

test('S1: suppliers CRUD, documento único por empresa, IDOR', async () => {
  assert.equal((await admin('/suppliers', { method: 'POST', body: { name: 'Dup CNPJ', document: '11222333000144' } })).status, 409);
  const bLogin = await login('admin@empresav19.com', 'Temp@123456');
  const b = authed(bLogin.cookie);
  await master(`/platform/companies/${tenantB.company.id}/modules/suppliers`, { method: 'PUT', body: { status: 'active' } });
  const inB = await b('/suppliers', { method: 'POST', body: { name: 'Fornecedor B', document: '11.222.333/0001-44' } });
  assert.equal(inB.status, 201, 'mesmo documento em outra empresa permitido');
  assert.equal((await b(`/suppliers/${supplier.id}`)).status, 404);
  assert.equal((await b(`/suppliers/${supplier.id}`, { method: 'PATCH', body: { name: 'Hack' } })).status, 404);
  const off = await admin(`/suppliers/${supplier.id}`, { method: 'PATCH', body: { status: 'inactive' } });
  assert.equal(off.data.status, 'inactive');
  await admin(`/suppliers/${supplier.id}`, { method: 'PATCH', body: { status: 'active' } });
});

// ============================ PURCHASES =====================================

test('P1: compra draft → receber (entrada atômica) → duplo recebimento 409 → cancelar com estorno', async () => {
  const created = await admin('/purchases', {
    method: 'POST',
    body: {
      supplier_id: supplier.id, store_id: storeA, purchase_date: '2026-10-05',
      items: [{ product_id: prod.id, quantity: 10, unit_cost: '5,00' }],
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.total_cents, 5000, 'backend calcula');
  const before1 = await balance(prod.id, storeA);
  const received = await admin(`/purchases/${created.data.id}/receive`, { method: 'POST' });
  assert.equal(received.status, 200);
  assert.equal(received.data.status, 'received');
  assert.equal(await balance(prod.id, storeA), before1 + 10);
  assert.equal((await admin(`/purchases/${created.data.id}/receive`, { method: 'POST' })).status, 409, 'duplo recebimento bloqueado');
  const canceled = await admin(`/purchases/${created.data.id}/cancel`, { method: 'POST', body: { reason: 'devolução' } });
  assert.equal(canceled.status, 200);
  assert.equal(await balance(prod.id, storeA), before1, 'estorno da compra');
});

test('P2: compra draft editável; snapshot de custo preservado após mudança no produto', async () => {
  const p2 = (await admin('/products', { method: 'POST', body: { name: 'V19 Prod2', sku: 'V19-2', price: '20,00', cost: '8,00' } })).data;
  const created = await admin('/purchases', {
    method: 'POST',
    body: { supplier_id: supplier.id, store_id: storeA, purchase_date: '2026-10-05', items: [{ product_id: p2.id, quantity: 5 }] },
  });
  assert.equal(created.data.items[0].unit_cost_cents, 800, 'fallback ao custo cadastral');
  await admin(`/products/${p2.id}`, { method: 'PATCH', body: { cost: '15,00', name: 'V19 Renomeado' } });
  const detail = await admin(`/purchases/${created.data.id}`);
  assert.equal(detail.data.items[0].unit_cost_cents, 800, 'snapshot preservado');
  assert.equal(detail.data.items[0].product_name, 'V19 Prod2');
  const edited = await admin(`/purchases/${created.data.id}`, { method: 'PATCH', body: { items: [{ product_id: p2.id, quantity: 7, unit_cost: '9,00' }] } });
  assert.equal(edited.data.total_cents, 6300, 'rascunho editável');
  await admin(`/purchases/${created.data.id}/cancel`, { method: 'POST', body: { reason: 'limpeza' } });
});

// ============================ TRANSFERS =====================================

test('T1: transferência entre lojas atômica; mesma loja e cross-company bloqueados', async () => {
  await admin('/stock/entry', { method: 'POST', body: { store_id: storeA, product_id: prod.id, quantity: 20 } });
  const fromBefore = await balance(prod.id, storeA);
  const t = await admin('/stock/transfers', {
    method: 'POST',
    body: { from_store_id: storeA, to_store_id: storeB, items: [{ product_id: prod.id, quantity: 5 }] },
  });
  assert.equal(t.status, 201);
  const done = await admin(`/stock/transfers/${t.data.id}/complete`, { method: 'POST' });
  assert.equal(done.status, 200);
  assert.equal(await balance(prod.id, storeA), fromBefore - 5);
  assert.equal(await balance(prod.id, storeB), 5);
  assert.equal((await admin(`/stock/transfers/${t.data.id}/complete`, { method: 'POST' })).status, 409);
  const same = await admin('/stock/transfers', { method: 'POST', body: { from_store_id: storeA, to_store_id: storeA, items: [{ product_id: prod.id, quantity: 1 }] } });
  assert.equal(same.status, 400, 'mesma loja rejeitada');
  const bLogin = await login('admin@empresav19.com', 'Temp@123456');
  const b = authed(bLogin.cookie);
  await master(`/platform/companies/${tenantB.company.id}/modules/stock`, { method: 'PUT', body: { status: 'active' } });
  const cross = await b('/stock/transfers', { method: 'POST', body: { from_store_id: storeA, to_store_id: tenantB.store.id, items: [{ product_id: prod.id, quantity: 1 }] } });
  assert.equal(cross.status, 400, 'loja de outra empresa rejeitada');
});

test('T2: transferência com item sem estoque falha sem alterar saldos', async () => {
  const p3 = (await admin('/products', { method: 'POST', body: { name: 'V19 Prod3', sku: 'V19-3', price: '5,00' } })).data;
  const t = await admin('/stock/transfers', {
    method: 'POST',
    body: { from_store_id: storeA, to_store_id: storeB, items: [{ product_id: p3.id, quantity: 99 }] },
  });
  const done = await admin(`/stock/transfers/${t.data.id}/complete`, { method: 'POST' });
  assert.equal(done.status, 409);
  assert.equal(done.error.code, 'INSUFFICIENT_STOCK');
  assert.equal(await balance(p3.id, storeA), 0);
  assert.equal(await balance(p3.id, storeB), 0);
});

// ============================ INVENTORY =====================================

test('I1: inventário conta diferença e ajusta ao finalizar; dupla finalização 409', async () => {
  const before1 = await balance(prod.id, storeA);
  const inv = await admin('/stock/inventory', { method: 'POST', body: { store_id: storeA } });
  assert.equal(inv.status, 201);
  await admin(`/stock/inventory/${inv.data.id}/count`, { method: 'POST', body: { product_id: prod.id, counted: before1 - 3 } });
  const fin = await admin(`/stock/inventory/${inv.data.id}/finalize`, { method: 'POST' });
  assert.equal(fin.status, 200);
  assert.equal(await balance(prod.id, storeA), before1 - 3, 'ajuste aplicado');
  assert.equal((await admin(`/stock/inventory/${inv.data.id}/finalize`, { method: 'POST' })).status, 409);
});

// ============================ REPORTS =======================================

test('R1: relatórios agregam corretamente e isolam por empresa', async () => {
  const sales = await admin('/reports/sales?from=2026-10-01&to=2026-10-31');
  assert.equal(sales.data.summary.status_filter, 'active');
  assert.ok(sales.data.summary.sales_count >= 1, 'vendas ativas no período');
  assert.ok(sales.data.summary.total_cents > 0);
  assert.ok(sales.data.summary.canceled_count >= 1, 'canceladas como indicador separado');
  const byProduct = await admin('/reports/products?from=2026-10-01&to=2026-10-31');
  const row = byProduct.data.items.find((p) => p.product_id === prod.id);
  assert.ok(row && row.quantity >= 1, 'giro por produto (somente vendas ativas)');
  const purchases = await admin('/reports/purchases?from=2026-10-01&to=2026-10-31&status=all');
  assert.ok(purchases.data.summary.purchases_count >= 1, 'compras no período (status=all)');
  const bLogin = await login('admin@empresav19.com', 'Temp@123456');
  const b = authed(bLogin.cookie);
  await master(`/platform/companies/${tenantB.company.id}/modules/reports`, { method: 'PUT', body: { status: 'active' } });
  const bSales = await b('/reports/sales');
  assert.equal(bSales.data.summary.sales_count, 0, 'relatório de B isolado');
});

// ============================ FLUXO COMPLETO =================================

test('FLUXO 1: fornecedor → compra → receber → estoque → venda → baixa → cancelamento → estorno', async () => {
  const p4 = (await admin('/products', { method: 'POST', body: { name: 'Fluxo Prod', sku: 'FLX-1', price: '30,00' } })).data;
  const compra = await admin('/purchases', {
    method: 'POST',
    body: { supplier_id: supplier.id, store_id: storeA, purchase_date: '2026-10-06', items: [{ product_id: p4.id, quantity: 10, unit_cost: '12,00' }] },
  });
  await admin(`/purchases/${compra.data.id}/receive`, { method: 'POST' });
  assert.equal(await balance(p4.id, storeA, 'FLX'), 10);
  const venda = await sale({ store_id: storeA, seller_id: sellerId, customer_name: 'Fluxo', sold_at: '2026-10-06', items: [{ product_id: p4.id, quantity: 4 }] });
  assert.equal(venda.data.amount_cents, 12000);
  assert.equal(await balance(p4.id, storeA, 'FLX'), 6);
  await cancelSale(venda.data.id);
  assert.equal(await balance(p4.id, storeA, 'FLX'), 10, 'estorno completo do fluxo');
  const movs = (await admin(`/stock/movements?product_id=${p4.id}`)).data.items.map((m) => m.type);
  assert.ok(movs.includes('ENTRY') && movs.includes('SALE') && movs.includes('SALE_REVERSAL'));
});
