/**
 * Tarefas — camada operacional V1 (v3.4).
 * Todas as decisões de permissão são do backend; aqui só se escondem botões.
 */

import { api } from '../api.js';
import { session } from '../app.js';
import {
  esc, icon, toast, openModal, confirmDialog, dataTable,
  pagination, fmtDate, fmtDateTime,
} from '../ui.js';

const PRIORITY_LABEL = { low: 'Baixa', medium: 'Média', high: 'Alta', urgent: 'Urgente' };
const PRIORITY_CLS = { low: 'inactive', medium: 'active', high: 'suspended', urgent: 'suspended' };
const STATUS_LABEL = { pending: 'Pendente', in_progress: 'Em andamento', completed: 'Concluída', canceled: 'Cancelada' };

const state = { tab: 'all', page: 1, filters: { search: '', status: '', priority: '', overdue: '' } };

const can = (p) => session.hasPerm(p);

function priorityBadge(p) {
  return `<span class="badge badge-${PRIORITY_CLS[p] || 'inactive'}">${esc(PRIORITY_LABEL[p] || p)}</span>`;
}
function statusBadge(s) {
  const cls = { pending: 'active', in_progress: 'suspended', completed: 'active', canceled: 'inactive' }[s] || 'inactive';
  return `<span class="badge badge-${cls}">${esc(STATUS_LABEL[s] || s)}</span>`;
}

export async function render(view) {
  view.innerHTML = `
    <div class="page-head">
      <div><h2>Tarefas</h2><p>Organize o que precisa ser feito, quem faz e até quando.</p></div>
      <div class="spacer"></div>
      ${can('tasks.create') ? `<button class="btn btn-primary" id="btn-new">${icon('list')} Nova tarefa</button>` : ''}
    </div>
    <div class="toolbar" id="tabs" style="margin-bottom:14px">
      <button class="btn" data-tab="all">Todas</button>
      <button class="btn" data-tab="mine">Minhas tarefas</button>
      <button class="btn" data-tab="overdue">Atrasadas</button>
    </div>
    <div class="toolbar">
      <input class="input" id="f-search" placeholder="Buscar tarefa">
      <select class="input" id="f-status">
        <option value="">Todos os status</option>
        <option value="pending">Pendente</option><option value="in_progress">Em andamento</option>
        <option value="completed">Concluída</option><option value="canceled">Cancelada</option>
      </select>
      <select class="input" id="f-priority">
        <option value="">Todas as prioridades</option>
        <option value="urgent">Urgente</option><option value="high">Alta</option>
        <option value="medium">Média</option><option value="low">Baixa</option>
      </select>
    </div>
    <div class="card" style="margin-top:14px" id="tasks-card"><div class="loading-line">Carregando…</div></div>
  `;

  view.querySelector('#tabs').addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]')?.dataset.tab;
    if (!t || t === state.tab) return;
    state.tab = t; state.page = 1;
    paintTabs(); refresh();
  });
  view.querySelector('#f-search').addEventListener('change', (e) => { state.filters.search = e.target.value.trim(); state.page = 1; refresh(); });
  view.querySelector('#f-status').addEventListener('change', (e) => { state.filters.status = e.target.value; state.page = 1; refresh(); });
  view.querySelector('#f-priority').addEventListener('change', (e) => { state.filters.priority = e.target.value; state.page = 1; refresh(); });
  view.querySelector('#btn-new')?.addEventListener('click', () => openTaskModal(null, refresh));
  paintTabs();
  await refresh();

  function paintTabs() {
    view.querySelectorAll('#tabs [data-tab]').forEach((b) => b.classList.toggle('btn-primary', b.dataset.tab === state.tab));
  }

  async function refresh() {
    const card = view.querySelector('#tasks-card');
    card.innerHTML = '<div class="loading-line">Carregando…</div>';
    const q = new URLSearchParams({ page: state.page, per_page: 10 });
    if (state.tab === 'mine') q.set('mine', '1');
    if (state.tab === 'overdue') q.set('overdue', '1');
    for (const [k, v] of Object.entries(state.filters)) if (v) q.set(k, v);
    let data;
    try { data = await api.get(`/tasks?${q}`); }
    catch (err) { card.innerHTML = `<div class="empty-state">${icon('ban')}<p>${esc(err.message)}</p></div>`; return; }

    const actions = (t) => {
      const out = [];
      if (['pending', 'in_progress'].includes(t.status)) {
        if (can('tasks.complete')) out.push(`<button class="btn btn-sm btn-primary" data-complete="${t.id}">Concluir</button>`);
        if (can('tasks.edit')) out.push(`<button class="btn btn-sm" data-edit="${t.id}">Editar</button>`);
        if (can('tasks.delete')) out.push(`<button class="btn btn-sm btn-danger" data-del="${t.id}">Excluir</button>`);
      } else if (t.status === 'completed' && can('tasks.complete')) {
        out.push(`<button class="btn btn-sm" data-reopen="${t.id}">Reabrir</button>`);
      }
      return out.join(' ');
    };
    const due = (t) => {
      if (!t.due_date) return '—';
      let html = fmtDate(t.due_date);
      if (t.overdue) html += ` <span class="badge badge-suspended">atrasada</span>`;
      else if (t.due_today) html += ` <span class="badge badge-active">hoje</span>`;
      return html;
    };

    card.innerHTML = dataTable([
      { label: 'Tarefa', render: (t) => `<strong>${esc(t.title)}</strong>${t.link_label ? `<br><span class="muted">${esc(t.link_label)}</span>` : ''}` },
      { label: 'Prioridade', render: (t) => priorityBadge(t.priority) },
      { label: 'Status', render: (t) => statusBadge(t.status) },
      { label: 'Responsável', render: (t) => esc(t.assigned_to_name || '—') },
      { label: 'Prazo', render: due },
      { label: '', class: 'actions', render: actions },
    ], data.items, state.tab === 'mine' ? 'Nenhuma tarefa atribuída a você.' : 'Nenhuma tarefa encontrada.')
      + pagination({ page: state.page, perPage: 10, total: data.total, onPage: (p) => { state.page = p; refresh(); } });

    card.querySelectorAll('.page-btn').forEach((b) => b.addEventListener('click', () => { state.page = Number(b.dataset.page); refresh(); }));
    card.querySelectorAll('[data-complete]').forEach((b) => b.addEventListener('click', async () => {
      try { await api.post(`/tasks/${b.dataset.complete}/complete`); toast('Tarefa concluída.'); refresh(); }
      catch (err) { toast(err.message, 'error'); }
    }));
    card.querySelectorAll('[data-reopen]').forEach((b) => b.addEventListener('click', async () => {
      try { await api.post(`/tasks/${b.dataset.reopen}/reopen`); toast('Tarefa reaberta.'); refresh(); }
      catch (err) { toast(err.message, 'error'); }
    }));
    card.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!await confirmDialog('Excluir esta tarefa? Ação irreversível.', { danger: true, confirmLabel: 'Excluir' })) return;
      try { await api.delete(`/tasks/${b.dataset.del}`); toast('Tarefa excluída.'); refresh(); }
      catch (err) { toast(err.message, 'error'); }
    }));
    card.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openTaskModal(Number(b.dataset.edit), refresh)));
  }
}

