'use strict';

/**
 * V3.3 — SaaS Comercial V1 (platform.billing).
 *
 * Cobre: segurança (tenant jamais acessa; Master com autoridade global),
 * configuração comercial, cobranças (criar/editar/cancelar/overdue),
 * pagamentos (transacional, idempotente, integral), comprovantes (magic
 * bytes, acesso), histórico, dashboard agregado, auditoria e centavos.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
// helpers SEMPRE primeiro
const { login, authed, createTenant, boot, shutdown } = require('./helpers');
const db = require('../src/database/connection');
const { businessToday } = require('../src/core/businessDate');

let master; let admin; let seller; let anjosId; let tenantAdmin;
let tenantCompanyId;

const PNG_DATA_URL = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString('base64')}`;
const FAKE_DATA_URL = 'data:image/png;base64,aGVsbG8gd29ybGQ='; // "hello world" sem assinatura PNG

before(async () => {
  const m = await login('master@oficiallink.com.br', 'Master@2026');
  master = authed(m.cookie);
  anjosId = (await master('/platform/companies?search=Anjos')).data.items[0].id;
  const a = await login('admin@anjos.com.br', 'Anjos@2026');
  admin = authed(a.cookie);
  const s = await login('vendedor@anjos.com.br', 'Anjos@2026');
  seller = authed(s.cookie);
  // Tenant isolado para provar isolamento comercial (createTenant já
  // desempacota o envelope {ok,data} — retorna {company, store, user})
  const t = await createTenant(master, 'BillingTeste');
  tenantCompanyId = t.company.id;
  const tLogin = await login(t.user.email, 'Temp@123456');
  tenantAdmin = authed(tLogin.cookie);
});

after(shutdown);

// ---------------------------------------------------------------------------
// Segurança e isolamento
// ---------------------------------------------------------------------------
test('segurança: admin tenant NÃO acessa billing (403)', async () => {
  const r = await admin('/platform/billing/overview');
  assert.equal(r.status, 403);
});

test('segurança: vendedor NÃO acessa billing (403)', async () => {
  const r = await seller('/platform/billing/overview');
  assert.equal(r.status, 403);
});

test('segurança: admin de OUTRO tenant não lista empresas comerciais (403)', async () => {
  const r = await tenantAdmin('/platform/billing/companies');
  assert.equal(r.status, 403);
});

test('segurança: mutações de billing exigem Master mesmo com Origin válido', async () => {
  const r = await admin('/platform/billing/charges', {
    method: 'POST', body: { company_id: anjosId, type: 'monthly', amount: '10', due_date: '2026-12-01' },
  });
  assert.equal(r.status, 403);
});

// ---------------------------------------------------------------------------
// Configuração comercial
// ---------------------------------------------------------------------------
test('config: Master cria/atualiza config comercial (centavos)', async () => {
  const r = await master(`/platform/billing/companies/${anjosId}/config`, {
    method: 'PUT',
    body: {
      implementation_fee: '1.500,00', monthly_fee: '299,90', billing_due_day: 10,
      payment_method: 'pix', billing_notes: 'Contrato anual', next_due_date: '2026-11-10',
    },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.implementation_fee_cents, 150000);
  assert.equal(r.data.monthly_fee_cents, 29990);
  assert.equal(r.data.billing_due_day, 10);
});

test('config: validações (dia 29, valor negativo, método inválido, data ruim)', async () => {
  for (const body of [
    { billing_due_day: 29 },
    { monthly_fee: '-10' },
    { payment_method: 'cripto' },
    { next_due_date: '2026-13-40' },
  ]) {
    const r = await master(`/platform/billing/companies/${anjosId}/config`, { method: 'PUT', body });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
});

test('config: empresa inexistente → 404', async () => {
  const r = await master('/platform/billing/companies/999999/config', {
    method: 'PUT', body: { monthly_fee: '100' },
  });
  assert.equal(r.status, 404);
});

// ---------------------------------------------------------------------------
// Cobranças
// ---------------------------------------------------------------------------
let implCharge; let monthlyCharge; let overdueCharge; let canceledCharge; let paidCharge; let receiptPaymentId;

test('cobranças: criar implantação e mensalidade', async () => {
  implCharge = (await master('/platform/billing/charges', {
    method: 'POST',
    // parseAmountCents: sem vírgula, ponto é decimal ('1.500' = R$1,50);
    // use '1500' ou '1.500,00' para R$1.500,00.
    body: { company_id: anjosId, type: 'implementation', amount: '1500', due_date: await businessToday(anjosId), reference: 'Implantação' },
  })).data;
  monthlyCharge = (await master('/platform/billing/charges', {
    method: 'POST',
    body: { company_id: anjosId, type: 'monthly', amount: '299,90', due_date: '2026-11-10', reference: '2026-11' },
  })).data;
  assert.equal(implCharge.amount_cents, 150000);
  assert.equal(monthlyCharge.amount_cents, 29990);
});

test('cobranças: validações (valor zero, data inválida, tipo inválido, empresa inexistente)', async () => {
  const bad = [
    { company_id: anjosId, type: 'monthly', amount: '0', due_date: '2026-12-01' },
    { company_id: anjosId, type: 'monthly', amount: '10', due_date: 'ontem' },
    { company_id: anjosId, type: 'magic', amount: '10', due_date: '2026-12-01' },
    { company_id: 999999, type: 'monthly', amount: '10', due_date: '2026-12-01' },
  ];
  for (const body of bad) {
    const r = await master('/platform/billing/charges', { method: 'POST', body });
    assert.ok([400, 404].includes(r.status), JSON.stringify(body));
  }
});

test('cobranças: vencida vira OVERDUE pela data de negócio da empresa', async () => {
  const todayStr = await businessToday(anjosId);
  const [y, mo, d] = todayStr.split('-').map(Number);
  const yesterday = new Date(Date.UTC(y, mo - 1, d - 1)).toISOString().slice(0, 10);
  overdueCharge = (await master('/platform/billing/charges', {
    method: 'POST',
    body: { company_id: anjosId, type: 'monthly', amount: '199', due_date: yesterday, reference: '2026-09' },
  })).data;
  const r = await master('/platform/billing/charges?status=OVERDUE');
  assert.equal(r.status, 200);
  assert.ok(r.data.items.some((c) => c.id === overdueCharge.id && c.status === 'OVERDUE'));
});

test('cobranças: editar aberta altera valor; editar paga/cancelada é bloqueado', async () => {
  canceledCharge = (await master('/platform/billing/charges', {
    method: 'POST',
    body: { company_id: anjosId, type: 'custom', amount: '50', due_date: '2026-12-01' },
  })).data;
  const e1 = await master(`/platform/billing/charges/${canceledCharge.id}`, {
    method: 'PUT', body: { amount: '75,50' },
  });
  assert.equal(e1.status, 200);
  assert.equal(e1.data.amount_cents, 7550);
  const cx = await master(`/platform/billing/charges/${canceledCharge.id}/cancel`, {
    method: 'POST', body: { notes: 'Cobrança equivocada' },
  });
  assert.equal(cx.status, 200);
  assert.equal(cx.data.status, 'CANCELED');
  const e2 = await master(`/platform/billing/charges/${canceledCharge.id}`, {
    method: 'PUT', body: { amount: '100' },
  });
  assert.equal(e2.status, 409);
  const cx2 = await master(`/platform/billing/charges/${canceledCharge.id}/cancel`, { method: 'POST', body: {} });
  assert.equal(cx2.status, 409);
});

// ---------------------------------------------------------------------------
// Pagamentos (transacional, idempotente, integral)
// ---------------------------------------------------------------------------
test('pagamento: registrar com comprovante valida magic bytes e persiste histórico', async () => {
  const r = await master(`/platform/billing/charges/${implCharge.id}/pay`, {
    method: 'POST',
    body: {
      amount: '1.500,00', paid_on: await businessToday(anjosId), method: 'pix',
      notes: 'Comprovante via Pix', receipt: PNG_DATA_URL,
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.error));
  assert.equal(r.data.charge.status, 'PAID');
  assert.equal(r.data.payment.amount_cents, 150000);
  receiptPaymentId = r.data.payment.id;
  assert.ok(receiptPaymentId);

  // histórico responde: quanto/quando/método/quem
  const hist = await master(`/platform/billing/payments?charge_id=${implCharge.id}`);
  assert.equal(hist.status, 200);
  assert.equal(hist.data.total, 1);
  assert.equal(hist.data.items[0].created_by_name.length > 0, true);
});

test('pagamento: comprovante com conteúdo falso é rejeitado (400)', async () => {
  const c = (await master('/platform/billing/charges', {
    method: 'POST',
    body: { company_id: anjosId, type: 'custom', amount: '10', due_date: '2026-12-15' },
  })).data;
  const r = await master(`/platform/billing/charges/${c.id}/pay`, {
    method: 'POST',
    body: { amount: '10', paid_on: await businessToday(anjosId), method: 'dinheiro', receipt: FAKE_DATA_URL },
  });
  assert.equal(r.status, 400);
  assert.match(r.error.message, /comprovante/i);
  // cobrança continua aberta (transação não deixou lixo)
  const still = await master(`/platform/billing/charges?status=OPEN`);
  assert.ok(still.data.items.some((x) => x.id === c.id));
});

test('pagamento: valor divergente é rejeitado (V1 integral)', async () => {
  const r = await master(`/platform/billing/charges/${monthlyCharge.id}/pay`, {
    method: 'POST',
    body: { amount: '200,00', paid_on: await businessToday(anjosId), method: 'pix' },
  });
  assert.equal(r.status, 400);
  assert.equal(r.error.code, 'VALIDATION_ERROR'); // badRequest() → VALIDATION_ERROR
});

test('pagamento: duplo pagamento é idempotente-safe (409) e não cria 2º histórico', async () => {
  const body = { amount: '299,90', paid_on: await businessToday(anjosId), method: 'transferencia' };
  const r1 = await master(`/platform/billing/charges/${monthlyCharge.id}/pay`, { method: 'POST', body });
  assert.equal(r1.status, 200);
  const r2 = await master(`/platform/billing/charges/${monthlyCharge.id}/pay`, { method: 'POST', body });
  assert.equal(r2.status, 409);
  const hist = await master(`/platform/billing/payments?charge_id=${monthlyCharge.id}`);
  assert.equal(hist.data.total, 1);
});

test('pagamento: cobrança cancelada não pode ser paga (409)', async () => {
  const r = await master(`/platform/billing/charges/${canceledCharge.id}/pay`, {
    method: 'POST',
    body: { amount: '75,50', paid_on: await businessToday(anjosId), method: 'pix' },
  });
  assert.equal(r.status, 409);
});

test('comprovante: Master baixa o PNG do pagamento; inexistente → 404', async () => {
  const url = await base();
  const res = await fetch(`${url}/api/platform/billing/payments/${receiptPaymentId}/receipt`, {
    headers: { Cookie: masterCookieHeader() },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /image\/png/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const res404 = await fetch(`${url}/api/platform/billing/payments/999999/receipt`, {
    headers: { Cookie: masterCookieHeader() },
  });
  assert.equal(res404.status, 404);
});

// ---------------------------------------------------------------------------
// Dashboard, listagens e auditoria
// ---------------------------------------------------------------------------
test('dashboard: indicadores refletem pagamentos e MRR', async () => {
  const r = await master('/platform/billing/overview');
  assert.equal(r.status, 200);
  assert.equal(r.data.mrr_expected_cents, 29990); // config Anjos (assinatura active)
  assert.ok(r.data.received_month_cents >= 179990); // 150000 + 29990
  assert.ok(r.data.overdue_count >= 1); // overdueCharge
  assert.ok(r.data.implementation_pending_count >= 0);
  assert.ok(Array.isArray(r.data.attention_overdue));
  assert.ok(r.data.attention_overdue.some((c) => c.id === overdueCharge.id));
});

test('empresas comerciais: filtros de situação e busca funcionam', async () => {
  const overdue = await master('/platform/billing/companies?situation=overdue');
  assert.equal(overdue.status, 200);
  assert.ok(overdue.data.items.some((c) => c.id === anjosId && c.overdue_count >= 1));
  const search = await master('/platform/billing/companies?search=Anjos');
  assert.ok(search.data.items.some((c) => c.id === anjosId));
  const none = await master('/platform/billing/companies?situation=none');
  assert.ok(none.data.items.some((c) => c.id === tenantCompanyId)); // sem config comercial
});

test('detalhe comercial: empresa com histórico completo', async () => {
  const r = await master(`/platform/billing/companies/${anjosId}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.config.monthly_fee_cents, 29990);
  assert.ok(r.data.charges.length >= 4);
  assert.ok(r.data.charge_totals.paid_cents >= 179990);
});

test('auditoria: ações comerciais registradas', async () => {
  const r = await master('/platform/audit?action=platform.billing');
  assert.equal(r.status, 200);
  const actions = new Set(r.data.items.map((i) => i.action));
  assert.ok(actions.has('platform.billing.payment'));
  assert.ok(actions.has('platform.billing.charge.create'));
  assert.ok(actions.has('platform.billing.config'));
});

test('isolamento em banco: pagamentos/cobranças vinculados ao company_id correto', () => {
  const p = db.prepare('SELECT company_id, COUNT(*) AS c FROM saas_payments GROUP BY company_id').all();
  assert.deepEqual(p.map((x) => x.company_id), [anjosId]);
  const charges = db.prepare('SELECT DISTINCT company_id FROM saas_charges').all();
  assert.deepEqual(charges.map((x) => x.company_id).sort(), [anjosId]);
});

// ---------------------------------------------------------------------------
// helpers locais de fetch com cookie (comprovante é binário — não passa pelo
// authed() que espera JSON)
// ---------------------------------------------------------------------------
let masterRawCookie = null;

async function base() {
  if (!masterRawCookie) {
    const m = await login('master@oficiallink.com.br', 'Master@2026');
    masterRawCookie = m.cookie;
  }
  return boot();
}
function masterCookieHeader() { return `ol_session=${encodeURIComponent(masterRawCookie)}`; }
