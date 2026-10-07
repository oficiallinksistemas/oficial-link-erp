/**
 * Ponte ESM para o binding D1 no Worker.
 *
 * Só é carregável dentro do bundle do Wrangler (módulo virtual
 * 'cloudflare:workers'). No Node clássico, require() deste arquivo lança
 * e o adapter opera em modo better-sqlite3.
 */
import { env } from 'cloudflare:workers';

export function getBinding() {
  if (!env.DB) {
    throw new Error('Binding D1 "DB" não configurado (wrangler.toml).');
  }
  return env.DB;
}
