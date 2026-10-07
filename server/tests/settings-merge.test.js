'use strict';

/**
 * V3.1.1 — patch cirúrgico:
 * (1) companies.settings preserva chaves desconhecidas/futuras em qualquer
 *     atualização (merge seguro, não whitelist);
 * (2) usuário somente leitura (company.settings.view sem .manage) visualiza o
 *     branding mas não edita — sem nenhuma mudança de RBAC.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
// helpers SEMPRE primeiro
const { login, authed, shutdown, passwordFor } = require('./helpers');
const db = require('../src/database/connection');

let admin; let anjosId;

before(async () => {
  const m = await login('master@oficiallink.com.br', 'Master@2026');
  const master = authed(m.cookie);
  anjosId = (await master('/platform/companies?search=Anjos')).data.items[0].id;
  const a = await login('admin@anjos.com.br', 'Anjos@2026');
  admin = authed(a.cookie);
});

after(shutdown);

const rawSettings = () => JSON.parse(db.prepare('SELECT settings FROM companies WHERE id = ?').get(anjosId).settings);

test('SETTINGS-PRESERVE: chaves desconhecidas/futuras sobrevivem a updates de branding E de timezone', async () => {
  // planta uma chave futura direto no banco (simula configuração de versão futura)
  const current = rawSettings();
  db.prepare('UPDATE companies SET settings = ? WHERE id = ?')
    .run(JSON.stringify({ ...current, future_setting: 'preserve-me', nested: { a: 1, b: [1, 2] } }), anjosId);

  // update de branding
  const r1 = await admin('/company', { method: 'PATCH', body: { branding: { display_name: 'Merge Seguro', primary_color: '#123ABC' } } });
  assert.equal(r1.status, 200);

  let s = rawSettings();
  assert.equal(s.future_setting, 'preserve-me', 'chave futura preservada após update de branding');
  assert.deepEqual(s.nested, { a: 1, b: [1, 2] }, 'estrutura aninhada preservada');
  assert.equal(s.branding.display_name, 'Merge Seguro', 'branding atualizado');
  assert.equal(s.branding.primary_color, '#123ABC');
  assert.equal(s.timezone, 'America/Fortaleza', 'timezone intacto');
  assert.equal(s.currency, 'BRL', 'currency intacto');

  // update de configuração existente (timezone) — mesmo caminho de merge
  const r2 = await admin('/company', { method: 'PATCH', body: { timezone: 'America/Belem' } });
  assert.equal(r2.status, 200);
  s = rawSettings();
  assert.equal(s.timezone, 'America/Belem', 'timezone alterado');
  assert.equal(s.future_setting, 'preserve-me', 'chave futura preservada após update de timezone');
  assert.equal(s.branding.display_name, 'Merge Seguro', 'branding intacto');

  // limpeza do cenário
  delete s.future_setting; delete s.nested; s.timezone = 'America/Fortaleza';
  db.prepare('UPDATE companies SET settings = ? WHERE id = ?').run(JSON.stringify(s), anjosId);
});

test('READONLY-VIEW: supervisor (view sem manage) visualiza branding; PATCH negado; seller sem permissão não acessa', async () => {
  await admin('/company', { method: 'PATCH', body: { branding: { display_name: 'Visão Readonly', accent_color: '#FF8800' } } });

  const sup = await login('supervisor@anjos.com.br', passwordFor('supervisor@anjos.com.br') || 'Anjos@2026');
  const supervisor = authed(sup.cookie);

  // visualiza (GET com branding completo)
  const view = await supervisor('/company');
  assert.equal(view.status, 200, 'somente leitura acessa a tela');
  assert.equal(view.data.branding.display_name, 'Visão Readonly', 'vê o nome de exibição');
  assert.equal(view.data.branding.accent_color, '#FF8800', 'vê as cores');
  assert.equal(view.data.settings.timezone, 'America/Fortaleza');
  const me = await supervisor('/auth/me');
  assert.equal(me.data.branding.display_name, 'Visão Readonly', 'branding também no /me');

  // NÃO edita (nenhuma mudança de RBAC — a permissão existente já bloqueia)
  const denied = await supervisor('/company', { method: 'PATCH', body: { branding: { display_name: 'Tentativa' } } });
  assert.equal(denied.status, 403, 'somente leitura não edita branding');

  // sem permissão relevante: seller não acessa os dados da empresa
  const s = await login('vendedor@anjos.com.br', passwordFor('vendedor@anjos.com.br') || 'Anjos@2026');
  const seller = authed(s.cookie);
  assert.equal((await seller('/company')).status, 403, 'sem company.settings.view → 403');
  // ...mas vê a identidade aplicada no /me
  const sellerMe = await seller('/auth/me');
  assert.equal(sellerMe.data.branding.display_name, 'Visão Readonly');

  // admin (manage) continua editando normalmente
  const edit = await admin('/company', { method: 'PATCH', body: { branding: { display_name: null, accent_color: null } } });
  assert.equal(edit.status, 200);
});
