'use strict';

/**
 * Contas a Receber (v3.0) — CRUD, recebimento idempotente/concorrente,
 * vínculo com vendas (unicidade por constraint), cancelamento de venda
 * integrado, fuso empresarial, RBAC, gating e IDOR.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
// helpers SEMPRE primeiro
const { api, login, authed, createTenant, shutdown, passwordFor } = require('./helpers');
const db = require('../src/database/connection');

let admin; let master; let anjosId; let storeId; let sellerId; let tenantB; let customer; let product;

before(async () => {
  const m = await login('master@oficiallink.com.br', 'Master@2026');
  master = authed(m.cookie);
  anjosId = (await master('/platform/companies?search=Anjos')).data.items[0].id;
  const a = await login('admin@anjos.com.br', 'Anjos@2026');
  admin = authed(a.cookie);
  storeId = (await admin('/stores')).data.items[0].id;
  sellerId = (await admin('/users?per_page=50')).data.items.find((u) => u.role_slug === 'seller').id;
  customer = (await admin('/customers', { method: 'POST', body: { name: 'Cliente CR' } })).data;
  product = (await admin('/products', { method: 'POST', body: { name: 'Prod CR', sku: 'CR-1', price: '10,00' } })).data;
  await admin('/stock/entry', { method: 'POST', body: { store_id: storeId, product_id: product.id, quantity: 100 } });
  tenantB = await createTenant(master, 'EmpresaCR');
});

after(shutdown);

const newTitle = (extra = {}) => admin('/receivables', {
  method: 'POST',
  body: { description: 'Título CR', amount: '500,00', due_date: '2026-10-20', customer_id: customer.id, store_id: storeId, ...extra },
});
const sale = (qty = 2) => admin('/sales', {
  method: 'POST',
  body: { store_id: storeId, seller_id: sellerId, customer_name: customer.name, customer_id: customer.id, sold_at: '2026-10-05', items: [{ product_id: product.id, quantity: qty }] },
});

// ------------------------------- CRUD --------------------------------------

test('CRUD: criar (centavos), editar em aberto, OVERDUE derivado, validações', async () => {
  const t = await newTitle();
  assert.equal(t.status, 201, JSON.stringify(t.error));
  assert.equal(t.data.amount_cents, 50000);
  assert.equal(t.data.effective_status, 'open');

  assert.equal((await admin('/receivables', { method: 'POST', body: { description: 'X', amount: '0,00', due_date: '2026-10-20' } })).status, 400);
  assert.equal((await admin('/receivables', { method: 'POST', body: { description: 'Xis', amount: '10,00', due_date: '2026-13-40' } })).status, 400);
  assert.equal((await admin('/receivables', { method: 'POST', body: { description: 'Xis', amount: '10,00', due_date: '2026-10-20', customer_id: 99999 } })).status, 400);
  assert.equal((await admin('/receivables', { method: 'POST', body: { description: 'Xis', amount: '10,00', due_date: '2026-10-20', sale_id: 99999 } })).status, 404);

  const past = await newTitle({ due_date: '2020-01-01' });
  assert.equal(past.data.effective_status, 'overdue', 'vencido derivado pela data de negócio');

  const edited = await admin(`/receivables/${t.data.id}`, { method: 'PATCH', body: { description: 'Editado CR', due_date: '2026-11-30' } });
  assert.equal(edited.status, 200);
  // título não manipulável para virar pago sem o endpoint (status/recebido ignorados)
  const hack = await admin(`/receivables/${t.data.id}`, { method: 'PATCH', body: { status: 'paid', received_amount_cents: 1 } });
  assert.notEqual(hack.data.status, 'paid', 'status não é manipulável via PATCH');
});

// ------------------------------ RECEBIMENTO ---------------------------------

test('RECEBIMENTO: recebe, duplo → 409, cancelado → 409, recebido não cancela nem edita', async () => {
  const t = await newTitle();
  const paid = await admin(`/receivables/${t.data.id}/receive`, { method: 'POST' });
  assert.equal(paid.status, 200);
  assert.equal(paid.data.status, 'paid');
  assert.equal(paid.data.received_amount_cents, 50000);
  assert.ok(paid.data.received_at);

  assert.equal((await admin(`/receivables/${t.data.id}/receive`, { method: 'POST' })).status, 409);
  assert.equal((await admin(`/receivables/${t.data.id}/cancel`, { method: 'POST', body: { reason: 'não pode' } })).status, 409);
  assert.equal((await admin(`/receivables/${t.data.id}`, { method: 'PATCH', body: { description: 'X' } })).status, 409);

  const c = await newTitle();
  await admin(`/receivables/${c.data.id}/cancel`, { method: 'POST', body: { reason: 'desistência' } });
  assert.equal((await admin(`/receivables/${c.data.id}/receive`, { method: 'POST' })).status, 409);
});

test('CONCORRÊNCIA: dois recebimentos simultâneos → exatamente um vence', async () => {
  const t = await newTitle();
  const [r1, r2] = await Promise.all([
    admin(`/receivables/${t.data.id}/receive`, { method: 'POST' }),
    admin(`/receivables/${t.data.id}/receive`, { method: 'POST' }),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  const detail = await admin(`/receivables/${t.data.id}`);
  assert.equal(detail.data.received_amount_cents, 50000, 'valor único');
});

// ------------------------- VÍNCULO COM VENDAS --------------------------------

test('SALE: título vinculado à venda (valor livre), duplicidade bloqueada por constraint', async () => {
  const v = await sale(3);
  assert.equal(v.status, 201);
  const t = await admin('/receivables', {
    method: 'POST',
    body: { description: 'Venda a prazo', amount: '30,00', due_date: '2026-11-05', sale_id: v.data.id, customer_id: customer.id },
  });
  assert.equal(t.status, 201);
  assert.equal(t.data.origin, 'sale');
  assert.equal(t.data.sale_id, v.data.id);

  const dup = await admin('/receivables', {
    method: 'POST',
    body: { description: 'Duplicata', amount: '30,00', due_date: '2026-11-05', sale_id: v.data.id },
  });
  assert.equal(dup.status, 409, 'uma venda = um título (UNIQUE no banco)');

  // venda cancelada não recebe título novo
  const v2 = await sale(1);
  await admin(`/sales/${v2.data.id}/cancel`, { method: 'POST', body: { reason: 'virou título? não' } });
  const t2 = await admin('/receivables', { method: 'POST', body: { description: 'Xis v2', amount: '10,00', due_date: '2026-11-05', sale_id: v2.data.id } });
  assert.equal(t2.status, 409, 'venda cancelada não recebe título');
});

// ------------------- CANCELAMENTO DE VENDA INTEGRADO --------------------------

test('SALE-CANCEL: título ABERTO acompanha o cancelamento da venda (mesma transação)', async () => {
  const v = await sale(4);
  const t = await admin('/receivables', { method: 'POST', body: { description: 'Vínculo cancel', amount: '40,00', due_date: '2026-11-10', sale_id: v.data.id } });
  assert.equal(t.status, 201);

  const balBefore = (await admin(`/stock?store_id=${storeId}&search=CR-1`)).data.items[0].quantity;
  const canceled = await admin(`/sales/${v.data.id}/cancel`, { method: 'POST', body: { reason: 'devolução cliente' } });
  assert.equal(canceled.status, 200);
  assert.equal(canceled.data.status, 'canceled');

  const after = await admin(`/receivables/${t.data.id}`);
  assert.equal(after.data.status, 'canceled', 'título cancelado junto');
  const balAfter = (await admin(`/stock?store_id=${storeId}&search=CR-1`)).data.items[0].quantity;
  assert.equal(balAfter, balBefore + 4, 'estorno de estoque na mesma operação');

  const audit = await master(`/platform/audit?company_id=${anjosId}&action=receivable.cancel`);
  assert.ok(audit.data.items.some((a) => a.entity_id === t.data.id && String(a.metadata || '').includes('consequência')));

  // título de venda não pode ser cancelado manualmente nem deletado
  const v3 = await sale(1);
  const t3 = await admin('/receivables', { method: 'POST', body: { description: 'S3', amount: '10,00', due_date: '2026-11-05', sale_id: v3.data.id } });
  assert.equal((await admin(`/receivables/${t3.data.id}/cancel`, { method: 'POST', body: { reason: 'manual' } })).status, 409, 'título de venda só cancela via venda');
  assert.equal((await admin(`/receivables/${t3.data.id}`, { method: 'DELETE' })).status, 409, 'título de venda nunca é delete');
});

test('SALE-PAID-BLOCK: título RECEBIDO bloqueia o cancelamento da venda (409, nada alterado)', async () => {
  const v = await sale(2);
  const t = await admin('/receivables', { method: 'POST', body: { description: 'Pago trava', amount: '20,00', due_date: '2026-11-05', sale_id: v.data.id } });
  await admin(`/receivables/${t.data.id}/receive`, { method: 'POST' });

  const balBefore = (await admin(`/stock?store_id=${storeId}&search=CR-1`)).data.items[0].quantity;
  const r = await admin(`/sales/${v.data.id}/cancel`, { method: 'POST', body: { reason: 'tentativa com título recebido' } });
  assert.equal(r.status, 409);
  assert.ok(/recebido|estorno/i.test(r.error.message));

  assert.equal((await admin(`/sales/${v.data.id}`)).data.status, 'active', 'venda intacta');
  assert.equal((await admin(`/receivables/${t.data.id}`)).data.status, 'paid', 'título intacto');
  assert.equal((await admin(`/stock?store_id=${storeId}&search=CR-1`)).data.items[0].quantity, balBefore, 'sem estorno parcial');
});

test('SALE-ATOMIC: cancelamento altera venda + título + estoque juntos; retry não duplica estorno', async () => {
  const v = await sale(5);
  const t = await admin('/receivables', { method: 'POST', body: { description: 'Atomic', amount: '50,00', due_date: '2026-11-05', sale_id: v.data.id } });
  const balBefore = (await admin(`/stock?store_id=${storeId}&search=CR-1`)).data.items[0].quantity;

  const r = await admin(`/sales/${v.data.id}/cancel`, { method: 'POST', body: { reason: 'cancelamento atômico' } });
  assert.equal(r.status, 200);
  assert.equal((await admin(`/sales/${v.data.id}`)).data.status, 'canceled');
  assert.equal((await admin(`/receivables/${t.data.id}`)).data.status, 'canceled');
  const balAfter = (await admin(`/stock?store_id=${storeId}&search=CR-1`)).data.items[0].quantity;
  assert.equal(balAfter, balBefore + 5, 'estorno aplicado uma única vez');

  // retry: 409 e NENHUM efeito adicional
  const again = await admin(`/sales/${v.data.id}/cancel`, { method: 'POST', body: { reason: 'novamente' } });
  assert.equal(again.status, 409);
  assert.equal((await admin(`/stock?store_id=${storeId}&search=CR-1`)).data.items[0].quantity, balAfter, 'sem segundo estorno');
});

// ------------------------- GATING / RBAC / IDOR / FUSO -----------------------

test('gating/RBAC: módulo inativo → 403; seller sem acesso; supervisor lança', async () => {
  assert.equal((await api('/receivables')).status, 401);
  const s = await login('vendedor@anjos.com.br', passwordFor('vendedor@anjos.com.br') || 'Anjos@2026');
  const seller = authed(s.cookie);
  assert.equal((await seller('/receivables')).status, 403);

  await master(`/platform/companies/${anjosId}/modules/receivables`, { method: 'PUT', body: { status: 'inactive' } });
  const blocked = await admin('/receivables');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.error.code, 'MODULE_INACTIVE');
  await master(`/platform/companies/${anjosId}/modules/receivables`, { method: 'PUT', body: { status: 'active' } });

  const sup = await login('supervisor@anjos.com.br', passwordFor('supervisor@anjos.com.br') || 'Anjos@2026');
  const supervisor = authed(sup.cookie);
  const created = await supervisor('/receivables', { method: 'POST', body: { description: 'Sup CR', amount: '50,00', due_date: '2026-12-01' } });
  assert.equal(created.status, 201, 'supervisor lança');
  assert.equal((await supervisor(`/receivables/${created.data.id}`, { method: 'DELETE' })).status, 403, 'supervisor SEM delete');
  assert.equal((await admin(`/receivables/${created.data.id}`, { method: 'DELETE' })).status, 200, 'admin (delete) exclui manual aberto');
});

test('IDOR: Empresa B não acessa, recebe, cancela nem lista títulos da Anjos', async () => {
  const t = await newTitle();
  const bLogin = await login('admin@empresacr.com', 'Temp@123456');
  const b = authed(bLogin.cookie);
  await master(`/platform/companies/${tenantB.company.id}/modules/receivables`, { method: 'PUT', body: { status: 'active' } });

  assert.equal((await b(`/receivables/${t.data.id}`)).status, 404);
  assert.equal((await b(`/receivables/${t.data.id}/receive`, { method: 'POST' })).status, 404);
  assert.equal((await b(`/receivables/${t.data.id}/cancel`, { method: 'POST', body: { reason: 'hack' } })).status, 404);
  const bList = await b('/receivables');
  assert.ok(bList.data.items.every((x) => x.description !== 'Título CR'), 'listagem de B isolada');
});

test('FUSO: hoje empresarial no timezone da empresa (Fortaleza + fuso extremo)', async () => {
  const summ = (await admin('/receivables/summary')).data;
  const fmt = (tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  const parts = fmt('America/Fortaleza');
  assert.equal(summ.business_today, `${parts.year}-${parts.month}-${parts.day}`);

  const settings = JSON.parse(db.prepare('SELECT settings FROM companies WHERE id = ?').get(anjosId).settings);
  settings.timezone = 'Pacific/Kiritimati';
  db.prepare('UPDATE companies SET settings = ? WHERE id = ?').run(JSON.stringify(settings), anjosId);
  const s2 = (await admin('/receivables/summary')).data;
  const p2 = fmt('Pacific/Kiritimati');
  assert.equal(s2.business_today, `${p2.year}-${p2.month}-${p2.day}`, 'hoje acompanha o fuso configurado');
  settings.timezone = 'America/Fortaleza';
  db.prepare('UPDATE companies SET settings = ? WHERE id = ?').run(JSON.stringify(settings), anjosId);
});

test('RELATÓRIO + FLUXO: por natureza/cliente/loja e cadeia venda→título→recebimento→relatório', async () => {
  const v = await sale(2);
  const t = await admin('/receivables', { method: 'POST', body: { description: 'Fluxo final', amount: '20,00', due_date: '2026-11-15', sale_id: v.data.id, customer_id: customer.id, store_id: storeId } });
  await admin(`/receivables/${t.data.id}/receive`, { method: 'POST' });

  const rep = await admin('/reports/receivables?from=2026-10-01&to=2026-10-31');
  assert.equal(rep.data.summary.received_count >= 1, true);
  assert.equal(rep.data.summary.open_count >= 1, true);
  assert.ok(rep.data.by_customer.some((c) => c.customer_name === 'Cliente CR' && c.received_cents >= 2000));
  assert.ok(rep.data.by_store.length >= 1, 'por loja presente');

  const audit = await master(`/platform/audit?company_id=${anjosId}&action=receivable`);
  const actions = new Set(audit.data.items.map((a) => a.action));
  assert.ok(actions.has('receivable.receive') && actions.has('receivable.create'));
});

// ==================== CONSOLIDAÇÃO V3.0 — integridade SALE ===================

test('INT-AMOUNT: título de venda com valor divergente é REJEITADO (400)', async () => {
  const v = await sale(2); // 2000 centavos
  const t = await admin('/receivables', { method: 'POST', body: { description: 'Valor errado', amount: '1.000,00', due_date: '2026-11-05', sale_id: v.data.id } });
  assert.equal(t.status, 400, 'valor divergente bloqueado');
  assert.ok((t.error.message || '').includes('20,00') || (t.error.message || '').includes('R$'), 'mensagem indica o valor correto');
});

test('INT-STORE/CUSTOMER: loja ou cliente divergente do da venda é REJEITADO (400)', async () => {
  const v = await sale(1);
  const stores2 = (await admin('/stores')).data.items;
  const otherStore = stores2.find((s) => s.id !== v.data.store_id);
  if (otherStore) {
    const t1 = await admin('/receivables', { method: 'POST', body: { description: 'Loja errada', due_date: '2026-11-05', sale_id: v.data.id, store_id: otherStore.id } });
    assert.equal(t1.status, 400, 'loja divergente bloqueada');
  }
  const c2 = (await admin('/customers', { method: 'POST', body: { name: 'Cliente Diverso' } })).data;
  const t2 = await admin('/receivables', { method: 'POST', body: { description: 'Cliente errado', due_date: '2026-11-05', sale_id: v.data.id, customer_id: c2.id } });
  assert.equal(t2.status, 400, 'cliente divergente bloqueado');
});

test('INT-PATCH: identidade do título SALE é imutável (cliente/loja/origem/status)', async () => {
  const v = await sale(1);
  const t = await admin('/receivables', { method: 'POST', body: { description: 'Imutável', due_date: '2026-11-05', sale_id: v.data.id } });
  assert.equal(t.status, 201);
  assert.equal((await admin(`/receivables/${t.data.id}`, { method: 'PATCH', body: { customer_id: null } })).status, 409);
  assert.equal((await admin(`/receivables/${t.data.id}`, { method: 'PATCH', body: { store_id: null } })).status, 409);
  assert.equal((await admin(`/receivables/${t.data.id}`, { method: 'PATCH', body: { status: 'paid' } })).status, 409);
  const okEdit = await admin(`/receivables/${t.data.id}`, { method: 'PATCH', body: { description: 'Só descrição', due_date: '2026-12-01' } });
  assert.equal(okEdit.status, 200, 'descrição e vencimento seguem editáveis');
});

test('INT-SALE-EDIT: venda com título não pode ter valor/cliente/loja alterados', async () => {
  const v = await sale(1);
  await admin('/receivables', { method: 'POST', body: { description: 'Trava venda', due_date: '2026-11-05', sale_id: v.data.id } });
  // venda com itens: amount/store já era bloqueado; customer/store explícito:
  const stores2 = (await admin('/stores')).data.items;
  const otherStore = stores2.find((s) => s.id !== v.data.store_id);
  if (otherStore) {
    assert.equal((await admin(`/sales/${v.data.id}`, { method: 'PATCH', body: { store_id: otherStore.id } })).status, 409, 'loja da venda travada');
  }
  const c2 = (await admin('/customers', { method: 'POST', body: { name: 'Cliente Trava' } })).data;
  assert.equal((await admin(`/sales/${v.data.id}`, { method: 'PATCH', body: { customer_id: c2.id } })).status, 409, 'cliente da venda travado');
  assert.equal((await admin(`/sales/${v.data.id}`, { method: 'PATCH', body: { note: 'ok' } })).status, 200, 'campos gerais seguem livres');
});

test('INT-GATING: módulo INATIVO — venda ainda cancela o título existente; recebido continua bloqueando', async () => {
  await admin('/stock/entry', { method: 'POST', body: { store_id: storeId, product_id: product.id, quantity: 20 } });
  const v = await sale(2);
  const t = await admin('/receivables', { method: 'POST', body: { description: 'Gating', due_date: '2026-11-05', sale_id: v.data.id } });
  await master(`/platform/companies/${anjosId}/modules/receivables`, { method: 'PUT', body: { status: 'inactive' } });

  // novo título bloqueado (gating)
  assert.equal((await admin('/receivables', { method: 'POST', body: { description: 'Xis gating', amount: '1,00', due_date: '2026-11-05' } })).status, 403);

  // cancelamento da venda mantém a consistência do título EXISTENTE
  const c = await admin(`/sales/${v.data.id}/cancel`, { method: 'POST', body: { reason: 'cancela com módulo off' } });
  assert.equal(c.status, 200, 'venda cancela normalmente');
  // API de recebíveis bloqueada enquanto off — reativa para conferir o estado
  await master(`/platform/companies/${anjosId}/modules/receivables`, { method: 'PUT', body: { status: 'active' } });
  assert.equal((await admin(`/receivables/${t.data.id}`)).data.status, 'canceled', 'título aberto cancelado junto');

  const audit = await master(`/platform/audit?company_id=${anjosId}&action=receivable.cancel&per_page=10`);
  assert.ok(audit.data.items.some((a) => a.entity_id === t.data.id && String(a.metadata || '').includes('consequência')), 'auditoria real do cancelamento');

  // recebido + módulo off: cancelamento da venda continua bloqueado (409)
  const v2 = await sale(1);
  const t2 = await admin('/receivables', { method: 'POST', body: { description: 'Pago off', due_date: '2026-11-05', sale_id: v2.data.id } });
  await admin(`/receivables/${t2.data.id}/receive`, { method: 'POST' });
  await master(`/platform/companies/${anjosId}/modules/receivables`, { method: 'PUT', body: { status: 'inactive' } });
  const blocked = await admin(`/sales/${v2.data.id}/cancel`, { method: 'POST', body: { reason: 'tentativa' } });
  assert.equal(blocked.status, 409, 'título recebido bloqueia mesmo com módulo off');
  assert.equal((await admin(`/sales/${v2.data.id}`)).data.status, 'active');
  await master(`/platform/companies/${anjosId}/modules/receivables`, { method: 'PUT', body: { status: 'active' } });
  assert.equal((await admin(`/receivables/${t2.data.id}`)).data.status, 'paid', 'título recebido intacto');
});

test('INT-REPORT: recebimento classificado no DIA EMPRESARIAL (summary = relatório) e gating do relatório', async () => {
  await admin('/stock/entry', { method: 'POST', body: { store_id: storeId, product_id: product.id, quantity: 10 } });
  const v = await sale(1);
  const t = await admin('/receivables', { method: 'POST', body: { description: 'Fuso recebimento', due_date: '2026-11-05', sale_id: v.data.id } });
  await admin(`/receivables/${t.data.id}/receive`, { method: 'POST' });

  const localToday = () => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Fortaleza', year: 'numeric', month: '2-digit', day: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date()).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const today = localToday();
  const rep = await admin(`/reports/receivables?date_field=received&from=${today}&to=${today}`);
  assert.equal(rep.data.summary.received_count >= 1, true, 'recebimento de hoje (local) presente no período de hoje');
  const summ = (await admin('/receivables/summary')).data;
  assert.equal(summ.received_month_cents, rep.data.summary.received_cents, 'summary e relatório usam a mesma regra de data');

  // gating do relatório: receivables OFF → 403 mesmo com reports ON
  await master(`/platform/companies/${anjosId}/modules/receivables`, { method: 'PUT', body: { status: 'inactive' } });
  const gated = await admin('/reports/receivables');
  assert.equal(gated.status, 403);
  assert.equal(gated.error.code, 'MODULE_INACTIVE');
  await master(`/platform/companies/${anjosId}/modules/receivables`, { method: 'PUT', body: { status: 'active' } });
});
