'use strict';

/**
 * Conexão crua com o SQLite (better-sqlite3), sem migrations.
 * - WAL: leituras não bloqueiam escritas (com fallback automático para o
 *   journal padrão em filesystems que aceitam o WAL no pragma mas falham
 *   na escrita real — detectado por escrita de teste).
 * - foreign_keys ON: integridade referencial garantida no banco.
 *
 * Quem precisar do banco JÁ migrado importa './connection'.
 */

const fs = require('fs');
const path = require('path');
// require NÃO rastreável pelo bundler do Wrangler: este módulo só é carregado
// no modo clássico (Node + better-sqlite3). No Worker o adapter opera em D1.
const Database = eval('require')('better-sqlite3');
const config = require('../config');

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

function openWithWorkingJournal() {
  let db = new Database(config.dbFile);
  try {
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE IF NOT EXISTS _journal_probe (id INTEGER)');
    db.exec('DROP TABLE IF EXISTS _journal_probe');
    return db;
  } catch (err) {
    if (!String(err.message).toLowerCase().includes('readonly')) {
      try { db.close(); } catch { /* ignore */ }
      throw err;
    }
    console.warn('[db] WAL indisponível neste filesystem — usando journal padrão (delete).');
    try { db.close(); } catch { /* ignore */ }
    db = new Database(config.dbFile);
    db.pragma('journal_mode = DELETE');
    db.exec('CREATE TABLE IF NOT EXISTS _journal_probe (id INTEGER)');
    db.exec('DROP TABLE IF EXISTS _journal_probe');
    return db;
  }
}

const db = openWithWorkingJournal();
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

module.exports = db;
