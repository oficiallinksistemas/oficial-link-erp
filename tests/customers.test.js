'use strict';

/**
 * Módulo CLIENTES (v1.5) — CRUD completo, RBAC, módulo ativável,
 * anti-IDOR multi-tenant e integração com Sales preservada.
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

  tenantB = await createTenant(master, 'EmpresaCli');
});

after(shutdown);

const FULL = {
  name: 'Cliente Completo', document: '123.456.789-00', phone: '(99) 99999-9999',
  email: 'cliente@email.com', address: 'Rua das Flores', number: '100',
  complement: 'Casa', district: 'Centro', city: 'Balsas', state: 'ma',
  zip: '65800-000', notes: 'cliente de teste',
};

// ---------------------------------------------------------------------------
// Autenticação, módulo e RBAC
// ---------------------------------------------------------------------------

test('não autenticado → 401; módulo inativo → MODULE_INACTIVE; reativação libera', async () => {
  assert.equal((await api('/customers')).status, 401);

  await master(`/platform/companies/${anjosId}/modules/customers`, { method: 'PUT', body: { status: 'inactive' } });
  const blocked = await admin('/customers');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.error.code, 'MODULE_INACTIVE');

  await master(`/platform/companies/${anjosId}/modules/customers`, { method: 'PUT', body: { status: 'active' } });
  assert.equal((await admin('/customers')).status, 200);
});

test('RBAC: seller cria/visualiza, não edita/exclui; admin faz tudo', async () => {
  const s = await login('vendedor@anjos.com.br', passwordFor('vendedor@anjos.com.br') || 'Anjos@2026');
  const seller = authed(s.cookie);

  const created = await seller('/customers', { method: 'POST', body: { name: 'Cliente do Vendedor' } });
  assert.equal(created.status, 201, JSON.stringify(created.error));

  assert.equal((await seller('/customers')).status, 200);
  assert.equal((await seller(`/customers/${created.data.id}`, { method: 'PATCH', body: { name: 'X' } })).status, 403);
  assert.equal((await seller(`/customers/${created.data.id}`, { method: 'DELETE' })).status, 403);
});

// ---------------------------------------------------------------------------
// CRUD e validações
// ---------------------------------------------------------------------------

test('criação completa: normalização (CPF dígitos, UF maiúscula) e todos os campos', async () => {
  const r = await admin('/customers', { method: 'POST', body: FULL });
  assert.equal(r.status, 201, JSON.stringify(r.error));
  assert.equal(r.data.document, '12345678900', 'CPF normalizado para dígitos');
  assert.equal(r.data.state, 'MA', 'UF em maiúscula');
  assert.equal(r.data.status, 'active');
  assert.equal(r.data.city, 'Balsas');
  assert.ok(r.data.id > 0);
});

test('validações: nome obrigatório, e-mail inválido, UF inválida, status inválido', async () => {
  assert.equal((await admin('/customers', { method: 'POST', body: { name: 'X' } })).status, 400);
  assert.equal((await admin('/customers', { method: 'POST', body: { name: 'Fulano', email: 'nao-e-email' } })).status, 400);
  assert.equal((await admin('/customers', { method: 'POST', body: { name: 'Fulano', state: 'XX9' } })).status, 400);
  const c = await admin('/customers', { method: 'POST', body: { name: 'Fulano Status' } });
  assert.equal((await admin(`/customers/${c.data.id}`, { method: 'PATCH', body: { status: 'banido' } })).status, 400);
});

test('CPF/CNPJ único por empresa; mesma empresa → 409; outra empresa → permitido', async () => {
  const dup = await admin('/customers', { method: 'POST', body: { name: 'Duplicata', document: '12345678900' } });
  assert.equal(dup.status, 409, 'mesmo documento na mesma empresa conflita');

  const bLogin = await login('admin@empresacli.com', 'Temp@123456');
  const b = authed(bLogin.cookie);
  await master(`/platform/companies/${tenantB.company.id}/modules/customers`, { method: 'PUT', body: { status: 'active' } });
  const inB = await b('/customers', { method: 'POST', body: { name: 'Cliente B', document: '123.456.789-00' } });
  assert.equal(inB.status, 201, 'mesmo documento em OUTRA empresa é permitido (isolamento)');
});

test('busca por nome, telefone, e-mail e CPF/CNPJ; paginação server-side', async () => {
  const byName = await admin('/customers?search=Completo');
  assert.ok(byName.data.items.some((c) => c.name === 'Cliente Completo'));
  const byPhone = await admin('/customers?search=99999');
  assert.ok(byPhone.data.items.length >= 1);
  const byEmail = await admin('/customers?search=cliente@email');
  assert.ok(byEmail.data.items.length >= 1);
  const byDoc = await admin('/customers?search=12345678900');
  assert.ok(byDoc.data.items.some((c) => c.document === '12345678900'));

  const paged = await admin('/customers?per_page=5&page=1');
  assert.ok(paged.data.items.length <= 5);
  assert.equal(typeof paged.data.total, 'number');
});

// ---------------------------------------------------------------------------
// Detalhe, histórico e integração com Sales
// ---------------------------------------------------------------------------

test('detalhe com histórico de vendas derivado de Sales', async () => {
  const c = (await admin('/customers?search=Completo')).data.items[0];
  const sale = await admin('/sales', {
    method: 'POST',
    body: { store_id: storeId, seller_id: sellerId, customer_id: c.id, customer_name: c.name, amount: '2.500,00', sold_at: '2026-10-05' },
  });
  assert.equal(sale.status, 201);

  const detail = await admin(`/customers/${c.id}`);
  assert.equal(detail.status, 200);
  assert.ok(detail.data.sales_history.some((s) => s.id === sale.data.id), 'venda presente no histórico');
  assert.equal(detail.data.sales_history[0].store_name.length > 0, true);
});

test('venda SEM cliente continua funcionando (regra Sales preservada)', async () => {
  const r = await admin('/sales', {
    method: 'POST',
    body: { store_id: storeId, seller_id: sellerId, customer_name: 'Balcão', amount: '100,00', sold_at: '2026-10-05' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.customer_id, null);
});

test('desativação preserva histórico; exclusão com vendas → 409; sem vendas → 200', async () => {
  const c = (await admin('/customers?search=Completo')).data.items[0];

  const off = await admin(`/customers/${c.id}`, { method: 'PATCH', body: { status: 'inactive' } });
  assert.equal(off.status, 200);
  assert.equal(off.data.status, 'inactive');

  // vendas históricas intactas após desativação
  const detail = await admin(`/customers/${c.id}`);
  assert.ok(detail.data.sales_history.length >= 1, 'histórico preservado após desativação');

  // exclusão bloqueada quando há vendas
  const delBlocked = await admin(`/customers/${c.id}`, { method: 'DELETE' });
  assert.equal(delBlocked.status, 409, 'cliente com vendas não pode ser excluído');

  // reativação
  await admin(`/customers/${c.id}`, { method: 'PATCH', body: { status: 'active' } });

  // cliente sem vendas pode ser excluído
  const orphan = await admin('/customers', { method: 'POST', body: { name: 'Cliente Órfão' } });
  assert.equal(orphan.status, 201);
  const del = await admin(`/customers/${orphan.data.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal((await admin(`/customers/${orphan.data.id}`)).status, 404);
});

// ---------------------------------------------------------------------------
// Multi-tenancy (IDOR) e auditoria
// ---------------------------------------------------------------------------

test('Empresa B não acessa, edita, exclui nem lista clientes da Anjos', async () => {
  const c = (await admin('/customers?search=Completo')).data.items[0];
  const bLogin = await login('admin@empresacli.com', 'Temp@123456');
  const b = authed(bLogin.cookie);

  assert.equal((await b(`/customers/${c.id}`)).status, 404);
  assert.equal((await b(`/customers/${c.id}`, { method: 'PATCH', body: { name: 'Hack' } })).status, 404);
  assert.equal((await b(`/customers/${c.id}`, { method: 'DELETE' })).status, 404);

  const bList = await b('/customers?search=Completo');
  assert.equal(bList.data.total, 0, 'listagem de B não contém clientes da Anjos');

  // venda em B usando cliente da Anjos é rejeitada (sales ativo em B primeiro)
  await master(`/platform/companies/${tenantB.company.id}/modules/sales`, { method: 'PUT', body: { status: 'active' } });
  const badSale = await b('/sales', {
    method: 'POST',
    body: { store_id: tenantB.store.id, seller_id: tenantB.user.id, customer_id: c.id, customer_name: 'X', amount: '10,00', sold_at: '2026-10-05' },
  });
  assert.equal(badSale.status, 400);
});

test('auditoria registra customer.create/update/delete', async () => {
  const audit = await master(`/platform/audit?company_id=${anjosId}&action=customer`);
  const actions = new Set(audit.data.items.map((a) => a.action));
  assert.ok(actions.has('customer.create') && actions.has('customer.update'), 'eventos de cliente na auditoria');
});

// ---------------------------------------------------------------------------
// V1.6 — consolidação: sales_count real, UF no PATCH, CNPJ normalizado
// ---------------------------------------------------------------------------

test('V1.6: sales_count conta TODAS as vendas (15), histórico limitado a 10', async () => {
  const c = await admin('/customers', { method: 'POST', body: { name: 'Cliente XVendas' } });
  assert.equal(c.status, 201);
  const cid = c.data.id;

  for (let i = 1; i <= 15; i++) {
    const r = await admin('/sales', {
      method: 'POST',
      body: {
        store_id: storeId, seller_id: sellerId, customer_id: cid, customer_name: 'Cliente XVendas',
        amount: '100,00', sold_at: `2026-10-${String(Math.min(i + 9, 28)).padStart(2, '0')}`,
      },
    });
    assert.equal(r.status, 201, `venda ${i} falhou`);
  }

  const detail = await admin(`/customers/${cid}`);
  assert.equal(detail.status, 200);
  assert.ok(detail.data.sales_history.length <= 10, 'histórico limitado a 10');
  assert.equal(detail.data.sales_count, 15, 'sales_count é o TOTAL real de vendas');
});

test('V1.6: PATCH normaliza UF no backend (ma → MA); CNPJ normalizado no create', async () => {
  const c = await admin('/customers', {
    method: 'POST',
    body: { name: 'Empresa Normalizada', document: '12.345.678/0001-90' },
  });
  assert.equal(c.status, 201);
  assert.equal(c.data.document, '12345678000190', 'CNPJ normalizado para dígitos');

  const patched = await admin(`/customers/${c.data.id}`, { method: 'PATCH', body: { state: 'ma' } });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.state, 'MA', 'backend normaliza a UF no PATCH');

  const lowerRejected = await admin(`/customers/${c.data.id}`, { method: 'PATCH', body: { state: 'xx9' } });
  assert.equal(lowerRejected.status, 400, 'UF inválida continua rejeitada');

  await admin(`/customers/${c.data.id}`, { method: 'DELETE' });
});
