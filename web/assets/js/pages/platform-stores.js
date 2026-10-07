/**
 * Plataforma — Lojas: gestão de lojas de QUALQUER empresa (somente Master).
 */

import { api } from '../api.js';
import { session } from '../app.js';
import { esc, toast, badge, dataTable, pagination, openModal, debounce, optionsHtml } from '../ui.js';

const state = { page: 1, search: '', company_id: '' };

async function loadCompanies() {
  return (await api.get('/platform/companies?per_page=50')).items;
}

export async function render(view) {
  const canManage = session.hasPerm('platform.stores.manage');
  view.innerHTML = `
    <div class="page-head">
      <div>
        <h2>Lojas da plataforma</h2>
        <p>Todas as lojas de todas as empresas, em um único lugar.</p>
      </div>
      <div class="spacer"></div>
      ${canManage ? '<button class="btn btn-primary" id="new-store">+ Nova loja</button>' : ''}
    </div>
    <div class="card" id="card"><div class="loading-line">Carregando…</div></div>`;

  async function refresh() {
    const card = view.querySelector('#card');
    const [data, companies] = await Promise.all([
      api.get(`/platform/stores?page=${state.page}&search=${encodeURIComponent(state.search)}${state.company_id ? '&company_id=' + state.company_id : ''}`),
      loadCompanies(),
    ]);

    card.innerHTML = `
      <div class="toolbar" style="padding:14px 14px 0">
        <select class="input" id="f-company" style="width:220px">
          <option value="">Todas as empresas</option>
          ${optionsHtml(companies, state.company_id)}
        </select>
        <input class="input" id="search" placeholder="Buscar por nome, código ou cidade…" value="${esc(state.search)}">
      </div>
      ${dataTable([
        { label: 'Loja', render: (s) => `<div class="td-main">${esc(s.name)}</div><div class="td-sub">Cód. ${esc(s.code)}</div>` },
        { label: 'Empresa', render: (s) => esc(s.company_name) },
        { label: 'Cidade/UF', render: (s) => esc([s.city, s.state].filter(Boolean).join(' / ') || '—') },
        { label: 'Status', render: (s) => badge(s.status) },
        ...(canManage ? [{ label: '', class: 'td-actions', render: (s) => `<button class="btn-link" data-edit="${s.id}">Editar</button>` }] : []),
      ], data.items)}
      ${pagination({ ...data, onPage: (p) => { state.page = p; refresh(); } })}`;

    card.querySelector('#f-company').addEventListener('change', (e) => {
      state.company_id = e.target.value; state.page = 1; refresh();
    });
    card.querySelector('#search').addEventListener('input', debounce((e) => {
      state.search = e.target.value.trim(); state.page = 1; refresh();
    }));

    card.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      const store = data.items.find((s) => s.id === Number(b.dataset.edit));
      openModal({
        title: `Editar loja — ${store.name}`,
        bodyHtml: `
          <div class="form-grid">
            <div class="field full"><label>Nome</label>
              <input class="input" name="name" value="${esc(store.name)}" required minlength="2" maxlength="120"></div>
            <div class="field"><label>Cidade</label>
              <input class="input" name="city" value="${esc(store.city || '')}" maxlength="80"></div>
            <div class="field"><label>UF</label>
              <input class="input" name="state" value="${esc(store.state || '')}" maxlength="2" style="text-transform:uppercase"></div>
            <div class="field full"><label>Status</label>
              <select class="input" name="status">
                <option value="active" ${store.status === 'active' ? 'selected' : ''}>Ativa</option>
                <option value="inactive" ${store.status === 'inactive' ? 'selected' : ''}>Inativa</option>
              </select></div>
          </div>`,
        submitLabel: 'Salvar alterações',
        onSubmit: async (d) => {
          await api.patch(`/platform/stores/${store.id}`, {
            name: d.name, city: d.city || null,
            state: d.state ? d.state.toUpperCase() : null, status: d.status,
          });
          toast('Loja atualizada.');
          await refresh();
        },
      });
    }));
  }

  const newBtn = view.querySelector('#new-store');
  if (newBtn) {
    newBtn.addEventListener('click', async () => {
      const companies = await loadCompanies();
      if (!companies.length) { toast('Cadastre uma empresa primeiro.', 'error'); return; }
      openModal({
        title: 'Nova loja',
        bodyHtml: `
          <div class="form-grid">
            <div class="field full"><label>Empresa</label>
              <select class="input" name="company_id">${optionsHtml(companies, state.company_id || companies[0].id)}</select></div>
            <div class="field full"><label>Nome</label>
              <input class="input" name="name" required minlength="2" maxlength="120"></div>
            <div class="field"><label>Código interno</label>
              <input class="input" name="code" required minlength="2" maxlength="30" style="text-transform:uppercase"></div>
            <div class="field"><label>UF</label>
              <input class="input" name="state" maxlength="2" style="text-transform:uppercase"></div>
            <div class="field full"><label>Cidade</label>
              <input class="input" name="city" maxlength="80"></div>
          </div>`,
        submitLabel: 'Cadastrar loja',
        onSubmit: async (d) => {
          await api.post('/platform/stores', {
            company_id: Number(d.company_id), name: d.name,
            code: d.code.toUpperCase(), city: d.city || null,
            state: d.state ? d.state.toUpperCase() : null,
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
