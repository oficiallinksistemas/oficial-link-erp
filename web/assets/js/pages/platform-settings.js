/**
 * Plataforma — Configurações (somente Master).
 * Cada controle aqui altera comportamento REAL do sistema.
 */

import { api } from '../api.js';
import { session } from '../app.js';
import { esc, toast } from '../ui.js';

export async function render(view) {
  const canManage = session.hasPerm('platform.settings.manage');
  const settings = await api.get('/platform/settings');

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h2>Configurações da plataforma</h2>
        <p>Parâmetros globais do Oficial Link ERP.</p>
      </div>
    </div>

    <div class="card"><div class="card-pad">
      <h3 class="card-title">Modo de manutenção</h3>
      <p class="card-sub">Quando ativo, usuários das empresas não conseguem acessar o sistema
      nem fazer login — vejam uma mensagem de manutenção. O acesso do Master nunca é bloqueado.</p>
      <form id="maint-form" novalidate>
        <div class="field" style="max-width:420px">
          <label class="switch-row" style="display:flex;align-items:center;gap:10px;cursor:pointer">
            <input type="checkbox" name="maintenance_mode" ${settings.maintenance_mode ? 'checked' : ''}
                   ${canManage ? '' : 'disabled'} style="width:16px;height:16px">
            <span>Plataforma em manutenção</span>
          </label>
          <div class="hint">Toda alteração é registrada na auditoria.</div>
        </div>
        ${canManage ? '<button class="btn btn-primary" type="submit" id="save-btn">Salvar configuração</button>'
                    : '<div class="alert alert-info">Você tem permissão apenas para visualizar.</div>'}
      </form>
    </div></div>

    <div class="card" style="margin-top:16px"><div class="card-pad">
      <h3 class="card-title">Informações da plataforma</h3>
      <p class="card-sub">Dados técnicos desta instância.</p>
      <ul class="activity-list">
        <li><span class="activity-ico">${''}</span><div class="activity-body">
          <div>Versão da fundação</div><div class="when">Oficial Link ERP v1.1 — Foundation Hardened</div></div></li>
        <li><span class="activity-ico"></span><div class="activity-body">
          <div>Produto</div><div class="when">SaaS multiempresa da Oficial Link Sistemas — www.oficiallink.com</div></div></li>
      </ul>
    </div></div>`;

  if (!canManage) return;
  const form = view.querySelector('#maint-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = view.querySelector('#save-btn');
    btn.disabled = true;
    btn.textContent = 'Salvando…';
    try {
      const on = form.maintenance_mode.checked;
      await api.patch('/platform/settings', { maintenance_mode: on });
      toast(on ? 'Modo de manutenção ATIVADO.' : 'Modo de manutenção desativado.');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Salvar configuração';
    }
  });
}
