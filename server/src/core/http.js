'use strict';

/** Utilidades HTTP sem dependências: cookies e envelope de resposta. */

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      const name = part.slice(0, i).trim();
      const value = part.slice(i + 1).trim();
      if (name) out[name] = decodeURIComponent(value);
    }
  }
  return out;
}

function serializeCookie(name, value, opts = {}) {
  let s = `${name}=${encodeURIComponent(value)}`;
  s += `; Path=${opts.path || '/'}`;
  if (opts.maxAge !== undefined) s += `; Max-Age=${opts.maxAge}`;
  s += '; HttpOnly; SameSite=Lax';
  if (opts.secure) s += '; Secure';
  return s;
}

/** Envelope padrão de sucesso. */
function ok(res, data, status = 200) {
  return res.status(status).json({ ok: true, data });
}

module.exports = { parseCookies, serializeCookie, ok };
