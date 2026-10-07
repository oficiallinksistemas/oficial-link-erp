/**
 * Plataforma — Auditoria: trilha de eventos de toda a plataforma (somente Master).
 */

import { api } from '../api.js';
import { esc, dataTable, pagination, debounce, fmtDateTime, optionsHtml } from '../ui.js';

const state = { page: 1, company_id: '', action: '' };

const ACTION_LABELS = {
  'auth.login': 'Login realizado',
  'auth.login_failed': 'Login recusado (senha errada)',
  'auth.login_blocked': 'Login bloqueado',
  'auth.logout': 'Logout',
  'auth.password_changed': 'Senha alterada pelo próprio usuário',
  'user.create': 'Usuário cadastrado (empresa)',
  'user.update': 'Usuário atualizado (empresa)',
  'user.reset_password': 'Senha redefinida (empresa)',
  'platform.user.create': 'Usuário cadastrado (Master)',
  'platform.user.update': 'Usuário atualizado (Master)',
  'platform.user.reset_password': 'Senha redefinida (Master)',
  'platform.user.revoke_sessions': 'Sessões encerradas (Master)',
  'store.create': 'Loja cadastrada (empresa)',
  'store.update': 'Loja atualizada (empresa)',
  'platform.store.create': 'Loja cadastrada (Master)',
  'platform.store.update': 'Loja atualizada (Master)',
  'company.update': 'Dados da empresa alterados',
  'platform.company.create': 'Empresa cadastrada',
  'platform.company.update': 'Empresa atualizada/suspensa',
  'platform.settings.update': 'Configurações da plataforma alteradas',
};

export async function render(view) {
  view.innerHTML = `
    <div class="page-head">
      <div>
        <h2>Auditoria da plataforma</h2>
        <p>Registro das ações importantes realizadas no sistema.</p>
      </div>
    </div>
    <div class="card" id="card"><div class="loading-line">Carregando…</div></div>`;

  const companies = await api.get('/platform/companies?per_page=50');

  async function refresh() {
    const card = view.querySelector('#card');
    const params = new URLSearchParams({ page: state.page });
    if (state.company_id) params.set('company_id', state.company_id);
    if (state.action) params.set('action', state.action);
    const data = await api.get(`/platform/audit?${params}`);

    card.innerHTML = `
      <div class="toolbar" style="padding:14px 14px 0">
        <select class="input" id="f-company" style="width:220px">
          <option value="">Todas as empresas</option>
          ${optionsHtml(companies.items, state.company_id)}
        </select>
        <select class="input" id="f-action" style="width:260px">
          <option value="">Todas as ações</option>
          ${Object.entries(ACTION_LABELS).map(([v, l]) => `<option value="${v}" ${state.action === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      ${dataTable([
        { label: 'Quando', render: (a) => `<span class="td-sub">${esc(fmtDateTime(a.created_at))}</span>` },
        { label: 'Usuário', render: (a) => `<div class="td-main">${esc(a.user_name || '—')}</div><div class="td-sub">${esc(a.user_email || '')}</div>` },
        { label: 'Empresa', render: (a) => esc(a.company_name || 'Plataforma') },
        { label: 'Ação', render: (a) => esc(ACTION_LABELS[a.action] || a.action) },
        { label: 'IP', render: (a) => `<span class="td-sub">${esc(a.ip || '—')}</span>` },
      ], data.items, 'Nenhum evento registrado com esses filtros.')}
      ${pagination({ ...data, onPage: (p) => { state.page = p; refresh(); } })}`;

    card.querySelector('#f-company').addEventListener('change', (e) => {
      state.company_id = e.target.value; state.page = 1; refresh();
    });
    card.querySelector('#f-action').addEventListener('change', (e) => {
      state.action = e.target.value; state.page = 1; refresh();
    });
  }

  await refresh();
}
