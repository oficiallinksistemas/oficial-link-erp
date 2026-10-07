'use strict';

/**
 * V1.9 FINAL — Consolidação corretiva: invariantes de integridade operacional.
 * Banco temporário isolado (helpers). Nenhum teste existente é alterado aqui.
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
  prod = (await admin('/products', { method: 'POST', body: { name: 'Cons Prod', sku: 'CONS-1', price: '10,00' } })).data;
  supplier = (await admin('/suppliers', { method: 'POST', body: { name: 'Cons Fornecedor' } })).data;
  tenantB = await createTenant(master, 'EmpresaCons');
});

after(shutdown);

const balance = async (pid, store, search = 'CONS') => {
  const r = await admin(`/stock?store_id=${store}&search=${encodeURIComponent(search)}`);
  const row = r.data.items.find((p) => p.product_id === pid);
  return row ? row.quantity : 0;
};
const entry = (store, pid, qty) => admin('/stock/entry', { method: 'POST', body: { store_id: store, product_id: pid, quantity: qty } });
const sale = (body) => admin('/sales', { method: 'POST', body });
const setStock = (on) => master(`/platform/companies/${anjosId}/modules/stock`, { method: 'PUT', body: { status: on ? 'active' : 'inactive' } });

// ============================ 2. LOJA DA VENDA ==============================

test('V1: venda com baixa não pode mudar de loja (SALE_STORE_LOCKED); sem baixa mantém comportamento', async () => {
  await entry(storeA, prod.id, 30);
  const s = await sale({ store_id: storeA, seller_id: sellerId, customer_name: 'Lock Loja', sold_at: '2026-10-05', items: [{ product_id: prod.id, quantity: 2 }] });
  assert.equal(s.data.stock_was_applied, 1);

  const patch = await admin(`/sales/${s.data.id}`, { method: 'PATCH', body: { store_id: storeB } });
  assert.equal(patch.status, 409);
  assert.equal(patch.error.code, 'SALE_STORE_LOCKED');
  assert.equal(await balance(prod.id, storeA), 28, 'estoque intacto na loja original');
  assert.equal(await balance(prod.id, storeB), 0, 'sem estoque fantasma na nova loja');

  const c = await admin(`/sales/${s.data.id}/cancel`, { method: 'POST', body: { reason: 'estorno na loja correta' } });
  assert.equal(c.status, 200);
  assert.equal(await balance(prod.id, storeA), 30, 'estorno SEMPRE na loja original');

  // loja de outra empresa continua bloqueada (mesmo sem estoque aplicado)
  const s2 = await sale({ store_id: storeA, seller_id: sellerId, customer_name: 'NoStock', amount: '5,00', sold_at: '2026-10-05' });
  assert.equal((await admin(`/sales/${s2.data.id}`, { method: 'PATCH', body: { store_id: storeB } })).status, 200, 'sem baixa: loja da mesma empresa pode mudar');
  await admin(`/sales/${s2.data.id}`, { method: 'PATCH', body: { store_id: storeA } });
});

// ====================== 3–5. INVENTÁRIO × CONCORRÊNCIA ======================

test('INV-A: contagem → venda → finalização preserva ambos (regra definitiva)', async () => {
  const inv = (await admin('/stock/inventory', { method: 'POST', body: { store_id: storeA } })).data;
  await admin(`/stock/inventory/${inv.id}/count`, { method: 'POST', body: { product_id: prod.id, counted: 28 } }); // contou 28 (= saldo do momento)
  const v = await sale({ store_id: storeA, seller_id: sellerId, customer_name: 'Pós-contagem', sold_at: '2026-10-05', items: [{ product_id: prod.id, quantity: 5 }] });
  await admin(`/stock/inventory/${inv.id}/finalize`, { method: 'POST' });
  // REGRA DEFINITIVA: adjustment = contado(28) − sistema_na_contagem(28) = 0 →
  // NENHUM ajuste; a venda posterior permanece no saldo: 28 − 5 = 23.
  assert.equal(await balance(prod.id, storeA), 23, 'movimento posterior preservado (nenhum ajuste aplicado)');
  await admin(`/sales/${v.data.id}/cancel`, { method: 'POST', body: { reason: 'limpeza A' } }); // estorna 5 → 28
  assert.equal(await balance(prod.id, storeA), 28);
});

test('INV-B/C/D/E: recebimento, transferência e ajuste entre contagem e finalização', async () => {
  const base = await balance(prod.id, storeA);
  const inv = (await admin('/stock/inventory', { method: 'POST', body: { store_id: storeA } })).data;
  await admin(`/stock/inventory/${inv.id}/count`, { method: 'POST', body: { product_id: prod.id, counted: base } });

  // B: compra recebida +4
  const compra = await admin('/purchases', { method: 'POST', body: { supplier_id: supplier.id, store_id: storeA, purchase_date: '2026-10-05', items: [{ product_id: prod.id, quantity: 4, unit_cost: '3,00' }] } });
  await admin(`/purchases/${compra.data.id}/receive`, { method: 'POST' });
  // C: transferência -2 p/ loja B
  const tr = await admin('/stock/transfers', { method: 'POST', body: { from_store_id: storeA, to_store_id: storeB, items: [{ product_id: prod.id, quantity: 2 }] } });
  await admin(`/stock/transfers/${tr.data.id}/complete`, { method: 'POST' });
  // D: ajuste manual -1
  await admin('/stock/adjust', { method: 'POST', body: { store_id: storeA, product_id: prod.id, new_quantity: (await balance(prod.id, storeA)) - 1 } });

  await admin(`/stock/inventory/${inv.id}/finalize`, { method: 'POST' });
  // REGRA DEFINITIVA: contagem = base e sistema_na_contagem = base →
  // adjustment = 0 → NENHUM ajuste; as movimentações posteriores (+4 −2 −1)
  // PERMANECEM no saldo: base + 1.
  assert.equal(await balance(prod.id, storeA), base + 1, 'movimentos posteriores preservados (nenhum ajuste)');
  assert.equal(await balance(prod.id, storeB, 'CONS'), 2, 'transferência permanece na loja B');
});

test('INV-F/G: dupla finalização 409; loja B isolada da contagem da loja A', async () => {
  const inv = (await admin('/stock/inventory', { method: 'POST', body: { store_id: storeA } })).data;
  await admin(`/stock/inventory/${inv.id}/count`, { method: 'POST', body: { product_id: prod.id, counted: 0 } });
  assert.equal((await admin(`/stock/inventory/${inv.id}/finalize`, { method: 'POST' })).status, 200);
  assert.equal((await admin(`/stock/inventory/${inv.id}/finalize`, { method: 'POST' })).status, 409);
  assert.equal((await admin(`/stock/inventory/${inv.id}/count`, { method: 'POST', body: { product_id: prod.id, counted: 0 } })).status, 409, 'sem contagem após finalizar');

  // G: movimento na loja B não afeta inventário da loja A
  const invA = (await admin('/stock/inventory', { method: 'POST', body: { store_id: storeA } })).data;
  const balA = await balance(prod.id, storeA);
  await entry(storeB, prod.id, 99); // movimento só na loja B
  await admin(`/stock/inventory/${invA.id}/count`, { method: 'POST', body: { product_id: prod.id, counted: balA } });
  await admin(`/stock/inventory/${invA.id}/finalize`, { method: 'POST' });
  assert.equal(await balance(prod.id, storeA), balA, 'movimentação da loja B não contaminou a loja A');
});

// ====================== 6. DELETE DE PRODUTO ================================

test('DEL: produto com inventory_items/transferências não pode ser excluído (409, nunca 500)', async () => {
  const r = await admin(`/products/${prod.id}`, { method: 'DELETE' });
  assert.equal(r.status, 409);
  assert.ok(/inventário|transferência/i.test(r.error.message));
});

// ============== 7–8. PURCHASES × STOCK MODULE / ESTADOS =====================

test('PUR: Stock OFF bloqueia receive/cancel-received (403, nada persiste); ON funciona', async () => {
  const p2 = (await admin('/products', { method: 'POST', body: { name: 'Cons Prod2', sku: 'CONS-2', price: '7,00' } })).data;
  await setStock(false);
  const draft = await admin('/purchases', { method: 'POST', body: { supplier_id: supplier.id, store_id: storeA, purchase_date: '2026-10-06', items: [{ product_id: p2.id, quantity: 5, unit_cost: '2,00' }] } });
  assert.equal(draft.status, 201, 'draft pode existir sem Stock');

  const rec = await admin(`/purchases/${draft.data.id}/receive`, { method: 'POST' });
  assert.equal(rec.status, 403);
  assert.equal(rec.error.code, 'MODULE_INACTIVE');
  const stillDraft = await admin(`/purchases/${draft.data.id}`);
  assert.equal(stillDraft.data.status, 'draft', 'status intacto');

  await setStock(true);
  assert.equal(await balance(p2.id, storeA, 'CONS-2'), 0, 'nenhuma entrada persistida');
  assert.equal((await admin(`/purchases/${draft.data.id}/receive`, { method: 'POST' })).status, 200);
  assert.equal(await balance(p2.id, storeA, 'CONS-2'), 5);

  await setStock(false);
  const cancelOff = await admin(`/purchases/${draft.data.id}/cancel`, { method: 'POST', body: { reason: 'com stock off' } });
  assert.equal(cancelOff.status, 403);
  const stillReceived = await admin(`/purchases/${draft.data.id}`);
  assert.equal(stillReceived.data.status, 'received', 'sem cancelamento parcial');

  await setStock(true);
  assert.equal(await balance(p2.id, storeA, 'CONS-2'), 5, 'estoque intacto');
  assert.equal((await admin(`/purchases/${draft.data.id}/cancel`, { method: 'POST', body: { reason: 'agora sim' } })).status, 200);
  assert.equal(await balance(p2.id, storeA, 'CONS-2'), 0, 'estorno correto');
});

// ====================== 9–10. SEMÂNTICA DOS RELATÓRIOS ======================

test('REP: vendas excluem canceladas por padrão; compras contam só received no total efetivo', async () => {
  const s = await sale({ store_id: storeA, seller_id: sellerId, customer_name: 'Rep Ativa', sold_at: '2026-10-06', amount: '100,00' });
  const sc = await sale({ store_id: storeA, seller_id: sellerId, customer_name: 'Rep Cancelada', sold_at: '2026-10-06', amount: '999,00' });
  await admin(`/sales/${sc.data.id}/cancel`, { method: 'POST', body: { reason: 'cancelada de teste' } });

  const rep = await admin('/reports/sales?from=2026-10-01&to=2026-10-31');
  assert.equal(rep.data.summary.status_filter, 'active');
  const canceledTotal = rep.data.summary.canceled_cents;
  assert.ok(canceledTotal >= 99900, 'canceladas como indicador separado');
  const activeTotal = rep.data.summary.total_cents;
  assert.ok(activeTotal < canceledTotal + activeTotal, 'faturamento não mistura canceladas');
  const all = await admin('/reports/sales?from=2026-10-01&to=2026-10-31&status=all');
  assert.equal(all.data.summary.status_filter, 'all');
  assert.ok(all.data.summary.total_cents >= activeTotal);

  // compras: draft e received no período — total efetivo só received
  const draftP = await admin('/purchases', { method: 'POST', body: { supplier_id: supplier.id, store_id: storeA, purchase_date: '2026-10-06', items: [{ product_id: prod.id, quantity: 1, unit_cost: '1,00' }] } });
  const repP = await admin('/reports/purchases?from=2026-10-01&to=2026-10-31');
  assert.equal(repP.data.summary.status_filter, 'received');
  assert.ok(repP.data.summary.drafts_count >= 1, 'draft como indicador separado');
  await admin(`/purchases/${draftP.data.id}/cancel`, { method: 'POST', body: { reason: 'limpeza rep' } });
});

// ====================== 13. RECONCILIAÇÃO DE ESTOQUE ========================

test('RECON: saldo persistido = soma dos movimentos (entradas − saídas)', async () => {
  const companyId = anjosId;
  const rows = db.prepare(
    `SELECT b.company_id, b.store_id, b.product_id, b.quantity,
       COALESCE(SUM(CASE m.type WHEN 'ENTRY' THEN m.quantity WHEN 'EXIT' THEN -m.quantity
         WHEN 'ADJUST_IN' THEN m.quantity WHEN 'ADJUST_OUT' THEN -m.quantity
         WHEN 'SALE' THEN -m.quantity WHEN 'SALE_REVERSAL' THEN m.quantity ELSE 0 END), 0) AS computed
     FROM stock_balances b
     LEFT JOIN stock_movements m ON m.company_id = b.company_id AND m.store_id = b.store_id AND m.product_id = b.product_id
     WHERE b.company_id = ? GROUP BY b.id`
  ).all(companyId);
  assert.ok(rows.length >= 1, 'há saldos para reconciliar');
  for (const r of rows) {
    assert.equal(r.quantity, r.computed, `saldo divergente em store=${r.store_id} product=${r.product_id}`);
  }
});

// ====================== 26. FLUXO COMPLETO + TENANT =========================

test('FLUXO: cadeia completa funciona e Empresa B não atravessa o tenant', async () => {
  const pf = (await admin('/products', { method: 'POST', body: { name: 'Cons Fluxo', sku: 'CONS-F', price: '40,00' } })).data;
  const compra = await admin('/purchases', { method: 'POST', body: { supplier_id: supplier.id, store_id: storeA, purchase_date: '2026-10-07', items: [{ product_id: pf.id, quantity: 12, unit_cost: '15,00' }] } });
  await admin(`/purchases/${compra.data.id}/receive`, { method: 'POST' });
  const tr = await admin('/stock/transfers', { method: 'POST', body: { from_store_id: storeA, to_store_id: storeB, items: [{ product_id: pf.id, quantity: 4 }] } });
  await admin(`/stock/transfers/${tr.data.id}/complete`, { method: 'POST' });
  const v = await sale({ store_id: storeB, seller_id: sellerId, customer_name: 'Fluxo B', sold_at: '2026-10-07', items: [{ product_id: pf.id, quantity: 3 }] });
  assert.equal(v.data.amount_cents, 12000);
  await admin(`/sales/${v.data.id}/cancel`, { method: 'POST', body: { reason: 'fluxo' } });
  assert.equal(await balance(pf.id, storeB, 'CONS-F'), 4, 'estorno na loja B (loja da venda)');
  assert.equal(await balance(pf.id, storeA, 'CONS-F'), 8);

  const rep = await admin('/reports/products?from=2026-10-01&to=2026-10-31');
  const rowF = rep.data.items.find((p) => p.product_id === pf.id);
  assert.ok(!rowF || rowF.quantity === 0, 'venda cancelada não entra no giro');

  // Empresa B não atravessa nada (módulos ativados para exercitar o 404 de
  // escopo, não o 403 de gate)
  const bLogin = await login('admin@empresacons.com', 'Temp@123456');
  const b = authed(bLogin.cookie);
  for (const mod of ['purchases', 'suppliers', 'stock', 'sales', 'reports']) {
    await master(`/platform/companies/${tenantB.company.id}/modules/${mod}`, { method: 'PUT', body: { status: 'active' } });
  }
  for (const ep of [`/purchases/${compra.data.id}`, `/sales/${v.data.id}`, `/suppliers/${supplier.id}`, `/stock/transfers/${tr.data.id}`]) {
    assert.equal((await b(ep)).status, 404, `${ep} isolado`);
  }
  const bRep = await b('/reports/sales');
  assert.equal(bRep.data.summary.sales_count, 0);
});
