'use strict';

/**
 * Sistema de migrations — versão controlada do banco de dados.
 *
 * - Cada arquivo em migrations/NNN_descricao.sql é aplicado UMA vez.
 * - A tabela schema_migrations registra o que já foi aplicado.
 * - Bancos legados da v1 (que já tinham as tabelas, mas não a tabela de
 *   controle) têm a migration 001 reconhecida como "já aplicada" e partem
 *   direto para as novas — SEM perder dados.
 * - Nunca destrói dados existentes: apenas CREATE/ALTER/INSERT controlados.
 */

const fs = require('fs');
const path = require('path');
const db = require('./db');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function ensureControlTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id         TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}

function appliedIds() {
  return new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id));
}

function tableExists(name) {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

function register(id) {
  db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(id);
}

function runMigrations() {
  ensureControlTable();
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const done = appliedIds();
  const isLegacyV1 = done.size === 0 && tableExists('users');

  for (const file of files) {
    const id = file.replace(/\.sql$/, '');
    if (done.has(id)) continue;

    // Banco v1: schema base já existia — apenas registrar, sem reaplicar
    if (isLegacyV1 && id === '001_initial') {
      register(id);
      continue;
    }

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      register(id);
    })();
    console.log(`[migrate] aplicada: ${id}`);
  }

  if (isLegacyV1) console.log('[migrate] banco legado v1 detectado — dados preservados.');
}

module.exports = { runMigrations };
