'use strict';

/**
 * Rate limiting de janela fixa, DUAL:
 *
 *   Workers (produção): contadores no binding KV env.RATE_LIMIT — consistente
 *     entre isolates/regiões. TTL nativo do KV expira as janelas.
 *   Node clássico (testes/dev): Map em memória (comportamento idêntico ao
 *     original da V3.5.0). Limpeza preguiçosa por request (Workers não têm
 *     timers persistentes) + setInterval quando disponível.
 *
 * SEMÂNTICA PRESERVADA: mesmas chaves, mesmos limites, mesmo envelope de
 * erro RATE_LIMITED com Retry-After. Falha do KV → fail-OPEN (request
 * liberado + log): disponibilidade prevalece sobre bloqueio momentâneo.
 */

let kvBinding;
let kvChecked = false;
function getKV() {
  if (!kvChecked) {
    kvChecked = true;
    try {
      kvBinding = require('./kv-binding.mjs').getKV();
    } catch {
      kvBinding = null; // Node clássico: modo memória
    }
  }
  return kvBinding;
}

/* ------------------------------- store memória ----------------------------- */

function createMemoryStore(windowMs) {
  const hits = new Map();
  if (typeof setInterval === 'function') {
    const timer = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    }, windowMs);
    timer.unref();
  }
  const gc = () => {
    if (hits.size > 512) {
      const now = Date.now();
      for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    }
  };
  return {
    async read(key) {
      gc();
      const e = hits.get(key);
      if (!e || e.reset < Date.now()) return { count: 0, reset: Date.now() + windowMs };
      return { count: e.count, reset: e.reset };
    },
    async write(key, entry) {
      hits.set(key, entry);
    },
    async remove(key) {
      hits.delete(key);
    },
  };
}

/* --------------------------------- store KV -------------------------------- */

function createKVStore(kv, windowMs, prefix) {
  const k = (key) => `rl:${prefix}:${key}`;
  const ttlOf = (reset) => Math.max(60, Math.ceil((reset - Date.now()) / 1000));
  return {
    async read(key) {
      const e = await kv.get(k(key), 'json');
      if (!e || e.reset < Date.now()) return { count: 0, reset: Date.now() + windowMs };
      return e;
    },
    async write(key, entry) {
      await kv.put(k(key), JSON.stringify(entry), { expirationTtl: ttlOf(entry.reset) });
    },
    async remove(key) {
      await kv.delete(k(key));
    },
  };
}

function createStore(windowMs, prefix) {
  const kv = getKV();
  return kv ? createKVStore(kv, windowMs, prefix) : createMemoryStore(windowMs);
}

/* ------------------------------ middleware -------------------------------- */

function tooMany(res, waitSeconds) {
  res.set('Retry-After', String(waitSeconds));
  return res.status(429).json({
    ok: false,
    error: {
      code: 'RATE_LIMITED',
      message: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.',
    },
  });
}

function createRateLimiter({ windowMs, max, key }) {
  const store = createStore(windowMs, 'mw');
  return async function rateLimiter(req, res, next) {
    try {
      const k = key ? key(req) : req.ip;
      const entry = await store.read(k);
      entry.count += 1;
      await store.write(k, entry);
      if (entry.count > max) return tooMany(res, Math.ceil((entry.reset - Date.now()) / 1000));
      next();
    } catch (err) {
      // fail-open: indisponibilidade do KV não trava o ERP
      console.error('[rate-limit] store indisponível, liberando request:', err.message);
      next();
    }
  };
}

/**
 * Limitador baseado em FALHAS (ideal para login): apenas tentativas que
 * falham contam para o bloqueio. Logins corretos limpam o contador.
 * Uso: const guard = createFailureLimiter({windowMs, max});
 *   const wait = await guard.isBlocked(key); if (wait) → 429
 *   onFailure: await guard.hit(key);  onSuccess: await guard.clear(key);
 */
function createFailureLimiter({ windowMs, max }) {
  const store = createStore(windowMs, 'fl');
  return {
    /** Retorna segundos de espera se bloqueado, ou 0. */
    async isBlocked(key) {
      try {
        const e = await store.read(key);
        if (e.count >= max && e.reset > Date.now()) {
          return Math.ceil((e.reset - Date.now()) / 1000);
        }
        return 0;
      } catch {
        return 0; // fail-open
      }
    },
    async hit(key) {
      try {
        const e = await store.read(key);
        e.count += 1;
        await store.write(key, e);
      } catch {
        /* fail-open */
      }
    },
    async clear(key) {
      try {
        await store.remove(key);
      } catch {
        /* fail-open */
      }
    },
  };
}

module.exports = { createRateLimiter, createFailureLimiter };
