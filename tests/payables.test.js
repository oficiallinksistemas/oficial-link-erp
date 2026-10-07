'use strict';

/**
 * Contas a Pagar (v2.0) — CRUD, pagamento idempotente e concorrente, status,
 * integração Purchases → Payables, relatórios, gating, RBAC e IDOR.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
// helpers SEMPRE primeiro
const { api, login, authed, createTenant, shutdown, passwordFor } = require('./helpers');

let admin; let master; let anjosId; let storeId; let sellerId; let tenantB; let supplier; let product;

before(async () => {
  const m = await login('master@oficiallink.com.br', 'Master@2026');
  master = authed(m.cookie);
  anjosId = (await master('/platform/companies?search=Anjos')).data.items[0].id;
  const a = await login('admin@anjos.com.br', 'Anjos@2026');
  admin = authed(a.cookie);
  storeId = (await admin('/stores')).data.items[0].id;
  sellerId = (await admin('/users?per_page=50')).data.items.find((u) => u.role_slug === 'seller').id;
  supplier = (await admin('/suppliers', { method: 'POST', body: { name: 'Fornecedor CP' } })).data;
  product = (await admin('/products', { method: 'POST', body: { name: 'Prod CP', sku: 'CP-1', price: '10,00' } })).data;
  tenantB = await createTenant(master, 'EmpresaCP');
});

after(shutdown);

const newTitle = (extra = {}) => admin('/payables', {
  method: 'POST',
  body: { description: 'Título de teste', amount: '1.234,56', due_date: '2026-10-20', supplier_id: supplier.id, store_id: storeId, ...extra },
});

// ------------------------------- CRUD --------------------------------------

test('CRUD: criar (centavos exatos), editar em aberto, validações', async () => {
  const t = await newTitle();
  assert.equal(t.status, 201, JSON.stringify(t.error));
  assert.equal(t.data.amount_cents, 123456, 'R$ 1.234,56 = 123456 centavos');
  assert.equal(t.data.status, 'open');
  assert.equal(t.data.effective_status, 'open');

  assert.equal((await admin('/payables', { method: 'POST', body: { description: 'X', amount: '0,01', due_date: 'bad' } })).status, 400);
  assert.equal((await admin('/payables', { method: 'POST', body: { description: 'X', amount: '0,00', due_date: '2026-10-20' } })).status, 400);
  assert.equal((await admin('/payables', { method: 'POST', body: { description: 'X', amount: '10,00', due_date: '2026-10-20', supplier_id: 99999 } })).status, 400);

  // menor valor possível
  const tiny = await admin('/payables', { method: 'POST', body: { description: 'Centavo', amount: '0,01', due_date: '2026-10-20' } });
  assert.equal(tiny.status, 201);
  assert.equal(tiny.data.amount_cents, 1);

  const edited = await admin(`/payables/${t.data.id}`, { method: 'PATCH', body: { description: 'Editado', due_date: '2026-11-30' } });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.description, 'Editado');
});

test('OVERDUE é derivado: open + vencimento passado', async () => {
  const t = await newTitle({ due_date: '2020-01-01' });
  assert.equal(t.data.effective_status, 'overdue');
  const list = await admin('/payables?status=overdue');
  assert.ok(list.data.items.some((x) => x.id === t.data.id), 'filtro overdue funciona');
  const all = await admin('/payables?status=open');
  assert.ok(all.data.items.some((x) => x.id === t.data.id && x.effective_status === 'overdue'));
});

// ------------------------------ PAGAMENTO -----------------------------------

test('PAGAMENTO: paga, duplo → 409, cancelado → 409, pago não cancela nem edita', async () => {
  const t = await newTitle();
  const paid = await admin(`/payables/${t.data.id}/pay`, { method: 'POST' });
  assert.equal(paid.status, 200);
  assert.equal(paid.data.status, 'paid');
  assert.equal(paid.data.paid_amount_cents, t.data.amount_cents, 'pagamento integral');

  const again = await admin(`/payables/${t.data.id}/pay`, { method: 'POST' });
  assert.equal(again.status, 409, 'segundo pagamento rejeitado');
  assert.equal((await admin(`/payables/${t.data.id}/cancel`, { method: 'POST', body: { reason: 'não pode' } })).status, 409, 'pago não cancela');
  assert.equal((await admin(`/payables/${t.data.id}`, { method: 'PATCH', body: { description: 'X' } })).status, 409, 'pago não edita');

  const c = await newTitle();
  await admin(`/payables/${c.data.id}/cancel`, { method: 'POST', body: { reason: 'desistência' } });
  assert.equal((await admin(`/payables/${c.data.id}/pay`, { method: 'POST' })).status, 409, 'cancelado não paga');
});

test('CONCORRÊNCIA: dois pagamentos simultâneos → exatamente um vence', async () => {
  const t = await newTitle();
  const [r1, r2] = await Promise.all([
    admin(`/payables/${t.data.id}/pay`, { method: 'POST' }),
    admin(`/payables/${t.data.id}/pay`, { method: 'POST' }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 409], 'um pagamento aceito, outro rejeitado');
  const detail = await admin(`/payables/${t.data.id}`);
  assert.equal(detail.data.status, 'paid');
  assert.equal(detail.data.paid_amount_cents, t.data.amount_cents, 'valor único, sem duplicação');
});

// --------------------- INTEGRAÇÃO COMPRAS → TÍTULO ---------------------------

test('INTEGRAÇÃO: compra recebida gera exatamente UM título (idempotente)', async () => {
  const compra = await admin('/purchases', {
    method: 'POST',
    body: { supplier_id: supplier.id, store_id: storeId, purchase_date: '2026-10-05', items: [{ product_id: product.id, quantity: 5, unit_cost: '100,00' }] },
  });
  assert.equal(compra.status, 201);
  await admin(`/purchases/${compra.data.id}/receive`, { method: 'POST' });

  const byPurchase = await admin(`/payables?purchase_id=${compra.data.id}`);
  assert.equal(byPurchase.data.total, 1, 'uma compra = um título');
  const title = byPurchase.data.items[0];
  assert.equal(title.amount_cents, 50000, 'valor = total da compra');
  assert.equal(title.origin_type, 'purchase');
  assert.equal(title.supplier_id, supplier.id);

  // duplo recebimento já era 409; conferir que não nasceu segundo título
  assert.equal((await admin(`/purchases/${compra.data.id}/receive`, { method: 'POST' })).status, 409);
  assert.equal((await admin(`/payables?purchase_id=${compra.data.id}`)).data.total, 1);

  // título de compra não pode ser excluído — apenas cancelado
  assert.equal((await admin(`/payables/${title.id}`, { method: 'DELETE' })).status, 409);
  // paga integral e reflete no relatório
  await admin(`/payables/${title.id}/pay`, { method: 'POST' });
  const rep = await admin('/reports/payables?from=2026-10-01&to=2026-10-31');
  assert.equal(rep.data.summary.paid_count >= 1, true);
  assert.equal(rep.data.summary.open_count >= 0, true);
});

test('módulo payables inativo: compra recebe normal, SEM gerar título', async () => {
  await master(`/platform/companies/${anjosId}/modules/payables`, { method: 'PUT', body: { status: 'inactive' } });
  const compra = await admin('/purchases', {
    method: 'POST',
    body: { supplier_id: supplier.id, store_id: storeId, purchase_date: '2026-10-06', items: [{ product_id: product.id, quantity: 1, unit_cost: '1,00' }] },
  });
  await admin(`/purchases/${compra.data.id}/receive`, { method: 'POST' });
  const titles = await admin(`/payables?purchase_id=${compra.data.id}`);
  assert.equal(titles.status, 403, 'API de payables bloqueada');
  await master(`/platform/companies/${anjosId}/modules/payables`, { method: 'PUT', body: { status: 'active' } });
});

// ------------------------- GATING / RBAC / IDOR ------------------------------

test('module gating e RBAC: seller sem acesso; supervisor com acesso', async () => {
  assert.equal((await api('/payables')).status, 401);
  const s = await login('vendedor@anjos.com.br', passwordFor('vendedor@anjos.com.br') || 'Anjos@2026');
  const seller = authed(s.cookie);
  assert.equal((await seller('/payables')).status, 403);
  assert.equal((await seller('/payables', { method: 'POST', body: {} })).status, 403);

  const sup = await login('supervisor@anjos.com.br', passwordFor('supervisor@anjos.com.br') || 'Anjos@2026');
  const supervisor = authed(sup.cookie);
  assert.equal((await supervisor('/payables')).status, 200, 'supervisor visualiza');
  const created = await supervisor('/payables', { method: 'POST', body: { description: 'Sup title', amount: '50,00', due_date: '2026-12-01' } });
  assert.equal(created.status, 201, 'supervisor lança');
});

test('IDOR: Empresa B não acessa, paga, cancela nem lista títulos da Anjos', async () => {
  const t = await newTitle();
  const bLogin = await login('admin@empresacp.com', 'Temp@123456');
  const b = authed(bLogin.cookie);
  await master(`/platform/companies/${tenantB.company.id}/modules/payables`, { method: 'PUT', body: { status: 'active' } });

  assert.equal((await b(`/payables/${t.data.id}`)).status, 404);
  assert.equal((await b(`/payables/${t.data.id}`, { method: 'PATCH', body: { description: 'Hack' } })).status, 404);
  assert.equal((await b(`/payables/${t.data.id}/pay`, { method: 'POST' })).status, 404);
  assert.equal((await b(`/payables/${t.data.id}/cancel`, { method: 'POST', body: { reason: 'hack' } })).status, 404);
  const bList = await b('/payables');
  assert.ok(bList.data.items.every((x) => x.description !== 'Título de teste'), 'listagem de B isolada');
  assert.equal((await b('/reports/payables')).status, 403, 'relatório exige reports.view');
});

// ------------- CONSOLIDAÇÃO v2.0.1: cancelamento compra × título -------------

test('CANCEL-INTEG: compra recebida com título ABERTO → cancelar compra cancela título e estorna estoque (mesma transação)', async () => {
  const prod2 = (await admin('/products', { method: 'POST', body: { name: 'Prod CP2', sku: 'CP-2', price: '10,00' } })).data;
  const compra = await admin('/purchases', {
    method: 'POST',
    body: { supplier_id: supplier.id, store_id: storeId, purchase_date: '2026-10-08', items: [{ product_id: prod2.id, quantity: 6, unit_cost: '50,00' }] },
  });
  await admin(`/purchases/${compra.data.id}/receive`, { method: 'POST' });
  const balBefore = (await admin(`/stock?store_id=${storeId}&search=CP-2`)).data.items[0].quantity;
  assert.equal(balBefore, 6);
  const title = (await admin(`/payables?purchase_id=${compra.data.id}`)).data.items[0];
  assert.equal(title.status, 'open');

  const canceled = await admin(`/purchases/${compra.data.id}/cancel`, { method: 'POST', body: { reason: 'devolução total' } });
  assert.equal(canceled.status, 200);

  const afterTitle = await admin(`/payables/${title.id}`);
  assert.equal(afterTitle.data.status, 'canceled', 'título cancelado junto');
  assert.equal(afterTitle.data.updated_by !== null, true, 'updated_by registrado');
  const balAfter = (await admin(`/stock?store_id=${storeId}&search=CP-2`)).data.items[0].quantity;
  assert.equal(balAfter, 0, 'estoque estornado na mesma operação');

  const audit = await master(`/platform/audit?company_id=${anjosId}&action=payable.cancel`);
  assert.ok(
    audit.data.items.some((a) => a.entity_id === title.id && String(a.metadata || '').includes('consequência')),
    'auditoria do título indica cancelamento em consequência da compra'
  );

  // duplo cancelamento da compra → 409 e nada muda
  assert.equal((await admin(`/purchases/${compra.data.id}/cancel`, { method: 'POST', body: { reason: 'de novo' } })).status, 409);
  assert.equal((await admin(`/payables/${title.id}`)).data.status, 'canceled');
});

test('CANCEL-BLOQ: compra com título PAGO → cancelamento bloqueado (409), nada alterado', async () => {
  const compra = await admin('/purchases', {
    method: 'POST',
    body: { supplier_id: supplier.id, store_id: storeId, purchase_date: '2026-10-08', items: [{ product_id: product.id, quantity: 2, unit_cost: '10,00' }] },
  });
  await admin(`/purchases/${compra.data.id}/receive`, { method: 'POST' });
  const title = (await admin(`/payables?purchase_id=${compra.data.id}`)).data.items[0];
  await admin(`/payables/${title.id}/pay`, { method: 'POST' });
  const balBefore = (await admin(`/stock?store_id=${storeId}&search=CP-1`)).data.items[0].quantity;

  const r = await admin(`/purchases/${compra.data.id}/cancel`, { method: 'POST', body: { reason: 'tentativa com título pago' } });
  assert.equal(r.status, 409);
  assert.ok(/pago/i.test(r.error.message));

  assert.equal((await admin(`/purchases/${compra.data.id}`)).data.status, 'received', 'compra intacta');
  assert.equal((await admin(`/payables/${title.id}`)).data.status, 'paid', 'título intacto');
  assert.equal((await admin(`/stock?store_id=${storeId}&search=CP-1`)).data.items[0].quantity, balBefore, 'sem estorno parcial');
});

test('CANCEL-ROLLBACK: estorno impossível (estoque vendido) → cancelamento FALHA e NADA persiste', async () => {
  const prod3 = (await admin('/products', { method: 'POST', body: { name: 'Prod CP3', sku: 'CP-3', price: '10,00' } })).data;
  const compra = await admin('/purchases', {
    method: 'POST',
    body: { supplier_id: supplier.id, store_id: storeId, purchase_date: '2026-10-08', items: [{ product_id: prod3.id, quantity: 3, unit_cost: '10,00' }] },
  });
  await admin(`/purchases/${compra.data.id}/receive`, { method: 'POST' });
  // vende TUDO: estorno do cancelamento ficará impossível (saída > saldo)
  const seller = (await admin('/users?per_page=50')).data.items.find((u) => u.role_slug === 'seller');
  await admin('/sales', { method: 'POST', body: { store_id: storeId, seller_id: seller.id, customer_name: 'Venda Rollback', sold_at: '2026-10-08', items: [{ product_id: prod3.id, quantity: 3 }] } });

  const title = (await admin(`/payables?purchase_id=${compra.data.id}`)).data.items[0];
  const r = await admin(`/purchases/${compra.data.id}/cancel`, { method: 'POST', body: { reason: 'rollback forçado' } });
  assert.equal(r.status, 409, 'estorno de estoque impossível falha a operação inteira');
  assert.equal((await admin(`/purchases/${compra.data.id}`)).data.status, 'received', 'compra NÃO cancelada');
  assert.equal((await admin(`/payables/${title.id}`)).data.status, 'open', 'título NÃO cancelado');
});

test('DATAS: hoje/vencido pelo FUSO da empresa (America/Fortaleza e outro fuso extremo)', async () => {
  const summary = (await admin('/payables/summary')).data;
  assert.equal(summary.business_today, businessDate('America/Fortaleza'), 'hoje = fuso da empresa (Fortaleza)');

  // troca o fuso da empresa para um extremo (UTC+14) e confere o business_today
  const db = require('../src/database/connection');
  const settings = JSON.parse(db.prepare('SELECT settings FROM companies WHERE id = ?').get(anjosId).settings);
  settings.timezone = 'Pacific/Kiritimati';
  db.prepare('UPDATE companies SET settings = ? WHERE id = ?').run(JSON.stringify(settings), anjosId);
  const s2 = (await admin('/payables/summary')).data;
  assert.equal(s2.business_today, businessDate('Pacific/Kiritimati'), 'hoje acompanha o fuso configurado');
  settings.timezone = 'America/Fortaleza';
  db.prepare('UPDATE companies SET settings = ? WHERE id = ?').run(JSON.stringify(settings), anjosId);

  function businessDate(tz) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }
});

test('DELETE-RBAC: payables.delete é permissão própria (supervisor lança mas não exclui; admin exclui manual aberto)', async () => {
  const supLogin = await login('supervisor@anjos.com.br', passwordFor('supervisor@anjos.com.br') || 'Anjos@2026');
  const supervisor = authed(supLogin.cookie);
  const t = await supervisor('/payables', { method: 'POST', body: { description: 'Excluível pelo admin', amount: '10,00', due_date: '2026-12-01' } });
  assert.equal(t.status, 201, 'supervisor (create) lança');
  assert.equal((await supervisor(`/payables/${t.data.id}`, { method: 'DELETE' })).status, 403, 'supervisor SEM delete');

  const del = await admin(`/payables/${t.data.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200, 'admin (delete) exclui manual em aberto');

  // título de compra nunca é delete — nem para admin
  const compra = await admin('/purchases', {
    method: 'POST',
    body: { supplier_id: supplier.id, store_id: storeId, purchase_date: '2026-10-09', items: [{ product_id: product.id, quantity: 1, unit_cost: '5,00' }] },
  });
  await admin(`/purchases/${compra.data.id}/receive`, { method: 'POST' });
  const tp = (await admin(`/payables?purchase_id=${compra.data.id}`)).data.items[0];
  assert.equal((await admin(`/payables/${tp.id}`, { method: 'DELETE' })).status, 409, 'título de compra nunca é delete');
});

// ------------------------- FLUXO COMPLETO + AUDITORIA ------------------------

test('FLUXO: fornecedor → compra → receber → estoque → título → pagar → relatório → auditoria', async () => {
  const compra = await admin('/purchases', {
    method: 'POST',
    body: { supplier_id: supplier.id, store_id: storeId, purchase_date: '2026-10-07', items: [{ product_id: product.id, quantity: 3, unit_cost: '200,00' }] },
  });
  await admin(`/purchases/${compra.data.id}/receive`, { method: 'POST' });

  const bal = (await admin(`/stock?store_id=${storeId}&search=CP-1`)).data.items[0].quantity;
  assert.ok(bal >= 9, 'estoque correto ao longo do fluxo');

  const title = (await admin(`/payables?purchase_id=${compra.data.id}`)).data.items[0];
  const paid = await admin(`/payables/${title.id}/pay`, { method: 'POST' });
  assert.equal(paid.status, 200);
  assert.equal(paid.data.paid_amount_cents, 60000);

  const rep = await admin('/reports/payables?from=2026-10-01&to=2026-10-31');
  assert.equal(rep.data.summary.paid_count >= 1, true);
  assert.ok(rep.data.by_supplier.some((s) => s.supplier_name === 'Fornecedor CP' && s.paid_cents >= 60000));

  const audit = await master(`/platform/audit?company_id=${anjosId}&action=payable`);
  const actions = new Set(audit.data.items.map((a) => a.action));
  assert.ok(actions.has('payable.create') && actions.has('payable.pay'), 'auditoria de criação e pagamento');
});
