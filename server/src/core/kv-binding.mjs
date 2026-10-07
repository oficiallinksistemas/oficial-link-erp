/**
 * Ponte ESM para o binding KV de rate limiting.
 *
 * Só é carregável dentro do bundle do Wrangler (módulo virtual
 * 'cloudflare:workers'). No Node clássico, require() deste arquivo lança
 * e o limiter opera em modo em-memória (comportamento idêntico ao anterior).
 */
import { env } from 'cloudflare:workers';

export function getKV() {
  return env.RATE_LIMIT || null;
}
