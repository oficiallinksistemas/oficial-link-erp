'use strict';

/**
 * Regressão do fluxo frontend Venda → Contas a Receber (consolidação final
 * V3.0): campos visualmente travados NÃO podem fazer o valor derivado da venda
 * "sumir" do submit. O helper puro representa a derivação; o backend segue
 * autoridade absoluta (divergências → 400, coberto por receivables.test.js).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const SALES = [
  { id: 7, amount_cents: 24000, customer_id: 3, customer_name: 'Maria', store_id: 2, store_name: 'Balsas' },
  { id: 8, amount_cents: 5000, customer_id: null, customer_name: 'Balcão', store_id: 1, store_name: 'Imperatriz' },
];

async function load() {
  // helpers SEMPRE primeiro — o import do helper é DOM-free (ESM puro)
  require('./helpers');
  return import('../../web/assets/js/lib/receivablePayload.js');
}

test('venda selecionada: valor/cliente/loja derivados da venda (mesmo sem os campos no form)', async () => {
  const { buildReceivablePayload } = await load();
  // Simula o cenário do bug: selects disabled excluídos do FormData — o
  // payload ainda deve carregar os dados da venda.
  const formData = { sale_id: '7', description: 'Título', due_date: '2026-11-05' };
  const payload = buildReceivablePayload(formData, SALES);
  assert.equal(payload.sale_id, 7);
  assert.equal(payload.amount, 240, 'amount derivado de amount_cents (24000)');
  assert.equal(payload.customer_id, 3, 'cliente derivado da venda');
  assert.equal(payload.store_id, 2, 'loja derivada da venda');
  assert.equal(payload.due_date, '2026-11-05');
});

test('venda sem cliente: customer_id null (nunca injeta valor manual)', async () => {
  const { buildReceivablePayload } = await load();
  const payload = buildReceivablePayload({ sale_id: 8, description: 'T', due_date: '2026-11-05' }, SALES);
  assert.equal(payload.customer_id, null);
  assert.equal(payload.amount, 50);
});

test('manual (sem venda): usa os campos do formulário', async () => {
  const { buildReceivablePayload } = await load();
  const payload = buildReceivablePayload(
    { description: 'Aluguel', amount: '1.500,00', due_date: '2026-11-05', customer_id: '3', store_id: '2' },
    SALES
  );
  assert.equal(payload.sale_id, undefined);
  assert.equal(payload.amount, '1.500,00', 'valor manual preservado para validação');
  assert.equal(payload.customer_id, 3);
  assert.equal(payload.store_id, 2);
});

test('sale_id inexistente na lista: resolveSale retorna null e o fluxo manual não é falsificado', async () => {
  const { resolveSale, buildReceivablePayload } = await load();
  assert.equal(resolveSale(SALES, 999), null);
  const payload = buildReceivablePayload({ sale_id: '999', description: 'X', amount: '10,00', due_date: '2026-11-05' }, SALES);
  // sem venda resolvida, não deriva dados falsos — cai no fluxo manual
  assert.equal(payload.sale_id, undefined);
  assert.equal(payload.amount, '10,00');
});
