/**
 * Tela de login — identidade navy/ciano da Oficial Link.
 */

import { api } from '../api.js';
import { session } from '../app.js';
import { esc } from '../ui.js';

export async function render(root) {
  root.innerHTML = `
    <div class="login-card">
      <img class="login-logo" src="/assets/img/logo.png" alt="Oficial Link">
      <h1 class="login-title">Oficial Link ERP</h1>
      <p class="login-sub">Gestão empresarial — acesse com sua conta</p>

      <div class="login-error" id="login-error" role="alert"></div>

      <form id="login-form" novalidate>
        <div class="field">
          <label for="email">E-mail</label>
          <input class="input" id="email" name="email" type="email" autocomplete="username"
                 placeholder="seu@email.com" required>
        </div>
        <div class="field">
          <label for="password">Senha</label>
          <input class="input" id="password" name="password" type="password" autocomplete="current-password"
                 placeholder="••••••••" required>
        </div>
        <button class="btn btn-primary" type="submit" style="width:100%; padding:11px" id="login-btn">
          Entrar
        </button>
      </form>

      <p class="login-foot">Oficial Link Sistemas · <a href="https://www.oficiallink.com" target="_blank" rel="noopener">www.oficiallink.com</a></p>
    </div>`;

  const form = root.querySelector('#login-form');
  const error = root.querySelector('#login-error');
  const btn = root.querySelector('#login-btn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.classList.remove('show');
    const email = form.email.value.trim();
    const password = form.password.value;
    if (!email || !password) {
      error.textContent = 'Informe e-mail e senha.';
      error.classList.add('show');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Entrando…';
    try {
      await api.post('/auth/login', { email, password });
      await session.load();
      form.reset();
      location.hash = '#/dashboard';
    } catch (err) {
      error.textContent = esc(err.message || 'E-mail ou senha inválidos.');
      error.classList.add('show');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Entrar';
    }
  });
}
