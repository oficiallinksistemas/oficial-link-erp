/**
 * Plataforma — Usuários: gestão de usuários de QUALQUER empresa (somente Master).
 * O Master nunca vê senha de ninguém — apenas define nova (com troca obrigatória)
 * e revoga sessões.
 */

import { api } from '../api.js';
import { session } from '../app.js';
import {
  esc, toast, badge, dataTable, pagination, openModal, confirmDialog,
  debounce, fmtDateTime, optionsHtml,
} from '../ui.js';

const state = { page: 1, search: '', company_id: '' };

export async function render(view) {
  const canManage = session.hasPerm('platform.users.manage');
  view.innerHTML = `
    <div class="page-head">
      <div>
        <h2>Usuários da plataforma</h2>
        <p>Todos os usuários de todas as empresas.</p>
      </div>
      <div class="spacer"></div>
      ${canManage ? '<button class="btn btn-primary" id="new-user">+ Novo usuário</button>' : ''}
    </div>
    <div class="card" id="card"><div class="loading-line">Carregando…</div></div>`;

  const [roles, companies] = await Promise.all([
    api.get('/roles'),
    api.get('/platform/companies?per_page=50'),
  ]);

  async function storesOf(companyId) {
    if (!companyId) return { items: [] };
    return api.get(`/platform/stores?per_page=50&company_id=${companyId}`);
  }

  async function refresh() {
    const card = view.querySelector('#card');
    const data = await api.get(
      `/platform/users?page=${state.page}&search=${encodeURIComponent(state.search)}${state.company_id ? '&company_id=' + state.company_id : ''}`
    );

    card.innerHTML = `
      <div class="toolbar" style="padding:14px 14px 0">
        <select class="input" id="f-company" style="width:220px">
          <option value="">Todas as empresas</option>
          ${optionsHtml(companies.items, state.company_id)}
        </select>
        <input class="input" id="search" placeholder="Buscar por nome ou e-mail…" value="${esc(state.search)}">
      </div>
      ${dataTable([
        { label: 'Nome', render: (u) => `<div class="td-main">${esc(u.name)}</div><div class="td-sub">${esc(u.email)}</div>` },
        { label: 'Empresa', render: (u) => esc(u.company_name) },
        { label: 'Função', render: (u) => esc(u.role_name) },
        { label: 'Loja', render: (u) => esc(u.store_name || '—') },
        { label: 'Status', render: (u) => `${badge(u.status)}${u.must_change_password ? '<div class="td-sub" style="margin-top:2px">trocar senha</div>' : ''}` },
        { label: 'Último acesso', render: (u) => `<span class="td-sub">${esc(fmtDateTime(u.last_login_at))}</span>` },
        ...(canManage ? [{ label: '', class: 'td-actions', render: (u) => `
          <button class="btn-link" data-edit="${u.id}">Editar</button>
          <button class="btn-link" data-pass="${u.id}">Senha</button>
          <button class="btn-link" data-revoke="${u.id}">Encerrar sessões</button>
        ` }] : []),
      ], data.items)}
      ${pagination({ ...data, onPage: (p) => { state.page = p; refresh(); } })}`;

    card.querySelector('#f-company').addEventListener('change', (e) => {
      state.company_id = e.target.value; state.page = 1; refresh();
    });
    card.querySelector('#search').addEventListener('input', debounce((e) => {
      state.search = e.target.value.trim(); state.page = 1; refresh();
    }));

    if (!canManage) return;

    card.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', async () => {
      const user = data.items.find((u) => u.id === Number(b.dataset.edit));
      const stores = await storesOf(user.company_id);
      openModal({
        title: `Editar usuário — ${user.name}`,
        bodyHtml: `
          <div class="form-grid">
            <div class="field full"><label>Nome completo</label>
              <input class="input" name="name" value="${esc(user.name)}" required minlength="2" maxlength="120"></div>
            <div class="field full"><label>E-mail</label>
              <input class="input" type="email" name="email" value="${esc(user.email)}" required maxlength="190"></div>
            <div class="field"><label>Função</label>
              <select class="input" name="role_slug">${optionsHtml(roles, user.role_slug, { value: 'slug', label: 'name' })}</select></div>
            <div class="field"><label>Loja</label>
              <select class="input" name="store_id">
                <option value="">— Sem loja —</option>
                ${optionsHtml(stores.items, user.store_id)}
              </select></div>
            <div class="field full"><label>Status</label>
              <select class="input" name="status">
                <option value="active" ${user.status === 'active' ? 'selected' : ''}>Ativo</option>
                <option value="inactive" ${user.status === 'inactive' ? 'selected' : ''}>Inativo</option>
              </select></div>
          </div>`,
        submitLabel: 'Salvar alterações',
        onSubmit: async (d) => {
          await api.patch(`/platform/users/${user.id}`, {
            name: d.name, email: d.email, role_slug: d.role_slug,
            store_id: d.store_id ? Number(d.store_id) : null, status: d.status,
          });
          toast('Usuário atualizado.');
          await refresh();
        },
      });
    }));

    card.querySelectorAll('[data-pass]').forEach((b) => b.addEventListener('click', () => {
      const user = data.items.find((u) => u.id === Number(b.dataset.pass));
      openModal({
        title: `Redefinir senha — ${user.name}`,
        bodyHtml: `
          <div class="alert alert-warning">O usuário será obrigado a criar uma nova senha
          no próximo acesso. Você nunca verá a senha atual dele.</div>
          <div class="field"><label>Nova senha temporária</label>
            <input class="input" type="password" name="password" required minlength="8" autocomplete="new-password">
            <div class="hint">Mínimo de 8 caracteres. Todas as sessões serão encerradas.</div>
          </div>`,
        submitLabel: 'Redefinir senha',
        onSubmit: async (d) => {
          await api.post(`/platform/users/${user.id}/reset-password`, { password: d.password });
          toast('Senha redefinida. Troca obrigatória no próximo acesso.');
          await refresh();
        },
      });
    }));

    card.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', async () => {
      const user = data.items.find((u) => u.id === Number(b.dataset.revoke));
      const go = await confirmDialog(`Encerrar todas as sessões ativas de ${user.name}? Ele precisará fazer login novamente.`, { confirmLabel: 'Encerrar sessões' });
      if (!go) return;
      await api.post(`/platform/users/${user.id}/revoke-sessions`);
      toast('Sessões encerradas.');
    }));
  }

  const newBtn = view.querySelector('#new-user');
  if (newBtn) {
    newBtn.addEventListener('click', () => {
      if (!companies.items.length) { toast('Cadastre uma empresa primeiro.', 'error'); return; }
      openModal({
        title: 'Novo usuário (plataforma)',
        bodyHtml: `
          <div class="form-grid">
            <div class="field full"><label>Empresa</label>
              <select class="input" name="company_id" id="pu-company">${optionsHtml(companies.items, state.company_id || companies.items[0].id)}</select></div>
            <div class="field full"><label>Nome completo</label>
              <input class="input" name="name" required minlength="2" maxlength="120"></div>
            <div class="field full"><label>E-mail</label>
              <input class="input" type="email" name="email" required maxlength="190"></div>
            <div class="field"><label>Senha inicial</label>
              <input class="input" type="password" name="password" required minlength="8" autocomplete="new-password"></div>
            <div class="field"><label>Função</label>
              <select class="input" name="role_slug">${optionsHtml(roles, 'seller', { value: 'slug', label: 'name' })}</select></div>
            <div class="field full"><label>Loja</label>
              <select class="input" name="store_id" id="pu-store"><option value="">— Sem loja —</option></select></div>
          </div>`,
        submitLabel: 'Cadastrar usuário',
        onSubmit: async (d) => {
          await api.post('/platform/users', {
            company_id: Number(d.company_id), name: d.name, email: d.email,
            password: d.password, role_slug: d.role_slug,
            store_id: d.store_id ? Number(d.store_id) : null,
          });
          toast('Usuário cadastrado. Troca de senha obrigatória no 1º acesso.');
          state.page = 1;
          await refresh();
        },
      });
      // Carrega lojas conforme a empresa selecionada
      const selCompany = document.getElementById('pu-company');
      const selStore = document.getElementById('pu-store');
      const loadStores = async () => {
        const st = await storesOf(selCompany.value);
        selStore.innerHTML = '<option value="">— Sem loja —</option>' + optionsHtml(st.items);
      };
      selCompany.addEventListener('change', loadStores);
      loadStores();
    });
  }

  await refresh();
}
