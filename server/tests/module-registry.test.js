'use strict';

/**
 * V3.2 — Registry de módulos: o slug canônico do módulo Metas é 'targets'
 * (migration 004). A migration 019 remove o placeholder órfão 'goals' (da
 * migration 003). Este teste impede regressão: 'goals' não pode voltar a
 * existir no registry, e 'targets' deve continuar ativável e funcional.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
// helpers SEMPRE primeiro
const { login, authed, shutdown } = require('./helpers');
const db = require('../src/database/connection');

let master; let admin; let anjosId;

before(async () => {
  const m = await login('master@oficiallink.com.br', 'Master@2026');
  master = authed(m.cookie);
  anjosId = (await master('/platform/companies?search=Anjos')).data.items[0].id;
  const a = await login('admin@anjos.com.br', 'Anjos@2026');
  admin = authed(a.cookie);
});

after(shutdown);

test('registry: slug goals foi removido do registry de módulos (migration 019)', () => {
  const row = db.prepare('SELECT slug FROM modules WHERE slug = ?').get('goals');
  assert.equal(row, undefined, "'goals' não deve existir na tabela modules");
  const cm = db.prepare('SELECT 1 AS x FROM company_modules WHERE module_slug = ?').get('goals');
  assert.equal(cm, undefined, "nenhuma empresa deve ter company_modules em 'goals'");
});

test('registry: targets é o slug canônico do módulo Metas e segue ativável', async () => {
  const mod = db.prepare('SELECT slug, name FROM modules WHERE slug = ?').get('targets');
  assert.ok(mod, "módulo 'targets' deve existir no registry");
  assert.equal(mod.name, 'Metas');

  // ativação via plataforma funciona com o slug canônico
  const r = await master(`/platform/companies/${anjosId}/modules/targets`, {
    method: 'PUT', body: { status: 'active' },
  });
  assert.equal(r.status, 200);

  // /api/modules (menu do tenant) reflete o slug canônico e NUNCA 'goals'
  const list = await admin('/modules');
  const slugs = list.data.map((m) => m.slug);
  assert.ok(slugs.includes('targets'), 'tenant deve enxergar o módulo targets');
  assert.ok(!slugs.includes('goals'), 'tenant NUNCA deve enxergar o slug goals');
});
