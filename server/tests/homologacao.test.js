'use strict';

/**
 * Bloco 3 — Homologação e Pré-lançamento (V3.5.0).
 *
 * Testa o que uma primeira empresa real encontraria:
 * H1 onboarding piloto nasce com camada operacional ativa (seed);
 * H2 isolamento A×B em todos os módulos (IDOR deliberado — dado nunca vaza);
 * H3 fluxo comercial completo (cliente/produto/estoque/venda/recebível/
 *    cancelamento) com consistência de estoque;
 * H4 fluxo de compras (fornecedor→compra→recebimento→payable idempotente);
 * H5 desativação de módulo: 403, dados preservados, reativação;
 * H6 virada de dia/timezone (tarefa atrasada só muda com businessToday).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
// helpers SEMPRE primeiro
const { login, authed, createTenant, shutdown } = require('./helpers');
const db = require('../src/database/connection');
const { businessToday } = require('../src/core/businessDate');

let master; let admin; let anjosId; let storeId; let tenantCompanyId; let tenantAdmin;
let sellerId;
const ids = {};

before(async () => {
  const m = await login('master@oficiallink.com.br', 'Master@2026');
  master = authed(m.cookie);
  anjosId = (await master('/platform/companies?search=Anjos')).data.items[0].id;
  const a = await login('admin@anjos.com.br', 'Anjos@2026');
  admin = authed(a.cookie);
  storeId = (await admin('/stores')).data.items[0].id;
  sellerId = (await admin('/users?per_page=100')).data.items.find((u) => /vendedor/.test(u.email || u.name || ''))?.id
    || (await admin('/users?per_page=100')).data.items[0].id;
  for (const slug of ['tasks', 'agenda', 'checklists', 'notifications']) {
    await master(`/platform/companies/${anjosId}/modules/${slug}`, { method: 'PUT', body: { status: 'active' } });
  }
  const t = await createTenant(master, 'HomologB');
  tenantCompanyId = t.company.id;
  for (const slug of ['tasks', 'agenda', 'checklists', 'notifications', 'sales', 'customers', 'products', 'purchases', 'suppliers']) {
    await master(`/platform/companies/${tenantCompanyId}/modules/${slug}`, { method: 'PUT', body: { status: 'active' } });
  }
  const tl = await login(t.user.email, 'Temp@123456');
  tenantAdmin = authed(tl.cookie);
});

after(shutdown);

// ---------------------------------------------------------------------------
test('H1: onboarding piloto — camada operacional ativa no seed', async () => {
  const mods = (await admin('/modules')).data.map((m2) => m2.slug);
  for (const s of ['tasks', 'agenda', 'checklists', 'notifications']) {
    assert.ok(mods.includes(s), `módulo ${s} deve estar ativo no seed`);
  }
});

// ---------------------------------------------------------------------------
test('H2: isolamento A×B — nenhum ID de A é acessível por B (IDOR deliberado)', async () => {
  const customer = (await admin('/customers', { method: 'POST', body: { name: 'Cliente Homolog A', document: '' } })).data;
  const product = (await admin('/products', { method: 'POST', body: { name: 'Prod Homolog A', sku: 'HOM-A1', price: '50,00' } })).data;
  ids.customer = customer.id; ids.product = product.id;

  const attempts = [
    ['GET', `/customers/${ids.customer}`],
    ['PATCH', `/customers/${ids.customer}`, { name: 'Sequestro' }],
    ['DELETE', `/customers/${ids.customer}`],
    ['GET', `/products/${ids.product}`],
    ['PATCH', `/products/${ids.product}`, { price: '0,01' }],
  ];
  for (const [method, path, body] of attempts) {
    const r = await tenantAdmin(path, body ? { method, body } : { method });
    assert.ok([403, 404].includes(r.status), `${method} ${path} deve ser 403/404: ${JSON.stringify(r.error)}`);
    const leaked = r.data && (r.data.name === 'Cliente Homolog A' || r.data.price_cents === 5000);
    assert.ok(!leaked, `${method} ${path} NUNCA pode vazar dados de outro tenant`);
  }
  // com os mesmos módulos ativos em B, o escopo por empresa responde 404/403
  const c = (await admin(`/customers/${ids.customer}`)).data;
  assert.equal(c.name, 'Cliente Homolog A');
  const p = (await admin(`/products/${ids.product}`)).data;
  assert.equal(p.price_cents, 5000);
});

// ---------------------------------------------------------------------------
test('H3: fluxo comercial completo com consistência de estoque e cancelamento', async () => {
  const supplier = (await admin('/suppliers', { method: 'POST', body: { name: 'Forn Homolog' } })).data;
  const purchase = (await admin('/purchases', {
    method: 'POST',
    body: {
      supplier_id: supplier.id, store_id: storeId,
      purchase_date: await businessToday(anjosId),
      items: [{ product_id: ids.product, quantity: 10, unit_cost: '25,00' }],
    },
  })).data;
  const recv = await admin(`/purchases/${purchase.id}/receive`, { method: 'POST', body: {} });
  assert.equal(recv.status, 200, `receive: ${JSON.stringify(recv.error)}`);
  const bal = () => db.prepare(
    'SELECT quantity FROM stock_balances WHERE company_id = ? AND store_id = ? AND product_id = ?'
  ).get(anjosId, storeId, ids.product);
  assert.equal(bal().quantity, 10, 'estoque deve subir para 10 após recebimento');

  const saleRes = await admin('/sales', {
    method: 'POST',
    body: {
      store_id: storeId, seller_id: sellerId, customer_name: 'Cliente Homolog A',
      sold_at: await businessToday(anjosId),
      items: [{ product_id: ids.product, quantity: 4 }],
    },
  });
  assert.equal(saleRes.status, 201, `venda: ${JSON.stringify(saleRes.error)}`);
  const sale = saleRes.data;
  assert.equal(bal().quantity, 6, 'estoque deve baixar para 6 após a venda');

  // O título a receber NÃO nasce com a venda: é lançado explicitamente via
  // POST /receivables com sale_id — o backend DERIVA valor/loja/cliente da
  // venda (consolidação V3.0) e rejeita payload divergente.
  const recRes = await admin('/receivables', {
    method: 'POST',
    body: { sale_id: sale.id, description: `Venda #${sale.id}`, due_date: await businessToday(anjosId) },
  });
  assert.equal(recRes.status, 201, `recebível: ${JSON.stringify(recRes.error)}`);
  assert.equal(recRes.data.amount_cents, 20000, 'valor derivado da venda (4 × 50,00)');
  assert.equal(recRes.data.sale_id, sale.id);
  const rec = db.prepare('SELECT id, amount_cents FROM accounts_receivable WHERE sale_id = ?').get(sale.id);
  assert.ok(rec, 'recebível deve existir');
  assert.equal(rec.amount_cents, 20000);

  const cancel = await admin(`/sales/${sale.id}/cancel`, { method: 'POST', body: { reason: 'homologação' } });
  assert.equal(cancel.status, 200);
  assert.equal(bal().quantity, 10, 'estorno deve devolver estoque para 10');
  const recAfter = db.prepare('SELECT status FROM accounts_receivable WHERE id = ?').get(rec.id);
  assert.equal(recAfter.status, 'canceled');

  // Relatório de vendas é AGREGADO (summary): por padrão exclui canceladas
  // do total e as apresenta como indicador separado (canceled_count).
  const rep = await admin(`/reports/sales?from=${await businessToday(anjosId)}&to=${await businessToday(anjosId)}`);
  assert.equal(rep.status, 200, JSON.stringify(rep.error));
  assert.equal(rep.data.summary.canceled_count >= 1, true, 'venda cancelada deve constar como indicador separado');
});

// ---------------------------------------------------------------------------
test('H4: compras — recebimento gera payable idempotente; duplo receive → 409', async () => {
  const supplier = (await admin('/suppliers', { method: 'POST', body: { name: 'Forn H4' } })).data;
  const purchase = (await admin('/purchases', {
    method: 'POST',
    body: {
      supplier_id: supplier.id, store_id: storeId, purchase_date: await businessToday(anjosId),
      items: [{ product_id: ids.product, quantity: 2, unit_cost: '10,00' }],
    },
  })).data;
  const r1 = await admin(`/purchases/${purchase.id}/receive`, { method: 'POST', body: {} });
  assert.equal(r1.status, 200, JSON.stringify(r1.error));
  const titles = db.prepare(
    "SELECT COUNT(*) AS c, SUM(amount_cents) AS s FROM accounts_payable WHERE purchase_id = ? AND origin_type = 'purchase'"
  ).get(purchase.id);
  assert.equal(titles.c, 1, 'exatamente 1 título a pagar (idempotente)');
  assert.equal(titles.s, 2000);
  const again = await admin(`/purchases/${purchase.id}/receive`, { method: 'POST', body: {} });
  assert.equal(again.status, 409);
});

// ---------------------------------------------------------------------------
test('H5: desativação de módulo — 403, dados preservados, reativação restaura', async () => {
  const t = (await admin('/tasks', { method: 'POST', body: { title: 'Tarefa sobrevive' } })).data;
  await master(`/platform/companies/${anjosId}/modules/tasks`, { method: 'PUT', body: { status: 'inactive' } });
  const blocked = await admin('/tasks');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.error.code, 'MODULE_INACTIVE');
  const row = db.prepare('SELECT title FROM tasks WHERE id = ?').get(t.id);
  assert.equal(row.title, 'Tarefa sobrevive');
  await master(`/platform/companies/${anjosId}/modules/tasks`, { method: 'PUT', body: { status: 'active' } });
  const back = await admin(`/tasks/${t.id}`);
  assert.equal(back.status, 200);
  assert.equal(back.data.title, 'Tarefa sobrevive');
});

// ---------------------------------------------------------------------------
test('H6: virada de dia — overdue da tarefa segue businessToday, não UTC', async () => {
  const today = await businessToday(anjosId);
  const [y, m, d] = today.split('-').map(Number);
  const yesterday = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  const tOver = (await admin('/tasks', { method: 'POST', body: { title: 'Vencida ontem', due_date: yesterday } })).data;
  const tToday = (await admin('/tasks', { method: 'POST', body: { title: 'Vence hoje', due_date: today } })).data;
  const tTomorrow = (await admin('/tasks', { method: 'POST', body: { title: 'Vence amanhã', due_date: tomorrow } })).data;
  const overdue = (await admin('/tasks?overdue=1')).data.items;
  const idsOver = overdue.map((i) => i.id);
  assert.ok(idsOver.includes(tOver.id));
  assert.ok(!idsOver.includes(tToday.id), 'vencendo hoje NÃO é overdue');
  assert.ok(!idsOver.includes(tTomorrow.id), 'futura NÃO é overdue');
});
