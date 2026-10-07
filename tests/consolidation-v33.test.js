'use strict';

/**
 * Consolidação v3.3.x — proteção de correções desta etapa:
 *
 * 1. Relatório de Contas a Pagar: open/overdue derivados pela data de
 *    NEGÓCIO da empresa (core/businessDate) — regressão do bug de timezone
 *    (date('now') UTC) corrigido em reports/service.js payables().
 * 2. Compra recebida gera título a pagar com issue_date = data de negócio
 *    da empresa (nunca UTC do servidor).
 * 3. GET /platform/billing/charges/:id — endpoint dedicado usado pelos
 *    modais do Financeiro SaaS (antes varriam 100 itens no cliente).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
// helpers SEMPRE primeiro
const { login, authed, shutdown } = require('./helpers');
const db = require('../src/database/connection');
const { businessToday } = require('../src/core/businessDate');

let master; let admin; let anjosId; let storeId; let supplier; let product;

before(async () => {
  const m = await login('master@oficiallink.com.br', 'Master@2026');
  master = authed(m.cookie);
  anjosId = (await master('/platform/companies?search=Anjos')).data.items[0].id;
  const a = await login('admin@anjos.com.br', 'Anjos@2026');
  admin = authed(a.cookie);
  storeId = (await admin('/stores')).data.items[0].id;
  supplier = (await admin('/suppliers', { method: 'POST', body: { name: 'Forn Consolidação' } })).data;
  product = (await admin('/products', { method: 'POST', body: { name: 'Prod Consolidação', sku: 'CONS-1', price: '10,00' } })).data;
});

after(shutdown);

test('relatório payables: open/overdue pela data de negócio da empresa (fronteira do fuso)', async () => {
  const today = await businessToday(anjosId);
  const [y, mo, d] = today.split('-').map(Number);
  const yesterday = new Date(Date.UTC(y, mo - 1, d - 1)).toISOString().slice(0, 10);

  // título vencido (ontem) e título vencendo hoje (ainda "em dia")
  await admin('/payables', {
    method: 'POST',
    body: { description: 'Consolidação vencida', amount: '100,00', due_date: yesterday, supplier_id: supplier.id, store_id: storeId },
  });
  await admin('/payables', {
    method: 'POST',
    body: { description: 'Consolidação vence hoje', amount: '200,00', due_date: today, supplier_id: supplier.id, store_id: storeId },
  });

  const r = await admin('/reports/payables');
  assert.equal(r.status, 200, JSON.stringify(r.error));
  const s = r.data.summary;
  // vencendo hoje NÃO é overdue (>= hoje), o de ontem é
  assert.ok(s.overdue_count >= 1, 'título de ontem deve contar como overdue');
  assert.ok(s.open_count >= 1, 'título vencendo hoje deve contar como open');
  assert.equal(s.open_cents % 100, 0);
  assert.equal(s.overdue_cents % 100, 0);
});

test('compra recebida gera título com issue_date = data de negócio da empresa', async () => {
  const purchase = (await admin('/purchases', {
    method: 'POST',
    body: {
      supplier_id: supplier.id, store_id: storeId, purchase_date: await businessToday(anjosId),
      items: [{ product_id: product.id, quantity: 2, unit_cost: '5,00' }],
    },
  })).data;
  const recv = await admin(`/purchases/${purchase.id}/receive`, { method: 'POST', body: {} });
  assert.equal(recv.status, 200, JSON.stringify(recv.error));

  const title = db.prepare(
    'SELECT issue_date FROM accounts_payable WHERE purchase_id = ?'
  ).get(purchase.id);
  assert.ok(title, 'título a pagar deve existir após recebimento');
  assert.equal(title.issue_date, await businessToday(anjosId),
    `issue_date (${title.issue_date}) deve ser a data de negócio (${await businessToday(anjosId)}), não UTC`);
});

test('billing: GET /charges/:id (200 com dados; 404 inexistente; tenant 403)', async () => {
  const companyId = anjosId;
  const created = (await master('/platform/billing/charges', {
    method: 'POST',
    body: { company_id: companyId, type: 'custom', amount: '42,00', due_date: await businessToday(companyId) },
  })).data;

  const r1 = await master(`/platform/billing/charges/${created.id}`);
  assert.equal(r1.status, 200);
  assert.equal(r1.data.id, created.id);
  assert.equal(r1.data.amount_cents, 4200);
  assert.equal(r1.data.company_name.length > 0, true);

  const r404 = await master('/platform/billing/charges/999999');
  assert.equal(r404.status, 404);

  const t = await login('admin@anjos.com.br', 'Anjos@2026');
  const tenantAdmin = authed(t.cookie);
  const r403 = await tenantAdmin(`/platform/billing/charges/${created.id}`);
  assert.equal(r403.status, 403);
});
