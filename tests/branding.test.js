'use strict';

/**
 * Personalização da identidade visual por empresa (v3.1) — branding em
 * companies.settings + logo em company_assets (BLOB). Isolamento multi-tenant,
 * validações de backend, permissões e defaults.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
// helpers SEMPRE primeiro
const { api, login, authed, createTenant, shutdown, passwordFor } = require('./helpers');

let admin; let master; let anjosId; let tenantB;

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const JPEG_1PX = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Al//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//aAAwDAQACEQMRAD8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEBAT8QH//Z';
const FAKE_PNG = 'aGVsbG8gd29ybGQ='; // base64 de texto — magic bytes inválidos

before(async () => {
  const m = await login('master@oficiallink.com.br', 'Master@2026');
  master = authed(m.cookie);
  anjosId = (await master('/platform/companies?search=Anjos')).data.items[0].id;
  const a = await login('admin@anjos.com.br', 'Anjos@2026');
  admin = authed(a.cookie);
  tenantB = await createTenant(master, 'EmpresaBrand');
});

after(shutdown);

const getBranding = () => admin('/company').then((r) => r.data.branding);
const patch = (payload) => admin('/company', { method: 'PATCH', body: payload });

test('BR-CRUD: empresa consulta e altera suas configurações; persiste após nova consulta', async () => {
  const r = await patch({ branding: { display_name: 'Anjos Moda', primary_color: '#2563EB', secondary_color: '#06B6D4', accent_color: '#F59E0B' } });
  assert.equal(r.status, 200, JSON.stringify(r.error));
  const b = await getBranding();
  assert.equal(b.display_name, 'Anjos Moda');
  assert.equal(b.primary_color, '#2563EB');
  assert.equal(b.accent_color, '#F59E0B');
  // persiste
  const b2 = await getBranding();
  assert.equal(b2.display_name, 'Anjos Moda');
  // /me expõe o branding para TODOS os usuários do tenant
  const me = await admin('/auth/me');
  assert.equal(me.data.branding.display_name, 'Anjos Moda');
  assert.equal(me.data.branding.logo_url, null, 'sem logo ainda');
});

test('BR-VALID: cores inválidas e nome inválido são rejeitados; injeção CSS/JS não passa', async () => {
  assert.equal((await patch({ branding: { primary_color: 'red' } })).status, 400);
  assert.equal((await patch({ branding: { primary_color: '#GGG000' } })).status, 400);
  assert.equal((await patch({ branding: { primary_color: '#fff' } })).status, 400);
  assert.equal((await patch({ branding: { primary_color: '#2563EB; body{display:none}' } })).status, 400);
  assert.equal((await patch({ branding: { display_name: 'X' } })).status, 400);
  // minúscula normalizada
  const ok = await patch({ branding: { primary_color: '#a1b2c3' } });
  assert.equal(ok.data.branding.primary_color, '#A1B2C3');
});

test('BR-LOGO: upload PNG/JPEG por magic bytes, rejeição de inválido/oversize, substituição e remoção', async () => {
  const up = await patch({ logo_data: PNG_1PX });
  assert.equal(up.status, 200, JSON.stringify(up.error));
  let b = await getBranding();
  assert.ok(b.logo_url && b.logo_url.includes('/api/company/branding/logo'), 'logo_url presente e versionada');
  // substituição por JPEG
  await patch({ logo_data: JPEG_1PX });
  b = await getBranding();
  assert.ok(b.logo_url, 'logo substituído');

  // inválido (magic bytes de texto) e oversize
  assert.equal((await patch({ logo_data: FAKE_PNG })).status, 400);
  const big = Buffer.alloc(160 * 1024, 7).toString('base64');
  assert.equal((await patch({ logo_data: big })).status, 400);

  // remoção
  const cleared = await patch({ logo_data: null });
  assert.equal((await getBranding()).logo_url, null);
});

test('BR-DEFAULTS: restore aos padrões; empresa sem personalização usa identidade Oficial Link', async () => {
  await patch({ branding: { display_name: 'Temp', primary_color: '#111111' }, logo_data: PNG_1PX });
  const reset = await patch({ branding: { display_name: null, primary_color: null, secondary_color: null, accent_color: null }, logo_data: null });
  const b = reset.data.branding;
  assert.equal(b.display_name, null);
  assert.equal(b.primary_color, null);
  assert.equal(b.logo_url, null, 'padrão Oficial Link (sem logo)');
  const me = await admin('/auth/me');
  assert.equal(me.data.branding.display_name, null, '/me sem personalização → nome cadastral');
  assert.equal(me.data.branding.company_name, 'Anjos');
});

test('BR-RBAC: vendedor visualiza identidade no /me mas não edita; supervisor não edita', async () => {
  const s = await login('vendedor@anjos.com.br', passwordFor('vendedor@anjos.com.br') || 'Anjos@2026');
  const seller = authed(s.cookie);
  const me = await seller('/auth/me');
  assert.ok('branding' in me.data, 'vendedor vê a identidade aplicada');
  assert.equal((await seller('/company', { method: 'PATCH', body: { branding: { display_name: 'Hack' } } })).status, 403);

  const sup = await login('supervisor@anjos.com.br', passwordFor('supervisor@anjos.com.br') || 'Anjos@2026');
  const supervisor = authed(sup.cookie);
  assert.equal((await supervisor('/company', { method: 'PATCH', body: { branding: { display_name: 'Hack' } } })).status, 403);
});

test('BR-ISOLAMENTO: Empresa B não lê nem altera a identidade da Anjos; company_id da sessão é autoridade', async () => {
  await patch({ branding: { display_name: 'Identidade Anjos' }, logo_data: PNG_1PX });
  const bLogin = await login('admin@empresabrand.com', 'Temp@123456');
  const bAdmin = authed(bLogin.cookie);
  await master(`/platform/companies/${tenantB.company.id}/modules/receivables`, { method: 'PUT', body: { status: 'active' } });

  const bMe = await bAdmin('/auth/me');
  assert.notEqual(bMe.data.branding.display_name, 'Identidade Anjos', 'B não vê a identidade da Anjos');
  assert.equal(bMe.data.branding.company_name, 'EmpresaBrand');
  // sem company_id no payload — a sessão decide; adulteração de identificadores
  // não existe como parâmetro (PATCH nunca aceita company_id). B edita a
  // PRÓPRIA empresa (legítimo) e a Anjos permanece intacta.
  const selfEdit = await bAdmin('/company', { method: 'PATCH', body: { name: 'EmpresaBrand Ltda' } });
  assert.equal(selfEdit.status, 200);
  const anjosStill = await getBranding();
  assert.equal(anjosStill.display_name, 'Identidade Anjos', 'Anjos intacta');
  const bName = (await bAdmin('/company')).data.name;
  assert.equal(bName, 'EmpresaBrand Ltda', 'B alterou apenas a própria empresa');
  await bAdmin('/company', { method: 'PATCH', body: { name: 'EmpresaBrand' } });
});

test('BR-AUDIT: alteração de identidade registrada; falha não gera auditoria de sucesso', async () => {
  await patch({ branding: { display_name: 'Audit Brand' } });
  const audit = await master(`/platform/audit?company_id=${anjosId}&action=company.branding.update`);
  assert.ok(audit.data.total >= 1, 'evento de branding na auditoria');
  const beforeTotal = audit.data.total;
  await patch({ branding: { primary_color: 'invalido' } }).catch(() => {});
  const after1 = (await master(`/platform/audit?company_id=${anjosId}&action=company.branding.update`)).data.total;
  assert.equal(after1, beforeTotal, 'falha de validação não gerou evento de sucesso');
});
