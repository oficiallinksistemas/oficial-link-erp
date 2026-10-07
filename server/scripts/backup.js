'use strict';

/**
 * Backup local seguro do banco SQLite.
 *
 * Usa a API online backup do better-sqlite3 (db.backup), que copia o banco
 * de forma consistente MESMO com o sistema em execução (sem corrupção).
 * Mantém os 10 backups mais recentes e remove os antigos.
 *
 * Uso:  npm run backup
 * Restore: pare o servidor e substitua data/erp.db pelo arquivo de backup
 *          desejado (ex.: data/backups/erp-backup-20261005-083000.db).
 */

const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const db = require('../src/database/connection');

async function main() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const dir = path.join(path.dirname(config.dbFile), 'backups');
  fs.mkdirSync(dir, { recursive: true });

  const target = path.join(dir, `erp-backup-${stamp}.db`);
  await db.backup(target);

  // Rotação: mantém os 10 mais recentes
  const files = fs.readdirSync(dir)
    .filter((f) => f.startsWith('erp-backup-') && f.endsWith('.db'))
    .sort()
    .reverse();
  for (const old of files.slice(10)) fs.unlinkSync(path.join(dir, old));

  const sizeKb = Math.round(fs.statSync(target).size / 1024);
  console.log('');
  console.log(`  Backup concluído: ${target} (${sizeKb} KB)`);
  console.log(`  Banco de origem:  ${config.dbFile}`);
  console.log('');
  console.log('  Para restaurar: pare o servidor e copie o backup para o caminho');
  console.log('  do banco (data/erp.db), depois inicie novamente.');
  console.log('');
}

main().catch((err) => {
  console.error('Falha no backup:', err.message);
  process.exit(1);
});
