/**
 * Lojas — unidades da empresa. CRUD paginado com escopo automático por empresa.
 */

import { api } from '../api.js';
import { session } from '../app.js';
import { esc, toast, badge, dataTable, pagination, openModal, debounce } from '../ui.js';

const state = { page: 1, search: '' };

export async function render(view) {
  const canManage = session.hasPerm('stores.manage');
  view.innerHTML = `
    <div class="page-head">
      <div>
        <h2>Lojas</h2>
        <p>Unidades operacionais da sua empresa.</p>
      </div>
      <div class="spacer"></div>
      ${canManage ? '<button class="btn btn-primary" id="new-store">+ Nova loja</button>' : ''}
    </div>
    <div class="card" id="stores-card"><div class="loading-line">Carregando…</div></div>`;

  async function refresh() {
    const card = view.querySelector('#stores-card');
    const stores = await api.get(`/stores?page=${state.page}&search=${encodeURIComponent(state.search)}`);

    card.innerHTML = `
      <div class="toolbar" style="padding:14px 14px 0">
        <input class="input" id="search" placeholder="Buscar por nome, código ou cidade…" value="${esc(state.search)}">
      </div>
      ${dataTable([
        { label: 'Nome', render: (s) => `<div class="td-main">${esc(s.name)}</div><div class="td-sub">Cód. ${esc(s.code)}</div>` },
        { label: 'Cidade/UF', render: (s) => esc([s.city, s.state].filter(Boolean).join(' / ') || '—') },
        { label: 'Status', render: (s) => badge(s.status) },
        ...(canManage ? [{ label: '', class: 'td-actions', render: (s) => `<button class="btn-link" data-edit="${s.id}">Editar</button>` }] : []),
      ], stores.items)}
      ${pagination({ ...stores, onPage: (p) => { state.page = p; refresh(); } })}`;

    card.querySelector('#search').addEventListener('input', debounce((e) => {
      state.search = e.target.value.trim();
      state.page = 1;
      refresh();
    }));

    card.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      const store = stores.items.find((s) => s.id === Number(b.dataset.edit));
      openModal({
        title: `Editar loja — ${store.name}`,
        bodyHtml: `
          <div class="form-grid">
            <div class="field full">
              <label>Nome</label>
              <input class="input" name="name" value="${esc(store.name)}" required minlength="2" maxlength="120">
            </div>
            <div class="field">
              <label>Cidade</label>
              <input class="input" name="city" value="${esc(store.city || '')}" maxlength="80">
            </div>
            <div class="field">
              <label>UF</label>
              <input class="input" name="state" value="${esc(store.state || '')}" maxlength="2" style="text-transform:uppercase">
            </div>
            <div class="field full">
              <label>Status</label>
              <select class="input" name="status">
                <option value="active" ${store.status === 'active' ? 'selected' : ''}>Ativa</option>
                <option value="inactive" ${store.status === 'inactive' ? 'selected' : ''}>Inativa</option>
              </select>
            </div>
          </div>`,
        submitLabel: 'Salvar alterações',
        onSubmit: async (data) => {
          await api.patch(`/stores/${store.id}`, {
            name: data.name,
            city: data.city,
            state: data.state ? data.state.toUpperCase() : null,
            status: data.status,
          });
          toast('Loja atualizada.');
          await refresh();
        },
      });
    }));
  }

  const newBtn = view.querySelector('#new-store');
  if (newBtn) {
    newBtn.addEventListener('click', () => {
      openModal({
        title: 'Nova loja',
        bodyHtml: `
          <div class="form-grid">
            <div class="field full">
              <label>Nome</label>
              <input class="input" name="name" required minlength="2" maxlength="120" placeholder="Ex.: Anjos Balsas">
            </div>
            <div class="field">
              <label>Código interno</label>
              <input class="input" name="code" required minlength="2" maxlength="30" style="text-transform:uppercase" placeholder="BALSAS">
            </div>
            <div class="field">
              <label>UF</label>
              <input class="input" name="state" maxlength="2" style="text-transform:uppercase" placeholder="MA">
            </div>
            <div class="field full">
              <label>Cidade</label>
              <input class="input" name="city" maxlength="80" placeholder="Balsas">
            </div>
          </div>`,
        submitLabel: 'Cadastrar loja',
        onSubmit: async (data) => {
          await api.post('/stores', {
            name: data.name,
            code: data.code.toUpperCase(),
            city: data.city || null,
            state: data.state ? data.state.toUpperCase() : null,
          });
          toast('Loja cadastrada.');
          state.page = 1;
          await refresh();
        },
      });
    });
  }

  await refresh();
}
