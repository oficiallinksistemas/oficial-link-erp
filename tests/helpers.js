'use strict';

/**
 * Helpers da suíte de testes — sobe o app real em porta efêmera com um
 * banco SQLite temporário e exclusivo por processo/worker de teste.
 *
 * IMPORTANTE: as variáveis de ambiente são definidas ANTES de importar o app.
 * SEMPRE require('./helpers') antes de qualquer outro require do src/.
 */

process.env.NODE_ENV = 'test';
process.env.SECURE_COOKIES = '0';

const os = require('os');
const path = require('path');
const { threadId } = require('node:worker_threads');

const dbFile = path.join(os.tmpdir(),
  `olerp-test-${process.pid}-${threadId}-${Math.random().toString(36).slice(2, 8)}.db`);
process.env.DB_FILE = dbFile;

const app = require('../src/app');

let server = null;
let baseUrl = '';

async function boot() {
  if (server) return baseUrl;
  await new Promise((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', resolve);
    server.on('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return baseUrl;
}

async function shutdown() {
  if (server) await new Promise((r) => server.close(r));
}

/**
 * Chamada de API via fetch com suporte a cookie manual (fetch não gerencia
 * cookies automaticamente em Node).
 */
async function api(pathname, { method = 'GET', body, cookie, origin, raw } = {}) {
  await boot();
  const headers = {};
  if (body !== undefined || raw !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers['Cookie'] = `ol_session=${cookie}`;
  if (origin) headers['Origin'] = origin;
  const res = await fetch(baseUrl + '/api' + pathname, {
    method,
    headers,
    body: raw !== undefined ? raw : (body !== undefined ? JSON.stringify(body) : undefined),
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie') || '';
  const m = setCookie.match(/ol_session=([^;]+)/);
  let payload = null;
  try { payload = await res.json(); } catch { /* vazio */ }
  return {
    status: res.status,
    data: payload && payload.data,
    error: payload && payload.error,
    cookie: m ? decodeURIComponent(m[1]) : null,
  };
}

/**
 * Login → { cookie, status, error }.
 *
 * Usuários do seed nascem com troca de senha obrigatória (must_change_password).
 * Este helper simula o que o usuário real faz no 1º acesso: detecta o flag e
 * troca para uma senha determinística, mantendo a MESMA sessão válida.
 * Chamadas seguintes aceitam a senha antiga (ela falha e o helper retenta com
 * a senha efetiva), então os testes existentes não precisam mudar.
 */
const establishedPasswords = new Map(); // email → senha efetiva atual
const validPasswords = new Map();       // email → Set de senhas que já funcionaram

function passwordFor(email) {
  return establishedPasswords.get(email) || null;
}

async function login(email, password) {
  const attempt = (pwd) => api('/auth/login', { method: 'POST', body: { email, password: pwd } });

  let used = password;
  let r = await attempt(used);
  // Retenta com a senha efetiva apenas quando a informada JÁ FUNCIONOU alguma
  // vez (ex.: senha inicial do seed após a troca obrigatória). Senha nunca
  // vista → 401 real (protege testes de senha incorreta).
  if (r.status === 401 && validPasswords.has(email) && validPasswords.get(email).has(password)) {
    used = establishedPasswords.get(email);
    r = await attempt(used);
  }
  if (r.status !== 200) return r;

  (validPasswords.get(email) || validPasswords.set(email, new Set()).get(email)).add(used);
  const me = await api('/auth/me', { cookie: r.cookie });
  if (me.status === 200 && me.data && me.data.user.mustChangePassword) {
    // troca obrigatória: current = senha que funcionou nesta tentativa
    const finalPassword = `Trocada@${email.length}X${email.charCodeAt(0)}${email.charCodeAt(email.length - 1)}`;
    const ch = await api('/auth/change-password', {
      method: 'POST', cookie: r.cookie,
      body: { current_password: used, new_password: finalPassword },
    });
    if (ch.status === 200) {
      establishedPasswords.set(email, finalPassword);
      validPasswords.get(email).add(finalPassword);
    }
  } else {
    establishedPasswords.set(email, used);
  }
  return r;
}

/** Cliente autenticado: authed(cookie)('/stores', { method:'POST', body:{...} }). */
const authed = (cookie) => (pathname, opts = {}) => api(pathname, { ...opts, cookie });

/**
 * Cria empresa + loja + usuário administrador via API do Master.
 * must_change_password=false: o admin de teste já nasce com senha definitiva
 * (o fluxo de troca obrigatória tem teste próprio em auth.test.js).
 */
async function createTenant(master, name) {
  const company = await master('/platform/companies', { method: 'POST', body: { name } });
  const store = await master('/platform/stores', {
    method: 'POST',
    body: { company_id: company.data.id, name: `${name} - Matriz`, code: 'MATRIZ', state: 'MA' },
  });
  const user = await master('/platform/users', {
    method: 'POST',
    body: {
      company_id: company.data.id, name: `Admin ${name}`,
      email: `admin@${name.toLowerCase().replace(/\s+/g, '')}.com`,
      password: 'Temp@123456', role_slug: 'company_admin', store_id: store.data.id,
      must_change_password: false,
    },
  });
  return { company: company.data, store: store.data, user: user.data };
}

module.exports = { api, login, authed, createTenant, boot, shutdown, dbFile, passwordFor };
