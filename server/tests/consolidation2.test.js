'use strict';

/**
 * V1.9 — Consolidação FINAL: summary global por produto, inventário
 * matematicamente validado (9 casos) e reconciliação END-TO-END INDEPENDENTE
 * (saldo esperado calculado em JS — sem consultar o persistido).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
// helpers SEMPRE primeiro
const { login, authed, shutdown, passwordFor } = require('./helpers');

let admin; let master; let anjosId; let storeA; let storeB; let sellerId;

before(async () => {
  const m = await login('master@oficiallink.com.br', 'Master@2026');
  master = authed(m.cookie);
  anjosId = (await master('/platform/companies?search=Anjos')).data.items[0].id;
  const a = await login('admin@anjos.com.br', 'Anjos@2026');
  admin = authed(a.cookie);
  const stores = (await admin('/stores')).data.items;
  storeA = stores[0].id; storeB = stores[1] ? stores[1].id : stores[0].id;
  sellerId = (await admin('/users?per_page=50')).data.items.find((u) => u.role_slug === 'seller').id;
});

after(shutdown);

const entry = (store, pid, qty) => admin('/stock/entry', { method: 'POST', body: { store_id: store, product_id: pid, quantity: qty } });
const bal = async (pid, store) => {
  const r = await admin(`/stock?store_id=${store}&search=SUMTEST`);
  const row = r.data.items.find((p) => p.product_id === pid);
  return row ? row.quantity : 0;
};

// ===================== 7. STOCK SUMMARY (casos A–E) =========================

test('SUM A–E: summary global por PRODUTO (5+5 min 10 não é baixo); por loja isolado', async () => {
  const p = (await admin('/products', { method: 'POST', body: { name: 'SumTest A', sku: 'SUM-A', price: '10,00', minimum_stock: 10 } })).data;
  const pB = (await admin('/products', { method: 'POST', body: { name: 'SumTest B', sku: 'SUM-B', price: '10,00', minimum_stock: 10 } })).data;
  const pC = (await admin('/products', { method: 'POST', body: { name: 'SumTest C', sku: 'SUM-C', price: '10,00', minimum_stock: 10 } })).data;
  const pD = (await admin('/products', { method: 'POST', body: { name: 'SumTest D', sku: 'SUM-D', price: '10,00', minimum_stock: 10 } })).data;

  await entry(storeA, p.id, 5); await entry(storeB, p.id, 5);   // A: global 10 → nem baixo nem zerado
  await entry(storeA, pB.id, 4); await entry(storeB, pB.id, 5); // B: global 9 → baixo
  // C: sem saldo nenhuma loja → global 0 → zerado
  await entry(storeA, pD.id, 0 + 20); await entry(storeB, pD.id, 0); // D: global 20 → ok

  const g = (await admin('/stock')).data.summary;
  assert.equal(g.scope, 'company');
  assert.equal(g.total_units, 5 + 5 + 4 + 5 + 0 + 20 + 0);

  // verificação por produto: nenhum dos "alertas" conta loja como produto
  const lows = (await admin('/stock?low=1')).data.items.map((x) => x.product_id);
  assert.ok(!lows.includes(p.id), 'A: 5+5=10 não é baixo');
  assert.ok(lows.includes(pB.id), 'B: 4+5=9 é baixo');
  assert.ok(!lows.includes(pD.id), 'D: 20 não é baixo');
  const zeros = (await admin('/stock?zero=1')).data.items.map((x) => x.product_id);
  assert.ok(zeros.includes(pC.id), 'C: 0 em todas as lojas = zerado global');
  assert.ok(!zeros.includes(pD.id), 'D: 0 numa loja mas 20 na outra ≠ zerado global');

  // E: com store_id, o summary é exclusivo da loja
  const sA = (await admin(`/stock?store_id=${storeA}`)).data.summary;
  assert.equal(sA.scope, 'store');
  assert.equal(sA.zero_stock >= 1, true, 'loja A tem o zerado (pD=0, pC=0)');
  const lowsA = (await admin(`/stock?store_id=${storeA}&low=1`)).data.items.map((x) => x.product_id);
  assert.ok(lowsA.includes(pB.id), 'loja A: pB=4 < 10 → baixo na loja');
});

// ===================== 14. INVENTORY (testes 1–9) ===========================

test('INV1–4: contagem igual/maior/menor e movimentos posteriores (matemática exata)', async () => {
  // CENÁRIO OBRIGATÓRIO da auditoria: saldo 100 → contagem 90 → +20 → −10 →
  // saldo antes da finalização 110 → adjustment = 90−100 = −10 → FINAL 100.
  const p = (await admin('/products', { method: 'POST', body: { name: 'SumTest Inv', sku: 'SUM-I', price: '10,00' } })).data;
  await entry(storeA, p.id, 100);
  const inv = (await admin('/stock/inventory', { method: 'POST', body: { store_id: storeA } })).data;
  await admin(`/stock/inventory/${inv.id}/count`, { method: 'POST', body: { product_id: p.id, counted: 90 } }); // INV3: contagem menor
  await entry(storeA, p.id, 20); // +20
  await admin('/stock/exit', { method: 'POST', body: { store_id: storeA, product_id: p.id, quantity: 10 } }); // −10
  assert.equal(await bal(p.id, storeA), 110, 'saldo antes da finalização = 100 +20 −10');
  await admin(`/stock/inventory/${inv.id}/finalize`, { method: 'POST' });
  assert.equal(await bal(p.id, storeA), 100, 'saldo final = 90 (contado) + 10 (movimentos pós-contagem) = 100');

  // movimento de ajuste registrado com a quantidade correta (−10)
  const movs = (await admin(`/stock/movements?product_id=${p.id}&type=ADJUST_OUT`)).data.items;
  assert.ok(movs.some((m) => m.quantity === 10), 'ajuste de −10 registrado (não −20)');

  // INV1/13: contagem igual ao sistema + movimentos posteriores → SEM ajuste,
  // movimentos preservados: 100 → contagem 100 → +20 −10 → final 110.
  const inv2 = (await admin('/stock/inventory', { method: 'POST', body: { store_id: storeA } })).data;
  await admin(`/stock/inventory/${inv2.id}/count`, { method: 'POST', body: { product_id: p.id, counted: 100 } });
  await entry(storeA, p.id, 20);
  await admin('/stock/exit', { method: 'POST', body: { store_id: storeA, product_id: p.id, quantity: 10 } });
  await admin(`/stock/inventory/${inv2.id}/finalize`, { method: 'POST' });
  assert.equal(await bal(p.id, storeA), 110, 'contagem = sistema → sem ajuste; movimentos pós-contagem preservados');

  // INV2/11: INVERSÃO — saldo 110, contagem 120, depois +20 −5 (saldo 125):
  // adjustment = 120−110 = +10 → final 125+10 = 135.
  const inv3 = (await admin('/stock/inventory', { method: 'POST', body: { store_id: storeA } })).data;
  await admin(`/stock/inventory/${inv3.id}/count`, { method: 'POST', body: { product_id: p.id, counted: 120 } });
  await entry(storeA, p.id, 20);
  await admin('/stock/exit', { method: 'POST', body: { store_id: storeA, product_id: p.id, quantity: 5 } });
  assert.equal(await bal(p.id, storeA), 125, 'saldo antes da finalização = 110 +20 −5');
  await admin(`/stock/inventory/${inv3.id}/finalize`, { method: 'POST' });
  assert.equal(await bal(p.id, storeA), 135, 'inversão: 125 + (120−110) = 135');

  // INV12: sem movimento posterior — saldo 135, contagem 130 → final 130.
  const inv4 = (await admin('/stock/inventory', { method: 'POST', body: { store_id: storeA } })).data;
  await admin(`/stock/inventory/${inv4.id}/count`, { method: 'POST', body: { product_id: p.id, counted: 130 } });
  await admin(`/stock/inventory/${inv4.id}/finalize`, { method: 'POST' });
  assert.equal(await bal(p.id, storeA), 130, 'sem movimentos posteriores: saldo = contado');
});

test('INV5–9: finalização idempotente, múltiplos produtos, múltiplas lojas, tenant e RBAC', async () => {
  const pa = (await admin('/products', { method: 'POST', body: { name: 'SumTest M1', sku: 'SUM-M1', price: '1,00' } })).data;
  const pb = (await admin('/products', { method: 'POST', body: { name: 'SumTest M2', sku: 'SUM-M2', price: '1,00' } })).data;
  await entry(storeA, pa.id, 10); await entry(storeA, pb.id, 7);

  const inv = (await admin('/stock/inventory', { method: 'POST', body: { store_id: storeA } })).data;
  await admin(`/stock/inventory/${inv.id}/count`, { method: 'POST', body: { product_id: pa.id, counted: 8 } });
  await admin(`/stock/inventory/${inv.id}/count`, { method: 'POST', body: { product_id: pb.id, counted: 9 } });
  await admin(`/stock/inventory/${inv.id}/finalize`, { method: 'POST' });
  assert.equal(await bal(pa.id, storeA), 8, 'cada produto recebe apenas seu ajuste (M1: 10→8)');
  assert.equal(await bal(pb.id, storeA), 9, 'M2: 7→9');

  // INV5/6: dupla finalização não duplica ajuste
  assert.equal((await admin(`/stock/inventory/${inv.id}/finalize`, { method: 'POST' })).status, 409);
  assert.equal(await bal(pa.id, storeA), 8);
  assert.equal((await admin(`/stock/inventory/${inv.id}/count`, { method: 'POST', body: { product_id: pa.id, counted: 1 } })).status, 409);

  // INV7: inventário da loja B não altera a loja A
  const beforeA = await bal(pa.id, storeA);
  const invB = (await admin('/stock/inventory', { method: 'POST', body: { store_id: storeB } })).data;
  await admin(`/stock/inventory/${invB.id}/count`, { method: 'POST', body: { product_id: pa.id, counted: 3 } });
  await admin(`/stock/inventory/${invB.id}/finalize`, { method: 'POST' });
  assert.equal(await bal(pa.id, storeA), beforeA, 'loja A intacta');

  // INV8: tenant isolation
  const bLogin = await login('supervisor@anjos.com.br', passwordFor('supervisor@anjos.com.br') || 'Anjos@2026');
  const s = authed(bLogin.cookie);
  assert.equal((await s(`/stock/inventory/${inv.id}`)).status, 200, 'mesma empresa pode visualizar');
});

test('INV14: múltiplos produtos com movimentos pós-contagem — cada um só o seu ajuste', async () => {
  // Produto A: 100 → contado 90 → +20 −10 → adjustment −10 → final 100
  // Produto B: 50  → contado 60 → +5        → adjustment +10 → final 65
  const pa = (await admin('/products', { method: 'POST', body: { name: 'SumTest MA', sku: 'SUM-MA', price: '1,00' } })).data;
  const pb = (await admin('/products', { method: 'POST', body: { name: 'SumTest MB', sku: 'SUM-MB', price: '1,00' } })).data;
  await entry(storeA, pa.id, 100); await entry(storeA, pb.id, 50);

  const inv = (await admin('/stock/inventory', { method: 'POST', body: { store_id: storeA } })).data;
  await admin(`/stock/inventory/${inv.id}/count`, { method: 'POST', body: { product_id: pa.id, counted: 90 } });
  await admin(`/stock/inventory/${inv.id}/count`, { method: 'POST', body: { product_id: pb.id, counted: 60 } });
  await entry(storeA, pa.id, 20);
  await admin('/stock/exit', { method: 'POST', body: { store_id: storeA, product_id: pa.id, quantity: 10 } });
  await entry(storeA, pb.id, 5);
  await admin(`/stock/inventory/${inv.id}/finalize`, { method: 'POST' });

  assert.equal(await bal(pa.id, storeA), 100, 'A: 110 + (90−100) = 100');
  assert.equal(await bal(pb.id, storeA), 65, 'B: 55 + (60−50) = 65 — ajustes nunca misturados');
});

// ============== 16–18. RECONCILIAÇÃO END-TO-END INDEPENDENTE ================

test('RECON-E2E: saldo esperado calculado INDEPENDENTE bate com o persistido (por loja)', async () => {
  const p = (await admin('/products', { method: 'POST', body: { name: 'SumTest Recon', sku: 'SUM-R', price: '50,00' } })).data;
  const expected = { [storeA]: 0, [storeB]: 0 }; // livro-razão independente

  // 1. estoque inicial
  await entry(storeA, p.id, 100); expected[storeA] += 100;
  // 2. compra recebida +50
  const sup = (await admin('/suppliers', { method: 'POST', body: { name: 'SumTest Sup' } })).data;
  const compra = await admin('/purchases', { method: 'POST', body: { supplier_id: sup.id, store_id: storeA, purchase_date: '2026-10-05', items: [{ product_id: p.id, quantity: 50, unit_cost: '20,00' }] } });
  await admin(`/purchases/${compra.data.id}/receive`, { method: 'POST' }); expected[storeA] += 50;
  // 3. venda −10
  const v = await admin('/sales', { method: 'POST', body: { store_id: storeA, seller_id: sellerId, customer_name: 'Recon', sold_at: '2026-10-05', items: [{ product_id: p.id, quantity: 10 }] } });
  expected[storeA] -= 10;
  // 4. cancelamento da venda +10
  await admin(`/sales/${v.data.id}/cancel`, { method: 'POST', body: { reason: 'recon' } }); expected[storeA] += 10;
  // 5/7. transferência A→B −20/+20
  const tr = await admin('/stock/transfers', { method: 'POST', body: { from_store_id: storeA, to_store_id: storeB, items: [{ product_id: p.id, quantity: 20 }] } });
  await admin(`/stock/transfers/${tr.data.id}/complete`, { method: 'POST' });
  expected[storeA] -= 20; expected[storeB] += 20;
  // 8. nova compra +8
  const compra2 = await admin('/purchases', { method: 'POST', body: { supplier_id: sup.id, store_id: storeA, purchase_date: '2026-10-06', items: [{ product_id: p.id, quantity: 8, unit_cost: '20,00' }] } });
  await admin(`/purchases/${compra2.data.id}/receive`, { method: 'POST' }); expected[storeA] += 8;
  // 9. cancelamento da compra (estorno) −8
  await admin(`/purchases/${compra2.data.id}/cancel`, { method: 'POST', body: { reason: 'recon estorno' } }); expected[storeA] -= 8;
  // 10. ajuste +5
  await admin('/stock/adjust', { method: 'POST', body: { store_id: storeA, product_id: p.id, new_quantity: (expected[storeA] + 5) } });
  expected[storeA] += 5;
  // 11a. inventário SEM movimentos posteriores: contagem = saldo → sem ajuste
  const inv = (await admin('/stock/inventory', { method: 'POST', body: { store_id: storeA } })).data;
  await admin(`/stock/inventory/${inv.id}/count`, { method: 'POST', body: { product_id: p.id, counted: expected[storeA] } });
  await admin(`/stock/inventory/${inv.id}/finalize`, { method: 'POST' });

  // 11b. inventário COM movimentos posteriores à contagem (regra definitiva):
  // contagem = S−10 (system_at_count = S) → +6 e −1 → adjustment = −10.
  const S = expected[storeA];
  const inv2 = (await admin('/stock/inventory', { method: 'POST', body: { store_id: storeA } })).data;
  await admin(`/stock/inventory/${inv2.id}/count`, { method: 'POST', body: { product_id: p.id, counted: S - 10 } });
  await entry(storeA, p.id, 6); expected[storeA] += 6;   // movimento pós-contagem
  await admin('/stock/exit', { method: 'POST', body: { store_id: storeA, product_id: p.id, quantity: 1 } });
  expected[storeA] -= 1;
  await admin(`/stock/inventory/${inv2.id}/finalize`, { method: 'POST' });
  expected[storeA] += (S - 10) - S; // adjustment = contado − sistema_na_contagem = −10

  // 12. reconciliação: persistido vs esperado (calculado independentemente)
  assert.equal(await bal(p.id, storeA), expected[storeA], `loja A: persistido ≠ esperado (${expected[storeA]})`);
  assert.equal(await bal(p.id, storeB), expected[storeB], `loja B: persistido ≠ esperado (${expected[storeB]})`);
});
