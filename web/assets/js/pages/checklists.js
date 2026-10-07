/**
 * Checklists — rotinas operacionais V1 (v3.4).
 * Progresso vem calculado do backend; conclusão bloqueada por item
 * obrigatório pendente é regra do servidor (o botão só reflete o estado).
 */

import { api } from '../api.js';
import { session } from '../app.js';
import {
  esc, icon, toast, openModal, confirmDialog, dataTable,
  pagination, fmtDate, fmtDateTime,
} from '../ui.js';

const STATUS_LABEL = { pending: 'Pendente', in_progress: 'Em andamento', completed: 'Concluído', canceled: 'Cancelado' };
const state = { page: 1, filters: { search: '', status: '' } };

const can = (p) => session.hasPerm(p);

function statusBadge(s) {
  const cls = { pending: 'active', in_progress: 'suspended', completed: 'active', canceled: 'inactive' }[s] || 'inactive';
  return `<span class="badge badge-${cls}">${esc(STATUS_LABEL[s] || s)}</span>`;
}
function progressBar(cl) {
  return `<div style="min-width:120px">
    <div class="progress"><span style="width:${cl.progress}%"></span></div>
    <span class="progress-label">${cl.progress}% · ${cl.items_done}/${cl.items_total}</span>
  </div>`;
}

export async function render(view) {
  view.innerHTML = `
    <div class="page-head">
      <div><h2>Checklists</h2><p>Rotinas, conferências e processos internos.</p></div>
      <div class="spacer"></div>
      ${can('checklists.create') ? `<button class="btn btn-primary" id="btn-new">${icon('check')} Novo checklist</button>` : ''}
    </div>
    <div class="toolbar">
      <input class="input" id="f-search" placeholder="Buscar checklist">
      <select class="input" id="f-status">
        <option value="">Todos os status</option>
        <option value="pending">Pendente</option><option value="in_progress">Em andamento</option>
        <option value="completed">Concluído</option><option value="canceled">Cancelado</option>
      </select>
    </div>
    <div class="card" style="margin-top:14px" id="cl-card"><div class="loading-line">Carregando…</div></div>
  `;

  view.querySelector('#f-search').addEventListener('change', (e) => { state.filters.search = e.target.value.trim(); state.page = 1; refresh(); });
  view.querySelector('#f-status').addEventListener('change', (e) => { state.filters.status = e.target.value; state.page = 1; refresh(); });
  view.querySelector('#btn-new')?.addEventListener('click', () => openCreateModal(refresh));
  await refresh();

  async function refresh() {
    const card = view.querySelector('#cl-card');
    card.innerHTML = '<div class="loading-line">Carregando…</div>';
    const q = new URLSearchParams({ page: state.page, per_page: 10 });
    for (const [k, v] of Object.entries(state.filters)) if (v) q.set(k, v);
    let data;
    try { data = await api.get(`/checklists?${q}`); }
    catch (err) { card.innerHTML = `<div class="empty-state">${icon('ban')}<p>${esc(err.message)}</p></div>`; return; }

    card.innerHTML = dataTable([
      { label: 'Checklist', render: (c) => `<strong>${esc(c.title)}</strong>${c.template_name ? `<br><span class="muted">${esc(c.template_name)}</span>` : ''}` },
      { label: 'Progresso', render: progressBar },
      { label: 'Status', render: (c) => statusBadge(c.status) },
      { label: 'Responsável', render: (c) => esc(c.assigned_to_name || '—') },
      { label: 'Prazo', render: (c) => (c.due_date ? fmtDate(c.due_date) : '—') },
      { label: '', class: 'actions', render: (c) => {
        const out = [];
        if (['pending', 'in_progress'].includes(c.status)) {
          if (can('checklists.complete')) out.push(`<button class="btn btn-sm btn-primary" data-exec="${c.id}">Executar</button>`);
          if (can('checklists.edit')) out.push(`<button class="btn btn-sm" data-edit="${c.id}">Editar</button>`);
          if (can('checklists.delete')) out.push(`<button class="btn btn-sm btn-danger" data-del="${c.id}">Excluir</button>`);
        } else if (c.status === 'completed') {
          out.push('<span class="muted">concluído ' + esc(fmtDateTime(c.completed_at).split(' ')[0] || '') + '</span>');
        }
        return out.join(' ');
      } },
    ], data.items, 'Nenhum checklist encontrado.')
      + pagination({ page: state.page, perPage: 10, total: data.total, onPage: (p) => { state.page = p; refresh(); } });

    card.querySelectorAll('.page-btn').forEach((b) => b.addEventListener('click', () => { state.page = Number(b.dataset.page); refresh(); }));
    card.querySelectorAll('[data-exec]').forEach((b) => b.addEventListener('click', () => openExecModal(Number(b.dataset.exec), refresh)));
    card.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openEditModal(Number(b.dataset.edit), refresh)));
    card.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!await confirmDialog('Excluir este checklist? Ação irreversível.', { danger: true, confirmLabel: 'Excluir' })) return;
      try { await api.delete(`/checklists/${b.dataset.del}`); toast('Checklist excluído.'); refresh(); }
      catch (err) { toast(err.message, 'error'); }
    }));
  }
}

