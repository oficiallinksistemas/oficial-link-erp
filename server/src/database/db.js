'use strict';

/**
 * Conexão crua com o SQLite (better-sqlite3), sem migrations.
 *
 * CARREGAMENTO PREGUIÇOSO (crítico para o Worker): este módulo é incluído
 * no bundle do Wrangler (via seed/migrations no grafo de imports), mas o
 * Worker NUNCA o executa — o adapter opera em modo D1. Por isso nada roda
 * em nível de módulo: nem require do better-sqlite3 (addon nativo, ausente
 * no workerd), nem mkdirSync (sem filesystem), nem abertura do banco.
 * Tudo acontece dentro de getDb(), chamado apenas no modo clássico.
 *
 * - WAL: leituras não bloqueiam escritas (fallback automático para o
 *   journal padrão em filesystems que falham na escrita real).
 * - foreign_keys ON: integridade referencial garantida no banco.
 *
 * Quem precisar do banco JÁ migrado importa './connection' (adapter dual).
 */

let db = null;

function getDb() {
  if (db) return db;
  const fs = require('fs');
  const path = require('path');
  // require NÃO rastreável pelo bundler do Wrangler: só executa no modo
  // clássico (Node). No Worker getDb nunca é chamado.
  const Database = eval('require')('better-sqlite3');
  const config = require('../config');

  fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

  const openWithWorkingJournal = () => {
    let handle = new Database(config.dbFile);
    try {
      handle.pragma('journal_mode = WAL');
      handle.exec('CREATE TABLE IF NOT EXISTS _journal_probe (id INTEGER)');
      handle.exec('DROP TABLE IF EXISTS _journal_probe');
      return handle;
    } catch (err) {
      if (!String(err.message).toLowerCase().includes('readonly')) {
        try { handle.close(); } catch { /* ignore */ }
        throw err;
      }
      console.warn('[db] WAL indisponível neste filesystem — usando journal padrão (delete).');
      try { handle.close(); } catch { /* ignore */ }
      handle = new Database(config.dbFile);
      handle.pragma('journal_mode = DELETE');
      handle.exec('CREATE TABLE IF NOT EXISTS _journal_probe (id INTEGER)');
      handle.exec('DROP TABLE IF EXISTS _journal_probe');
      return handle;
    }
  };

  db = openWithWorkingJournal();
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

/**
 * Proxy que mantém a API antiga (require('./db').prepare(...)) preservada
 * para migrations/seed/scripts, mas só materializa a conexão no primeiro
 * acesso. No Worker, simplesmente nunca é tocado.
 */
module.exports = new Proxy({}, {
  get(_target, prop) {
    const handle = getDb();
    const value = handle[prop];
    return typeof value === 'function' ? value.bind(handle) : value;
  },
  set(_target, prop, value) {
    getDb()[prop] = value;
    return true;
  },
  has(_target, prop) {
    return prop in getDb();
  },
});
