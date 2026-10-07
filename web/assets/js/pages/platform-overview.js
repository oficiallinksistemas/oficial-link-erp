/**
 * Plataforma — Visão geral: números da operação do SaaS.
 */

import { api } from '../api.js';
import { esc, icon } from '../ui.js';

export async function render(view) {
  const o = await api.get('/platform/overview');

  const card = (label, value, ico) => `
    <div class="card stat-card">
      <span class="stat-ico">${icon(ico)}</span>
      <span class="stat-label">${esc(label)}</span>
      <span class="stat-value">${esc(value)}</span>
    </div>`;

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h2>Visão geral da plataforma</h2>
        <p>Números gerais do Oficial Link ERP.</p>
      </div>
    </div>
    <div class="cards-grid">
      ${card('Empresas cadastradas', o.companies.total, 'building')}
      ${card('Empresas ativas', o.companies.active, 'check')}
      ${card('Empresas suspensas', o.companies.suspended, 'ban')}
      ${card('Lojas no total', o.stores, 'store')}
      ${card('Usuários das empresas', o.users, 'user')}
      ${card('Sessões ativas agora', o.sessions_active, 'activity')}
      ${card('Logins hoje', o.logins_today, 'clock')}
      ${card('Eventos de auditoria hoje', o.audits_today, 'list')}
    </div>
    <div class="roadmap-note">
      <strong>Plataforma:</strong> use o menu ao lado para administrar empresas, lojas,
      usuários, auditoria e configurações de qualquer tenant sem sair da sua conta.
    </div>`;
}