async function userOptions(selected) {
  const users = await api.get('/users?per_page=100');
  return users.items.map((u) => `<option value="${u.id}" ${u.id === selected ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
}

function openCreateModal(done) {
  let items = [{ title: '', required: 1 }];
  openModal({
    title: 'Novo checklist',
    submitLabel: 'Criar checklist',
    wide: true,
    bodyHtml: `
      <div class="form-grid">
        <div class="field full"><label>Título *</label>
          <input class="input" name="title" required minlength="3" maxlength="120"></div>
        <div class="field"><label>Responsável</label>
          <select class="input" name="assigned_to_user_id" id="cl-user"><option value="">—</option></select></div>
        <div class="field"><label>Prazo</label>
          <input class="input" type="date" name="due_date"></div>
      </div>
      <h3 style="margin:14px 0 8px">Itens</h3>
      <div id="cl-items"></div>
      <button type="button" class="btn btn-sm" id="cl-add-item">+ Adicionar item</button>
      <p class="muted" style="margin:8px 0 0">Itens obrigatórios impedem a conclusão enquanto pendentes.</p>
    `,
    onSubmit: async (d, close) => {
      const its = collectItems();
      if (!its.length) { toast('Informe ao menos 1 item.', 'error'); return; }
      try {
        await api.post('/checklists', {
          title: d.title, assigned_to_user_id: d.assigned_to_user_id || null,
          due_date: d.due_date || null, items: its,
        });
        toast('Checklist criado.');
        close(); done?.();
      } catch (err) { toast(err.message, 'error'); }
    },
  });
  userOptions().then((h) => { document.getElementById('cl-user').innerHTML = `<option value="">—</option>` + h; });
  const box = document.getElementById('cl-items');
  const renderItems = () => {
    box.innerHTML = items.map((it, i) => `
      <div style="display:flex;gap:8px;margin-bottom:8px;align-items:center">
        <input class="input" data-i="${i}" data-f="title" placeholder="Item ${i + 1}" value="${esc(it.title)}" style="flex:1">
        <label style="white-space:nowrap;font-size:12px"><input type="checkbox" data-i="${i}" data-f="required" ${it.required ? 'checked' : ''}> obrig.</label>
        <button type="button" class="btn btn-sm btn-danger" data-rm="${i}" ${items.length <= 1 ? 'disabled' : ''}>×</button>
      </div>`).join('');
    box.querySelectorAll('input').forEach((inp) => inp.addEventListener('input', () => {
      items[Number(inp.dataset.i)][inp.dataset.f] = inp.dataset.f === 'required' ? (inp.checked ? 1 : 0) : inp.value;
    }));
    box.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { items.splice(Number(b.dataset.rm), 1); renderItems(); }));
  };
  const collectItems = () => box ? items.map((it) => ({ title: it.title.trim(), required: it.required })).filter((it) => it.title.length >= 2) : [];
  renderItems();
  document.getElementById('cl-add-item').addEventListener('click', () => { items.push({ title: '', required: 0 }); renderItems(); });
}

async function openEditModal(id, done) {
  let cl;
  try { cl = await api.get(`/checklists/${id}`); }
  catch (err) { toast(err.message, 'error'); return; }
  openModal({
    title: 'Editar checklist',
    submitLabel: 'Salvar',
    bodyHtml: `
      <div class="form-grid">
        <div class="field full"><label>Título *</label>
          <input class="input" name="title" required minlength="3" maxlength="120" value="${esc(cl.title)}"></div>
        <div class="field"><label>Responsável</label>
          <select class="input" name="assigned_to_user_id" id="cl-user"><option value="">—</option></select></div>
        <div class="field"><label>Prazo</label>
          <input class="input" type="date" name="due_date" value="${esc(cl.due_date || '')}"></div>
      </div>
    `,
    onSubmit: async (d, close) => {
      try {
        await api.patch(`/checklists/${id}`, {
          title: d.title, assigned_to_user_id: d.assigned_to_user_id || null,
          due_date: d.due_date || null, status: cl.status,
        });
        toast('Checklist atualizado.');
        close(); done?.();
      } catch (err) { toast(err.message, 'error'); }
    },
  });
  userOptions(cl.assigned_to_user_id).then((h) => { document.getElementById('cl-user').innerHTML = `<option value="">—</option>` + h; });
}

async function openExecModal(id, done) {
  let cl;
  try { cl = await api.get(`/checklists/${id}`); }
  catch (err) { toast(err.message, 'error'); return; }
  const missingRequired = cl.items.filter((i) => i.required && !i.completed).length;

  openModal({
    title: `Executar — ${cl.title}`,
    submitLabel: 'Concluir checklist',
    readonly: !can('checklists.complete'),
    wide: true,
    bodyHtml: `
      <div style="margin-bottom:12px">${progressBar(cl)}</div>
      <div id="exec-items">
        ${cl.items.map((it) => `
          <div class="check-item ${it.completed ? 'done' : ''}" data-item="${it.id}" role="button" tabindex="0">
            <span class="check-box">${it.completed ? icon('check') : ''}</span>
            <span style="flex:1">
              <div class="check-title">${esc(it.title)} ${it.required ? '<span class="badge badge-suspended">obrigatório</span>' : ''}</div>
              ${it.description ? `<div class="check-desc">${esc(it.description)}</div>` : ''}
            </span>
          </div>`).join('') || `<div class="empty-state">${icon('list')} Sem itens.</div>`}
      </div>
      <p class="muted" id="exec-hint">${missingRequired ? `${missingRequired} item(ns) obrigatório(s) pendente(s) — conclusão bloqueada até marcá-los.` : 'Todos os itens obrigatórios concluídos — pronto para concluir.'}</p>
    `,
    onSubmit: async (d, close) => {
      try {
        await api.post(`/checklists/${id}/complete`);
        toast('Checklist concluído.');
        close(); done?.();
      } catch (err) { toast(err.message, 'error'); }
    },
  });

  if (!can('checklists.complete')) return; // modal readonly: só visualização
  document.querySelectorAll('#exec-items .check-item').forEach((el) => {
    el.addEventListener('click', async () => {
      const itemId = Number(el.dataset.item);
      const it = cl.items.find((x) => x.id === itemId);
      try {
        const updated = await api.post(`/checklists/${id}/items/${itemId}/toggle`, { completed: !it.completed });
        el.classList.toggle('done', !it.completed);
        el.querySelector('.check-box').innerHTML = !it.completed ? icon('check') : '';
        it.completed = !it.completed ? 1 : 0;
        cl.items_done = updated.items_done; cl.items_total = updated.items_total; cl.progress = updated.progress;
        document.querySelector('.progress > span').style.width = `${updated.progress}%`;
        document.querySelector('.progress-label').textContent = `${updated.progress}% · ${updated.items_done}/${updated.items_total}`;
        const missing = cl.items.filter((i) => i.required && !i.completed).length;
        document.getElementById('exec-hint').textContent = missing
          ? `${missing} item(ns) obrigatório(s) pendente(s) — conclusão bloqueada até marcá-los.`
          : 'Todos os itens obrigatórios concluídos — pronto para concluir.';
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}
