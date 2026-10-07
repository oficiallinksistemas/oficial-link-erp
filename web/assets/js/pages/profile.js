/**
 * Meu perfil — dados da conta e troca de senha.
 */

import { api } from '../api.js';
import { session } from '../app.js';
import { esc, toast, fmtDateTime, initials, icon } from '../ui.js';

export async function render(view) {
  const me = session.me;

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h2>Meu perfil</h2>
        <p>Suas informações de acesso e segurança.</p>
      </div>
    </div>

    <div class="dashboard-grid">
      <div class="card"><div class="card-pad">
        <h3 class="card-title">Dados da conta</h3>
        <p class="card-sub">Informações vinculadas ao seu usuário.</p>
        <ul class="activity-list">
          <li><span class="avatar" style="width:38px;height:38px">${esc(initials(me.user.name))}</span>
            <div class="activity-body">
              <div><strong>${esc(me.user.name)}</strong></div>
              <div class="when">${esc(me.user.email)}</div>
            </div></li>
          <li><span class="activity-ico">${icon('shield')}</span><div class="activity-body">
            <div>Função: <strong>${esc(me.role.name)}</strong></div>
            <div class="when">${me.permissions.length} permissões concedidas a esta função</div></div></li>
          ${me.company ? `<li><span class="activity-ico">${icon('building')}</span><div class="activity-body">
            <div>Empresa: <strong>${esc(me.company.name)}</strong></div>
            <div class="when">${me.store ? 'Loja vinculada: ' + esc(me.store.name) : 'Sem loja vinculada'}</div></div></li>` : `
            <li><span class="activity-ico">${icon('globe')}</span><div class="activity-body">
            <div><strong>Plataforma Oficial Link</strong></div>
            <div class="when">Acesso global de administração</div></div></li>`}
          <li><span class="activity-ico">${icon('clock')}</span><div class="activity-body">
            <div>Último acesso</div><div class="when">${esc(fmtDateTime(me.user.lastLoginAt))}</div></div></li>
        </ul>
      </div></div>

      <div class="card"><div class="card-pad">
        <h3 class="card-title">Alterar senha</h3>
        <p class="card-sub">Use uma senha forte, diferente da anterior.</p>
        <form id="pwd-form" novalidate>
          <div class="field">
            <label>Senha atual</label>
            <input class="input" type="password" name="current_password" required autocomplete="current-password">
          </div>
          <div class="field">
            <label>Nova senha</label>
            <input class="input" type="password" name="new_password" required minlength="8" autocomplete="new-password">
            <div class="hint">Mínimo de 8 caracteres. Suas outras sessões serão encerradas.</div>
          </div>
          <div class="field">
            <label>Confirmar nova senha</label>
            <input class="input" type="password" name="confirm" required minlength="8" autocomplete="new-password">
          </div>
          <button class="btn btn-primary" type="submit" id="pwd-btn">Alterar senha</button>
        </form>
      </div></div>
    </div>`;

  const form = view.querySelector('#pwd-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (form.new_password.value !== form.confirm.value) {
      toast('As senhas não coincidem.', 'error');
      return;
    }
    const btn = view.querySelector('#pwd-btn');
    btn.disabled = true;
    btn.textContent = 'Alterando…';
    try {
      await api.post('/auth/change-password', {
        current_password: form.current_password.value,
        new_password: form.new_password.value,
      });
      toast('Senha alterada com sucesso.');
      form.reset();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Alterar senha';
    }
  });
}
