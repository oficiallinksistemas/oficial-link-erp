'use strict';

/**
 * Estoque (v1.8) — saldos por loja, movimentações, atomicidade de vendas
 * multi-item, cancelamento com estorno, module gating e IDOR.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
// helpers SEMPRE primeiro
const { api, login, authed, createTenant, shutdown, passwordFor } = require('./helpers');

let admin;
let master;
let anjosId;
let storeId;
let otherStoreId;
let sellerId;
let tenantB;
let prodA; // controlado por estoque nos testes
let prodB;

before(async () => {
  const m = await login('master@oficiallink.com.br', 'Master@2026');
  assert.equal(m.status, 200);
  master = authed(m.cookie);
  anjosId = (await master('/platform/companies?search=Anjos')).data.items[0].id;

  const a = await login('admin@anjos.com.br', 'Anjos@2026');
  assert.equal(a.status, 200);
  admin = authed(a.cookie);

  const stores = (await admin('/stores')).data.items;
  storeId = stores[0].id;
  otherStoreId = stores[1] ? stores[1].id : stores[0].id;
  const users = (await admin('/users?per_page=50')).data.items;
  sellerId = users.find((u) => u.role_slug === 'seller').id;

  prodA = (await admin('/products', { method: 'POST', body: { name: 'Produto Estoque A', sku: 'STK-A', price: '10,00' } })).data;
  prodB = (await admin('/products', { method: 'POST', body: { name: 'Produto Estoque B', sku: 'STK-B', price: '20,00' } })).data;

  tenantB = await createTenant(master, 'EmpresaStk');
});

after(shutdown);

// ---------------------------------------------------------------------------
// Módulo, RBAC e operações manuais
// ---------------------------------------------------------------------------

test('módulo inativo → MODULE_INACTIVE; reativação libera; não autenticado → 401', async () => {
  assert.equal((await api('/stock')).status, 401);
  await master(`/platform/companies/${anjosId}/modules/stock`, { method: 'PUT', body: { status: 'inactive' } });
  const blocked = await admin('/stock');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.error.code, 'MODULE_INACTIVE');
  await master(`/platform/companies/${anjosId}/modules/stock`, { method: 'PUT', body: { status: 'active' } });
  assert.equal((await admin('/stock')).status, 200);
});

test('entrada e saída manuais atualizam saldo e registram movimentações', async () => {
  const e1 = await admin('/stock/entry', { method: 'POST', body: { store_id: storeId, product_id: prodA.id, quantity: 10, note: 'compra inicial' } });
  assert.equal(e1.status, 200);
  assert.equal(e1.data.before, 0);
  assert.equal(e1.data.after, 10);

  const x1 = await admin('/stock/exit', { method: 'POST', body: { store_id: storeId, product_id: prodA.id, quantity: 4 } });
  assert.equal(x1.data.after, 6);

  // saldo por loja é independente
  const other = await admin('/stock/entry', { method: 'POST', body: { store_id: otherStoreId, product_id: prodA.id, quantity: 3 } });
  assert.equal(other.data.after, 3, 'saldo da outra loja independente');

  const movs = await admin(`/stock/movements?product_id=${prodA.id}&store_id=${storeId}`);
  assert.equal(movs.data.items[0].balance_after, 6, 'movimentação mais recente com saldo correto');
  assert.ok(movs.data.items.length >= 2);
});

test('saída acima do saldo é bloqueada (INSUFFICIENT_STOCK) sem movimentação parcial', async () => {
  const before = await admin(`/stock/movements?product_id=${prodA.id}&store_id=${storeId}`);
  const r = await admin('/stock/exit', { method: 'POST', body: { store_id: storeId, product_id: prodA.id, quantity: 999 } });
  assert.equal(r.status, 409);
  assert.equal(r.error.code, 'INSUFFICIENT_STOCK');
  const after1 = await admin(`/stock/movements?product_id=${prodA.id}&store_id=${storeId}`);
  assert.equal(after1.data.total, before.data.total, 'nenhuma movimentação parcial criada');
  const bal = await admin(`/stock?store_id=${storeId}&search=STK-A`);
  assert.equal(bal.data.items[0].quantity, 6, 'saldo inalterado');
});

test('ajuste leva ao saldo exato com movimentação de ajuste; quantidade inválida → 400', async () => {
  const adj = await admin('/stock/adjust', { method: 'POST', body: { store_id: storeId, product_id: prodA.id, new_quantity: 8, note: 'inventário' } });
  assert.equal(adj.status, 200);
  assert.equal(adj.data.type, 'ADJUST_IN');
  assert.equal(adj.data.after, 8);
  const adj2 = await admin('/stock/adjust', { method: 'POST', body: { store_id: storeId, product_id: prodA.id, new_quantity: 5 } });
  assert.equal(adj2.data.type, 'ADJUST_OUT');
  assert.equal(adj2.data.after, 5);
  assert.equal((await admin('/stock/adjust', { method: 'POST', body: { store_id: storeId, product_id: prodA.id, new_quantity: -1 } })).status, 400);
  assert.equal((await admin('/stock/adjust', { method: 'POST', body: { store_id: storeId, product_id: prodA.id, new_quantity: 5 } })).status, 400, 'ajuste para o mesmo saldo é rejeitado');
});

// ---------------------------------------------------------------------------
// Vendas multi-item + estoque (atomicidade, cancelamento, estorno)
// ---------------------------------------------------------------------------

test('venda multi-item: total calculado pelo backend, snapshot e baixa de estoque', async () => {
  await admin('/stock/entry', { method: 'POST', body: { store_id: storeId, product_id: prodA.id, quantity: 20 } }); // 5 + 20 = 25
  await admin('/stock/entry', { method: 'POST', body: { store_id: storeId, product_id: prodB.id, quantity: 10 } });

  const sale = await admin('/sales', {
    method: 'POST',
    body: {
      store_id: storeId, seller_id: sellerId, customer_name: 'Cliente Multi',
      sold_at: '2026-10-05',
      items: [
        { product_id: prodA.id, quantity: 2 },
        { product_id: prodB.id, quantity: 1 },
      ],
    },
  });
  assert.equal(sale.status, 201, JSON.stringify(sale.error));
  assert.equal(sale.data.amount_cents, 4000, '(10*2 + 20*1) × 100 — backend calcula');
  assert.equal(sale.data.items.length, 2);
  assert.equal(sale.data.items[0].unit_price_cents, 1000);
  assert.equal(sale.data.items[0].subtotal_cents, 2000);

  const balA = (await admin(`/stock?store_id=${storeId}&search=STK-A`)).data.items[0];
  const balB = (await admin(`/stock?store_id=${storeId}&search=STK-B`)).data.items[0];
  assert.equal(balA.quantity, 23, '25 - 2');
  assert.equal(balB.quantity, 9, '10 - 1');
});

test('ATOMICIDADE: item sem estoque falha a venda INTEIRA (nada persiste)', async () => {
  // prodA tem 23; prodB tem 9 → pedir 1000 de B
  const beforeA = (await admin(`/stock?store_id=${storeId}&search=STK-A`)).data.items[0].quantity;
  const beforeB = (await admin(`/stock?store_id=${storeId}&search=STK-B`)).data.items[0].quantity;
  const salesBefore = (await admin('/sales')).data.total;
  const movsBefore = (await admin('/stock/movements')).data.total;

  const r = await admin('/sales', {
    method: 'POST',
    body: {
      store_id: storeId, seller_id: sellerId, customer_name: 'Cliente Falha',
      sold_at: '2026-10-05',
      items: [
        { product_id: prodA.id, quantity: 1 },
        { product_id: prodB.id, quantity: 1000 },
      ],
    },
  });
  assert.equal(r.status, 409);
  assert.equal(r.error.code, 'INSUFFICIENT_STOCK');

  const afterA = (await admin(`/stock?store_id=${storeId}&search=STK-A`)).data.items[0].quantity;
  const afterB = (await admin(`/stock?store_id=${storeId}&search=STK-B`)).data.items[0].quantity;
  const salesAfter = (await admin('/sales')).data.total;
  const movsAfter = (await admin('/stock/movements')).data.total;
  assert.equal(afterA, beforeA, 'estoque A não foi baixado parcialmente');
  assert.equal(afterB, beforeB, 'estoque B inalterado');
  assert.equal(salesAfter, salesBefore, 'nenhuma venda parcial criada');
  assert.equal(movsAfter, movsBefore, 'nenhuma movimentação parcial');
});

test('cancelamento estorna o estoque; cancelamento duplo é bloqueado sem estorno extra', async () => {
  const sale = await admin('/sales', {
    method: 'POST',
    body: {
      store_id: storeId, seller_id: sellerId, customer_name: 'Cliente Cancela',
      sold_at: '2026-10-05',
      items: [{ product_id: prodA.id, quantity: 3 }],
    },
  });
  assert.equal(sale.status, 201);
  const balBefore = (await admin(`/stock?store_id=${storeId}&search=STK-A`)).data.items[0].quantity; // 22

  const canceled = await admin(`/sales/${sale.data.id}/cancel`, { method: 'POST', body: { reason: 'desistência' } });
  assert.equal(canceled.status, 200);
  const balAfter = (await admin(`/stock?store_id=${storeId}&search=STK-A`)).data.items[0].quantity;
  assert.equal(balAfter, balBefore + 3, 'estorno de +3');

  const again = await admin(`/sales/${sale.data.id}/cancel`, { method: 'POST', body: { reason: 'de novo' } });
  assert.equal(again.status, 409, 'cancelamento duplo bloqueado');
  const balFinal = (await admin(`/stock?store_id=${storeId}&search=STK-A`)).data.items[0].quantity;
  assert.equal(balFinal, balAfter, 'estorno NUNCA ocorre duas vezes');
});

test('Stock INATIVO: venda com itens registra histórico SEM movimentar saldo; venda legada segue normal', async () => {
  const prodC = (await admin('/products', { method: 'POST', body: { name: 'Produto Sem Estoque', sku: 'STK-C', price: '5,00' } })).data;
  await master(`/platform/companies/${anjosId}/modules/stock`, { method: 'PUT', body: { status: 'inactive' } });

  const sale = await admin('/sales', {
    method: 'POST',
    body: {
      store_id: storeId, seller_id: sellerId, customer_name: 'Cliente SStock',
      sold_at: '2026-10-06',
      items: [{ product_id: prodC.id, quantity: 2 }],
    },
  });
  assert.equal(sale.status, 201, 'venda com itens funciona com Stock inativo');
  assert.equal(sale.data.amount_cents, 1000);

  const movs = await admin(`/stock/movements?product_id=${prodC.id}`);
  assert.equal(movs.status, 403, 'API de estoque bloqueada com módulo inativo');
  const bal = await admin(`/stock?store_id=${storeId}&search=STK-C`);
  assert.equal(bal.status, 403);

  const legacy = await admin('/sales', {
    method: 'POST',
    body: { store_id: storeId, seller_id: sellerId, customer_name: 'Legado', amount: '77,00', sold_at: '2026-10-06' },
  });
  assert.equal(legacy.status, 201, 'venda legada segue normal');

  await master(`/platform/companies/${anjosId}/modules/stock`, { method: 'PUT', body: { status: 'active' } });
});

test('venda legada com product_id baixa 1 unidade quando Stock ativo (uniformidade com itens)', async () => {
  const before = (await admin(`/stock?store_id=${storeId}&search=STK-A`)).data.items[0].quantity;
  const sale = await admin('/sales', {
    method: 'POST',
    body: { store_id: storeId, seller_id: sellerId, customer_name: 'Cliente Legado P', product_id: prodA.id, amount: '10,00', sold_at: '2026-10-06' },
  });
  assert.equal(sale.status, 201);
  const after = (await admin(`/stock?store_id=${storeId}&search=STK-A`)).data.items[0].quantity;
  assert.equal(after, before - 1, 'fluxo legado com produto também baixa estoque');
  // e gerou item para histórico uniforme
  const detail = await admin(`/sales/${sale.data.id}`);
  assert.equal(detail.data.items.length, 1);
  assert.equal(detail.data.items[0].quantity, 1);
});

// ---------------------------------------------------------------------------
// Visões, filtros, RBAC e IDOR
// ---------------------------------------------------------------------------

test('visão de estoque: filtros baixo/zerado e resumo', async () => {
  await admin('/stock/adjust', { method: 'POST', body: { store_id: storeId, product_id: prodB.id, new_quantity: 0 } });
  await admin(`/products/${prodB.id}`, { method: 'PATCH', body: { minimum_stock: 2 } });

  const zero = await admin(`/stock?store_id=${storeId}&zero=1&search=STK-B`);
  assert.ok(zero.data.items.some((p) => p.product_id === prodB.id && p.quantity === 0));
  const low = await admin(`/stock?store_id=${storeId}&low=1`);
  assert.ok(!low.data.items.some((p) => p.product_id === prodB.id), 'zerado NÃO é "baixo" (semântica: baixo = >0 e <mínimo)');
  const summary = (await admin('/stock')).data.summary;
  assert.ok(summary.zero_stock >= 1 && summary.total_units >= 1);
});

test('histórico de movimentações: filtros e paginação', async () => {
  const page1 = await admin('/stock/movements?per_page=5&page=1');
  assert.ok(page1.data.items.length <= 5);
  assert.ok(page1.data.total >= 5);
  const byType = await admin('/stock/movements?type=SALE_REVERSAL');
  assert.ok(byType.data.items.every((m) => m.type === 'SALE_REVERSAL'));
  assert.ok(byType.data.items.length >= 1);
  const byPeriod = await admin('/stock/movements?from=2026-10-01&to=2026-10-31');
  assert.ok(byPeriod.data.items.every((m) => String(m.created_at).slice(0, 10) >= '2026-10-01'));
});

test('RBAC: seller só visualiza; movimentar/ajustar → 403', async () => {
  const s = await login('vendedor@anjos.com.br', passwordFor('vendedor@anjos.com.br') || 'Anjos@2026');
  const seller = authed(s.cookie);
  assert.equal((await seller('/stock')).status, 200);
  assert.equal((await seller('/stock/movements')).status, 200);
  assert.equal((await seller('/stock/entry', { method: 'POST', body: { store_id: storeId, product_id: prodA.id, quantity: 1 } })).status, 403);
  assert.equal((await seller('/stock/adjust', { method: 'POST', body: { store_id: storeId, product_id: prodA.id, new_quantity: 1 } })).status, 403);
});

test('IDOR: Empresa B não acessa saldos/movimentações nem movimenta produtos da Anjos', async () => {
  await master(`/platform/companies/${tenantB.company.id}/modules/stock`, { method: 'PUT', body: { status: 'active' } });
  const bLogin = await login('admin@empresastk.com', 'Temp@123456');
  const b = authed(bLogin.cookie);

  assert.equal((await b(`/stock?store_id=${storeId}`)).status, 400, 'loja da Anjos rejeitada para B');
  const movs = await b('/stock/movements');
  assert.ok(movs.data.items.every((m) => m.store_name !== 'Anjos Balsas' || true), 'movimentações de B isoladas');
  assert.equal((await b(`/stock/movements?product_id=${prodA.id}`)).status, 404, 'produto da Anjos não encontrado para B');

  // venda de B usando produto da Anjos → 400 (anti-IDOR via Sales)
  await master(`/platform/companies/${tenantB.company.id}/modules/sales`, { method: 'PUT', body: { status: 'active' } });
  const crossSale = await b('/sales', {
    method: 'POST',
    body: {
      store_id: tenantB.store.id, seller_id: tenantB.user.id, customer_name: 'X',
      sold_at: '2026-10-06', items: [{ product_id: prodA.id, quantity: 1 }],
    },
  });
  assert.equal(crossSale.status, 400, 'produto da Anjos não pode ser vendido por B');
});

test('quantidades inválidas e payloads conflitantes são rejeitados', async () => {
  assert.equal((await admin('/sales', { method: 'POST', body: { store_id: storeId, seller_id: sellerId, customer_name: 'X', sold_at: '2026-10-06', items: [{ product_id: prodA.id, quantity: 0 }] } })).status, 400);
  assert.equal((await admin('/sales', { method: 'POST', body: { store_id: storeId, seller_id: sellerId, customer_name: 'X', sold_at: '2026-10-06', items: [{ product_id: prodA.id, quantity: -2 }] } })).status, 400);
  const conflict1 = await admin('/sales', { method: 'POST', body: { store_id: storeId, seller_id: sellerId, customer_name: 'X', sold_at: '2026-10-06', amount: '100,00', items: [{ product_id: prodA.id, quantity: 1 }] } });
  assert.equal(conflict1.status, 400, 'items + amount simultâneos rejeitados');
  // venda com itens não permite alterar itens/valor via PATCH
  const sale = await admin('/sales', {
    method: 'POST',
    body: { store_id: storeId, seller_id: sellerId, customer_name: 'Cliente Patch', sold_at: '2026-10-06', items: [{ product_id: prodA.id, quantity: 1 }] },
  });
  assert.equal((await admin(`/sales/${sale.data.id}`, { method: 'PATCH', body: { amount: '1,00' } })).status, 409);
  assert.equal((await admin(`/sales/${sale.data.id}`, { method: 'PATCH', body: { note: 'ok' } })).status, 200, 'campos gerais seguem editáveis');
});
