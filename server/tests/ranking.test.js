'use strict';

/**
 * Módulo RANKING (v1.4) — ranking agregado de vendedores/lojas derivado de
 * vendas + metas. Uma consulta GROUP BY por visão; canceladas excluídas.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
// helpers SEMPRE primeiro
const { login, authed, createTenant, shutdown, passwordFor } = require('./helpers');
const db = require('../src/database/connection');

let admin;
let master;
let anjosId;
let storeId;
let seller1;
let seller2;
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
  seller1 = users.find((u) => u.role_slug === 'seller');

  // Segundo vendedor para testar ordenação
  const s2 = await admin('/users', {
    method: 'POST',
    body: { name: 'Vendedor Dois', email: 'vendedor2@anjos.com', password: 'Dois@12345', role_slug: 'seller', store_id: storeId },
  });
  assert.equal(s2.status, 201);
  seller2 = s2.data;

  tenantB = await createTenant(master, 'EmpresaRank');
});

after(shutdown);

function addSale(amount, sellerId, soldAt = '2026-10-10', store = storeId) {
  return admin('/sales', {
    method: 'POST',
    body: { store_id: store, seller_id: sellerId, customer_name: 'Rank', amount, sold_at: soldAt },
  });
}

// ---------------------------------------------------------------------------
// Módulo, período e RBAC
// ---------------------------------------------------------------------------

test('módulo inativo bloqueia (MODULE_INACTIVE); reativação libera; período inválido → 400', async () => {
  await master(`/platform/companies/${anjosId}/modules/ranking`, { method: 'PUT', body: { status: 'active' } });
  assert.equal((await admin('/ranking')).status, 200);

  await master(`/platform/companies/${anjosId}/modules/ranking`, { method: 'PUT', body: { status: 'inactive' } });
  const blocked = await admin('/ranking');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.error.code, 'MODULE_INACTIVE');
  await master(`/platform/companies/${anjosId}/modules/ranking`, { method: 'PUT', body: { status: 'active' } });

  assert.equal((await admin('/ranking?from=2026-10-31&to=2026-10-01')).status, 400, 'período invertido');
  assert.equal((await admin('/ranking?from=invalida')).status, 400, 'data inválida');
});

test('RBAC: sem ranking.view não acessa; seller com a permissão acessa a empresa', async () => {
  const sellerRole = db.prepare(`SELECT id FROM roles WHERE slug = 'seller'`).get();
  const backup = db.prepare(`SELECT permission_code FROM role_permissions WHERE role_id = ? AND permission_code = 'ranking.view'`).all(sellerRole.id);
  db.prepare(`DELETE FROM role_permissions WHERE role_id = ? AND permission_code = 'ranking.view'`).run(sellerRole.id);
  try {
    const s = await login('vendedor@anjos.com.br', passwordFor('vendedor@anjos.com.br') || 'Anjos@2026');
    const denied = authed(s.cookie);
    assert.equal((await denied('/ranking')).status, 403);
  } finally {
    const restore = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_code) VALUES (?, ?)');
    for (const row of backup) restore.run(sellerRole.id, row.permission_code);
  }

  const s = await login('vendedor@anjos.com.br', passwordFor('vendedor@anjos.com.br') || 'Anjos@2026');
  const seller = authed(s.cookie);
  assert.equal((await seller('/ranking')).status, 200, 'seller com ranking.view acessa a própria empresa');
});

// ---------------------------------------------------------------------------
// Ranking de vendedores
// ---------------------------------------------------------------------------

test('ranking ordena por total, exclui canceladas e conta quantidade em centavos', async () => {
  const s1a = await addSale('30.000,00', seller1.id);
  const s1b = await addSale('20.000,00', seller1.id);
  const s1c = await addSale('5.000,00', seller1.id, '2026-10-12');
  await admin(`/sales/${s1c.data.id}/cancel`, { method: 'POST', body: { reason: 'cancelada não conta' } });
  await addSale('10.000,00', seller2.id);
  // Fora do período (novembro)
  await addSale('99.000,00', seller2.id, '2026-11-05');

  const r = await admin('/ranking?from=2026-10-01&to=2026-10-31');
  assert.equal(r.status, 200);
  const items = r.data.items;
  assert.ok(items.length >= 2);
  assert.equal(items[0].seller_id, seller1.id, 'maior vendedor primeiro');
  assert.equal(items[0].total_cents, 5000000, '30k+20k; cancelada excluída');
  assert.equal(items[0].sales_count, 2);
  assert.equal(items[0].position, 1);
  assert.equal(items[1].seller_id, seller2.id);
  assert.equal(items[1].total_cents, 1000000, 'só a venda de outubro; nov fora do período');
  assert.equal(items[1].gap_to_leader_cents, 4000000);
  assert.equal(r.data.summary.total_cents, 6000000);
  assert.equal(r.data.summary.sales_count, 3);
  assert.equal(r.data.summary.leader.name, seller1.name);
});

test('integração com metas: percentual quando há meta; null quando não há', async () => {
  const t1 = await admin('/targets', {
    method: 'POST',
    body: { type: 'seller', user_id: seller1.id, start_date: '2026-10-01', end_date: '2026-10-31', target_value: '100.000,00' },
  });
  assert.equal(t1.status, 201);

  const r = await admin('/ranking?from=2026-10-01&to=2026-10-31');
  const i1 = r.data.items.find((i) => i.seller_id === seller1.id);
  const i2 = r.data.items.find((i) => i.seller_id === seller2.id);
  assert.equal(i1.target_cents, 10000000);
  assert.equal(i1.percent, 50, '5.000.000 de 10.000.000 = 50%');
  assert.equal(i2.target_cents, null, 'sem meta → null (exibe —)');
  assert.equal(i2.percent, null);
});

test('filtro por loja restringe as vendas consideradas', async () => {
  const r = await admin(`/ranking?from=2026-10-01&to=2026-10-31&store_id=${storeId}`);
  assert.equal(r.status, 200);
  assert.ok(r.data.items.length >= 2);
  // outra loja da Anjos (sem vendas nestes testes) → todos zerados
  const stores = (await admin('/stores')).data.items;
  const other = stores.find((s) => s.id !== storeId);
  if (other) {
    const r2 = await admin(`/ranking?from=2026-10-01&to=2026-10-31&store_id=${other.id}`);
    assert.ok(r2.data.items.every((i) => i.total_cents === 0));
  }
});

// ---------------------------------------------------------------------------
// Ranking de lojas e dashboard
// ---------------------------------------------------------------------------

test('ranking de lojas: totais, quantidade e meta da loja', async () => {
  const t = await admin('/targets', {
    method: 'POST',
    body: { type: 'store', store_id: storeId, start_date: '2026-10-01', end_date: '2026-10-31', target_value: '1.000.000,00' },
  });
  assert.equal(t.status, 201);

  const r = await admin('/ranking/stores?from=2026-10-01&to=2026-10-31');
  assert.equal(r.status, 200);
  const lead = r.data.items[0];
  assert.equal(lead.store_id, storeId);
  assert.equal(lead.total_cents, 6000000);
  assert.equal(lead.target_cents, 100000000);
  assert.equal(lead.percent, 6);
  assert.equal(lead.position, 1);
});

test('dashboard: card Líder do mês quando o módulo está ativo', async () => {
  const dash = await admin('/dashboard/summary');
  const card = dash.data.cards.find((c) => c.key === 'ranking_leader');
  assert.ok(card, 'card ranking_leader presente');
  assert.equal(card.value, seller1.name);
});

// ---------------------------------------------------------------------------
// Isolamento e Master
// ---------------------------------------------------------------------------

test('Empresa B não enxerga ranking da Anjos; Master global e APIs de tenant restritas', async () => {
  await master(`/platform/companies/${tenantB.company.id}/modules/ranking`, { method: 'PUT', body: { status: 'active' } });
  const bLogin = await login('admin@empresarank.com', 'Temp@123456');
  const b = authed(bLogin.cookie);
  const rb = await b('/ranking?from=2026-10-01&to=2026-10-31');
  assert.equal(rb.status, 200);
  assert.ok(rb.data.items.every((i) => i.total_cents === 0), 'B não contém vendas da Anjos');
  assert.ok(rb.data.items.every((i) => i.seller_id !== seller1.id));

  const me = await master('/auth/me');
  assert.ok(me.data.permissions.includes('ranking.view'), 'Master possui ranking.view automaticamente');
  assert.equal((await master('/ranking')).status, 403, 'APIs de negócio são de tenants');
});

// ---------------------------------------------------------------------------
// V1.4.1 — correções finais do Ranking
// ---------------------------------------------------------------------------

test('V1.4.1: meta só é usada quando COBRE INTEGRALMENTE o período consultado', async () => {
  await addSale('10.000,00', seller2.id, '2026-11-10');

  // 1) meta exatamente igual ao período → usada (50% de 20k sobre 10k)
  const t1 = await admin('/targets', {
    method: 'POST',
    body: { type: 'seller', user_id: seller2.id, start_date: '2026-11-01', end_date: '2026-11-30', target_value: '20.000,00' },
  });
  assert.equal(t1.status, 201);
  let r = await admin('/ranking?from=2026-11-01&to=2026-11-30');
  let i2 = r.data.items.find((i) => i.seller_id === seller2.id);
  assert.equal(i2.target_cents, 2000000, 'meta exata é usada');
  // novembro do seller2: 10k (deste teste) + 99k (teste de ordenação) = 109k → 545%
  assert.equal(i2.percent, 545);

  // 2) meta MAIOR cobrindo o período → usada
  const t2 = await admin('/targets', {
    method: 'POST',
    body: { type: 'seller', user_id: seller1.id, start_date: '2026-09-01', end_date: '2026-12-31', target_value: '500.000,00' },
  });
  assert.equal(t2.status, 201);
  r = await admin('/ranking?from=2026-11-01&to=2026-11-30');
  let i1 = r.data.items.find((i) => i.seller_id === seller1.id);
  assert.equal(i1.target_cents, 50000000, 'meta maior cobrindo é usada');

  // 3) meta começando DEPOIS do início do ranking → NÃO usada
  r = await admin('/ranking?from=2026-10-15&to=2026-11-30');
  i2 = r.data.items.find((i) => i.seller_id === seller2.id);
  assert.equal(i2.target_cents, null, 'meta com início após o from não cobre');
  assert.equal(i2.percent, null);

  // 4) meta terminando ANTES do fim do ranking → NÃO usada
  const t3 = await admin('/targets', {
    method: 'POST',
    body: { type: 'seller', user_id: seller2.id, start_date: '2026-10-01', end_date: '2026-11-15', target_value: '5.000,00' },
  });
  assert.equal(t3.status, 201);
  r = await admin('/ranking?from=2026-10-01&to=2026-11-30');
  i2 = r.data.items.find((i) => i.seller_id === seller2.id);
  assert.equal(i2.target_cents, null, 'meta com fim antes do to não cobre');

  // 5) duas metas válidas → a MAIS ESPECÍFICA (menor duração) vence
  const t4 = await admin('/targets', {
    method: 'POST',
    body: { type: 'seller', user_id: seller1.id, start_date: '2026-11-01', end_date: '2026-11-30', target_value: '111.111,00' },
  });
  assert.equal(t4.status, 201);
  r = await admin('/ranking?from=2026-11-01&to=2026-11-30');
  i1 = r.data.items.find((i) => i.seller_id === seller1.id);
  assert.equal(i1.target_cents, 11111100, 'mais específica vence sobre a maior');

  // 6) período sem nenhuma meta → null ("—")
  r = await admin('/ranking?from=2026-08-01&to=2026-08-31');
  assert.ok(r.data.items.every((i) => i.target_cents === null && i.percent === null));

  // limpeza
  for (const t of [t1.data, t2.data, t3.data, t4.data]) {
    await admin(`/targets/${t.id}`, { method: 'DELETE' });
  }
});

test('V1.4.1: validação rigorosa de datas do período', async () => {
  assert.equal((await admin('/ranking?from=2026-02-31&to=2026-03-05')).status, 400, 'data inexistente');
  assert.equal((await admin('/ranking?from=2026-13-01&to=2026-13-02')).status, 400, 'mês inválido');
  assert.equal((await admin('/ranking?from=2026-00-10&to=2026-00-11')).status, 400, 'mês zero');
  assert.equal((await admin('/ranking?from=10/10/2026')).status, 400, 'formato inválido');
  assert.equal((await admin('/ranking?from=abc')).status, 400, 'texto livre');
  assert.equal((await admin('/ranking?from=2026-10-10&to=2026-10-01')).status, 400, 'from > to');
  assert.equal((await admin('/ranking?from=2026-10-01&to=2026-10-31')).status, 200, 'período válido');

  // período padrão (mês corrente) quando from/to ausentes
  const d = await admin('/ranking');
  assert.equal(d.status, 200);
  assert.match(d.data.from, /^\d{4}-\d{2}-01$/, 'período padrão inicia no dia 1');
  assert.ok(d.data.to >= d.data.from);
  // somente "from" espelha o "to"
  const only = await admin('/ranking?from=2026-10-10');
  assert.equal(only.status, 200);
  assert.equal(only.data.to, '2026-10-10');
});