async function loadUsersStores(selectedUser, selectedStore) {
  const [users, stores] = await Promise.all([api.get('/users?per_page=100'), api.get('/stores')]);
  return {
    userOpts: users.items.map((u) => `<option value="${u.id}" ${u.id === selectedUser ? 'selected' : ''}>${esc(u.name)}</option>`).join(''),
    storeOpts: `<option value="">—</option>` + stores.items.map((s) => `<option value="${s.id}" ${s.id === selectedStore ? 'selected' : ''}>${esc(s.name)}</option>`).join(''),
  };
}

async function openTaskModal(id, done) {
  let t = null;
  if (id) {
    try { t = await api.get(`/tasks/${id}`); }
    catch (err) { toast(err.message, 'error'); return; }
  }
  let opts;
  try { opts = await loadUsersStores(t?.assigned_to_user_id, t?.store_id); }
  catch (err) { toast(err.message, 'error'); return; }
  openModal({
    title: t ? 'Editar tarefa' : 'Nova tarefa',
    submitLabel: t ? 'Salvar' : 'Criar tarefa',
    wide: true,
    bodyHtml: `
      <div class="form-grid">
        <div class="field full"><label>Título *</label>
          <input class="input" name="title" required minlength="3" maxlength="120" value="${esc(t?.title || '')}"></div>
        <div class="field"><label>Prioridade</label>
          <select class="input" name="priority">
            ${Object.entries(PRIORITY_LABEL).map(([v, l]) => `<option value="${v}" ${t?.priority === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select></div>
        <div class="field"><label>Prazo</label>
          <input class="input" type="date" name="due_date" value="${esc(t?.due_date || '')}"></div>
        <div class="field"><label>Responsável</label>
          <select class="input" name="assigned_to_user_id"><option value="">—</option>${opts.userOpts}</select></div>
        <div class="field"><label>Loja</label>
          <select class="input" name="store_id">${opts.storeOpts}</select></div>
        <div class="field full"><label>Descrição</label>
          <textarea class="input" name="description" rows="3" maxlength="1000">${esc(t?.description || '')}</textarea></div>
      </div>
    `,
    onSubmit: async (d, close) => {
      const body = {
        title: d.title, priority: d.priority || 'medium',
        due_date: d.due_date || null,
        assigned_to_user_id: d.assigned_to_user_id || null,
        store_id: d.store_id || null,
        description: d.description || null,
      };
      try {
        if (t) await api.patch(`/tasks/${t.id}`, body);
        else await api.post('/tasks', body);
        toast(t ? 'Tarefa atualizada.' : 'Tarefa criada.');
        close(); done?.();
      } catch (err) { toast(err.message, 'error'); }
    },
  });
}
