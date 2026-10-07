/**
 * Notificações — central interna (v3.4).
 */

import { api } from '../api.js';
import { esc, icon, toast, dataTable, pagination, fmtDateTime } from '../ui.js';

const TYPE_LABEL = {
  task_assigned: 'Tarefa atribuída', task_due: 'Tarefa a vencer', task_overdue: 'Tarefa atrasada',
  agenda_created: 'Compromisso criado', agenda_reminder: 'Lembrete de agenda',
  checklist_assigned: 'Checklist atribuído', checklist_due: 'Checklist a vencer', checklist_overdue: 'Checklist atrasado',
  financial_overdue: 'Financeiro vencido', target_reached: 'Meta atingida', system: 'Sistema',
};
const PRIORITY_LABEL = { low: 'Baixa', normal: 'Normal', high: 'Alta', urgent: 'Urgente' };
const PRIORITY_CLS = { low: 'inactive', normal: 'active', high: 'suspended', urgent: 'suspended' };

const state = { page: 1, filters: { read: '', type: '' } };

export async function render(view) {
  view.innerHTML = `
    <div class="page-head">
      <div><h2>Notificações</h2><p>Central de avisos da sua empresa.</p></div>
      <div class="spacer"></div>
      <button class="btn" id="btn-read-all">${icon('check')} Marcar todas como lidas</button>
    </div>
    <div class="toolbar">
      <select class="input" id="f-read">
        <option value="">Todas</option>
        <option value="unread">Não lidas</option>
        <option value="read">Lidas</option>
      </select>
      <select class="input" id="f-type">
        <option value="">Todos os tipos</option>
        ${Object.entries(TYPE_LABEL).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
      </select>
    </div>
    <div class="card" style="margin-top:14px" id="nt-card"><div class="loading-line">Carregando…</div></div>
  `;

  view.querySelector('#f-read').addEventListener('change', (e) => { state.filters.read = e.target.value; state.page = 1; refresh(); });
  view.querySelector('#f-type').addEventListener('change', (e) => { state.filters.type = e.target.value; state.page = 1; refresh(); });
  view.querySelector('#btn-read-all').addEventListener('click', async () => {
    try {
      const r = await api.post('/notifications/read-all', {});
      toast(r.updated ? `${r.updated} notificação(ões) marcada(s) como lida(s).` : 'Nada para marcar.');
      refresh();
    } catch (err) { toast(err.message, 'error'); }
  });
  await refresh();

  async function refresh() {
    const card = view.querySelector('#nt-card');
    card.innerHTML = '<div class="loading-line">Carregando…</div>';
    const q = new URLSearchParams({ page: state.page, per_page: 15 });
    for (const [k, v] of Object.entries(state.filters)) if (v) q.set(k, v);
    let data;
    try { data = await api.get(`/notifications?${q}`); }
    catch (err) { card.innerHTML = `<div class="empty-state">${icon('ban')}<p>${esc(err.message)}</p></div>`; return; }

    card.innerHTML = dataTable([
      { label: '', render: (n) => `<span class="badge badge-${n.read_at ? 'inactive' : 'active'}">${n.read_at ? 'lida' : 'nova'}</span>` },
      { label: 'Notificação', render: (n) => `<strong>${esc(n.title)}</strong>${n.message ? `<br><span class="muted">${esc(n.message)}</span>` : ''}` },
      { label: 'Tipo', render: (n) => esc(TYPE_LABEL[n.type] || n.type) },
      { label: 'Prioridade', render: (n) => `<span class="badge badge-${PRIORITY_CLS[n.priority] || 'inactive'}">${esc(PRIORITY_LABEL[n.priority] || n.priority)}</span>` },
      { label: 'Quando', render: (n) => fmtDateTime(n.created_at) },
      { label: '', class: 'actions', render: (n) => `
          ${n.action_url ? `<button class="btn btn-sm" data-open="${n.id}" data-url="${esc(n.action_url)}">Abrir</button>` : ''}
          ${!n.read_at ? `<button class="btn btn-sm" data-read="${n.id}">Marcar lida</button>` : ''}` },
    ], data.items, 'Nenhuma notificação.')
      + pagination({ page: state.page, perPage: 15, total: data.total, onPage: (p) => { state.page = p; refresh(); } });

    card.querySelectorAll('.page-btn').forEach((b) => b.addEventListener('click', () => { state.page = Number(b.dataset.page); refresh(); }));
    card.querySelectorAll('[data-read]').forEach((b) => b.addEventListener('click', async () => {
      try { await api.post(`/notifications/${b.dataset.read}/read`); refresh(); }
      catch (err) { toast(err.message, 'error'); }
    }));
    card.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', async () => {
      try { await api.post(`/notifications/${b.dataset.open}/read`); } catch { /* já lida */ }
      location.hash = b.dataset.url.startsWith('#/') ? b.dataset.url.slice(1) : b.dataset.url;
    }));
  }
}
