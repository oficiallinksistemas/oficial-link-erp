/**
 * Dashboard inicial — indicadores enxutos, hierarquia clara e pronta
 * para receber vendas, metas, tarefas e alertas nos próximos módulos.
 */

import { api } from '../api.js';
import { session } from '../app.js';
import { esc, fmtDateTime, icon } from '../ui.js';

const ACTION_LABELS = {
  'auth.login': 'entrou no sistema',
  'auth.login_failed': 'teve uma tentativa de acesso recusada',
  'auth.login_blocked': 'teve o acesso bloqueado (usuário inativo)',
  'auth.password_changed': 'alterou a própria senha',
  'user.create': 'cadastrou um usuário',
  'user.update': 'atualizou um usuário',
  'user.reset_password': 'redefiniu a senha de um usuário',
  'store.create': 'cadastrou uma loja',
  'store.update': 'atualizou uma loja',
  'company.update': 'atualizou os dados da empresa',
  'platform.company.create': 'cadastrou uma empresa',
  'platform.company.update': 'atualizou uma empresa',
};

const STAT_ICONS = ['store', 'user', 'shield', 'clock'];

export async function render(view) {
  const me = session.me;
  const summary = await api.get('/dashboard/summary');

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';

  const cards = summary.cards.map((c, i) => `
    <div class="card stat-card">
      <span class="stat-ico">${icon(STAT_ICONS[i % STAT_ICONS.length])}</span>
      <span class="stat-label">${esc(c.label)}</span>
      <span class="stat-value ${c.key === 'my_role' || c.key === 'last_login' ? 'small' : ''}">${esc(c.value)}</span>
      ${c.hint ? `<span class="stat-hint">${esc(c.hint)}</span>` : ''}
    </div>`).join('');

  const activity = (summary.recent_activity || []).map((a) => `
    <li>
      <span class="activity-ico">${icon('activity')}</span>
      <div class="activity-body">
        <div><strong>${esc(a.user_name || 'Sistema')}</strong>
          ${esc(ACTION_LABELS[a.action] || 'registrou uma atividade')}
          ${a.company_name ? ` em <strong>${esc(a.company_name)}</strong>` : ''}
        </div>
        <div class="when">${esc(fmtDateTime(a.created_at))}</div>
      </div>
    </li>`).join('');

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h2>${greeting}, ${esc(me.user.name.split(' ')[0])}.</h2>
        <p>${summary.scope === 'platform'
          ? 'Visão geral da plataforma Oficial Link ERP.'
          : `Resumo de hoje · ${esc(summary.company.name)}${summary.my_store ? ' · ' + esc(summary.my_store.name) : ''}`}</p>
      </div>
    </div>

    <div class="cards-grid">${cards}</div>

    <div class="dashboard-grid">
      <div class="card">
        <div class="card-pad">
          <h3 class="card-title">Atividade recente</h3>
          <p class="card-sub">Últimos eventos registrados no sistema${summary.scope === 'company' ? ' da sua empresa' : ''}.</p>
          ${activity
            ? `<ul class="activity-list">${activity}</ul>`
            : '<div class="empty-state"><p>Ainda não há atividades registradas.</p></div>'}
        </div>
      </div>
      <div class="card">
        <div class="card-pad">
          <h3 class="card-title">Sua conta</h3>
          <p class="card-sub">Resumo do seu acesso.</p>
          <ul class="activity-list">
            <li><span class="activity-ico">${icon('user')}</span><div class="activity-body">
              <div><strong>${esc(me.user.name)}</strong></div><div class="when">${esc(me.user.email)}</div></div></li>
            <li><span class="activity-ico">${icon('shield')}</span><div class="activity-body">
              <div>Função: <strong>${esc(me.role.name)}</strong></div>
              <div class="when">${me.permissions.length} permissões concedidas</div></div></li>
            <li><span class="activity-ico">${icon('clock')}</span><div class="activity-body">
              <div>Último acesso</div><div class="when">${esc(fmtDateTime(me.user.lastLoginAt))}</div></div></li>
            ${me.company ? `<li><span class="activity-ico">${icon('building')}</span><div class="activity-body">
              <div>Empresa: <strong>${esc(me.company.name)}</strong></div>
              <div class="when">${me.store ? 'Loja: ' + esc(me.store.name) : 'Sem loja vinculada'}</div></div></li>` : `
            <li><span class="activity-ico">${icon('globe')}</span><div class="activity-body">
              <div><strong>Plataforma Oficial Link</strong></div>
              <div class="when">Acesso global de administração</div></div></li>`}
          </ul>
        </div>
      </div>
    </div>

    <div class="roadmap-note">
      <strong>Em breve:</strong> Vendas, Metas, Ranking de vendedores, Solicitações,
      Contas a pagar, Tarefas e Relatórios — a arquitetura já está preparada para recebê-los.
    </div>`;
}
