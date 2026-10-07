/**
 * Cliente de API — único ponto de contato do frontend com o backend.
 * - envelope padronizado { ok, data } / { ok:false, error:{code,message} }
 * - 401 fora do login → sessão encerrada → volta para a tela de login
 */

export class ApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function request(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Sem conexão com o servidor. Verifique sua internet.', 'NETWORK', 0);
  }

  let payload = null;
  try { payload = await res.json(); } catch { /* resposta vazia */ }

  if (!res.ok || !payload || payload.ok === false) {
    const err = payload && payload.error ? payload.error : {};
    if (res.status === 401 && !path.startsWith('/auth/login')) {
      window.dispatchEvent(new CustomEvent('session:expired'));
    }
    throw new ApiError(err.message || 'Erro inesperado. Tente novamente.', err.code || 'ERROR', res.status);
  }
  return payload.data;
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body: body ?? {} }),
  patch: (path, body) => request(path, { method: 'PATCH', body: body ?? {} }),
  delete: (path) => request(path, { method: 'DELETE' }),
};
