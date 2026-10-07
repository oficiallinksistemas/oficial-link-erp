/**
 * Usuários — listagem paginada, cadastro, edição, status e redefinição de senha.
 * Botões dependem da permissão users.manage; a API reforça a mesma regra no servidor.
 */

import { api } from '../api.js';
import { session } from '../app.js';
import { esc, toast, badge, dataTable, pagination, openModal, confirmDialog, debounce, fmtDateTime, optionsHtml } from '../ui.js';

const state = { page: 1, search: '' };

async function loadData() {
  const [users, roles, stores] = await Promise.all([
    api.get(`/users?page=${state.page}&search=${encodeURIComponent(state.search)}`),
    api.get('/roles'),
    api.get('/stores?per_page=50'),
  ]);
  return { users, roles, stores };
}

function userFormHtml({ roles, stores, user = null, currentUserId }) {
  const canRole = !user || user.id !== currentUserId;
  const storeOpts = `<option value="">— Sem loja —</option>` +
    stores.items.map((s) => `<option value="${s.id}" ${user && user.store_id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  return `
    <div class="form-grid">
      <div class="field full">
        <label>Nome completo</label>
        <input class="input" name="name" value="${esc(user?.name || '')}" required minlength="2" maxlength="120">
      </div>
      ${!user ? `
      <div class="field full">
        <label>E-mail</label>
        <input class="input" type="email" name="email" required maxlength="190" placeholder="nome@empresa.com.br">
      </div>
      <div class="field full">
        <label>Senha inicial</label>
        <input class="input" type="password" name="password" required minlength="8" autocomplete="new-password">
        <div class="hint">Mínimo de 8 caracteres. Peça para o usuário trocar após o primeiro acesso.</div>
      </div>` : ''}
      <div class="field">
        <label>Função</label>
        <select class="input" name="role_slug" ${canRole ? '' : 'disabled'}>
          ${optionsHtml(roles, user?.role_slug || 'seller', { value: 'slug', label: 'name' })}
        </select>
        ${canRole ? '' : '<div class="hint">Você não pode alterar a própria função.</div>'}
      </div>
      <div class="field">
        <label>Loja</label>
        <select class="input" name="store_id">${storeOpts}</select>
      </div>
      ${user ? `
      <div class="field full">
        <label>Status</label>
        <select class="input" name="status" ${user.id === currentUserId ? 'disabled' : ''}>
          <option value="active" ${user.status === 'active' ? 'selected' : ''}>Ativo</option>
          <option value="inactive" ${user.status === 'inactive' ? 'selected' : ''}>Inativo</option>
        </select>
      </div>` : ''}
    </div>`;
}

export async function render(view) {
  const canManage = session.hasPerm('users.manage');
  view.innerHTML = `
    <div class="page-head">
      <div>
        <h2>Usuários</h2>
        <p>Pessoas com acesso ao sistema da sua empresa.</p>
      </div>
      <div class="spacer"></div>
      ${canManage ? '<button class="btn btn-primary" id="new-user">+ Novo usuário</button>' : ''}
    </div>
    <div class="card" id="users-card"><div class="loading-line">Carregando…</div></div>`;

  async function refresh() {
    const card = view.querySelector('#users-card');
    const { users, roles, stores } = await loadData();

    card.innerHTML = `
      <div class="toolbar" style="padding:14px 14px 0">
        <input class="input" id="search" placeholder="Buscar por nome ou e-mail…" value="${esc(state.search)}">
      </div>
      ${dataTable([
        { label: 'Nome', render: (u) => `<div class="td-main">${esc(u.name)}</div><div class="td-sub">${esc(u.email)}</div>` },
        { label: 'Função', render: (u) => esc(u.role_name) },
        { label: 'Loja', render: (u) => esc(u.store_name || '—') },
        { label: 'Status', render: (u) => badge(u.status) },
        { label: 'Último acesso', render: (u) => `<span class="td-sub">${esc(fmtDateTime(u.last_login_at))}</span>` },
        ...(canManage ? [{ label: '', class: 'td-actions', render: (u) => `
          <button class="btn-link" data-edit="${u.id}">Editar</button>
          <button class="btn-link" data-pass="${u.id}">Redefinir senha</button>
        ` }] : []),
      ], users.items)}
      ${pagination({ ...users, onPage: (p) => { state.page = p; refresh(); } })}`;

    card.querySelector('#search').addEventListener('input', debounce((e) => {
      state.search = e.target.value.trim();
      state.page = 1;
      refresh();
    }));

    card.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      const user = users.items.find((u) => u.id === Number(b.dataset.edit));
      openModal({
        title: `Editar usuário — ${user.name}`,
        bodyHtml: userFormHtml({ roles, stores, user, currentUserId: session.me.user.id }),
        submitLabel: 'Salvar alterações',
        onSubmit: async (data) => {
          const payload = { name: data.name, role_slug: data.role_slug, store_id: data.store_id || null };
          if (user.id !== session.me.user.id) payload.status = data.status;
          await api.patch(`/users/${user.id}`, payload);
          toast('Usuário atualizado.');
          await refresh();
        },
      });
    }));

    card.querySelectorAll('[data-pass]').forEach((b) => b.addEventListener('click', () => {
      const user = users.items.find((u) => u.id === Number(b.dataset.pass));
      openModal({
        title: `Redefinir senha — ${user.name}`,
        bodyHtml: `
          <div class="field">
            <label>Nova senha</label>
            <input class="input" type="password" name="password" required minlength="8" autocomplete="new-password">
            <div class="hint">Mínimo de 8 caracteres. O usuário será obrigado a trocar esta senha no próximo acesso e suas sessões serão encerradas.</div>
          </div>`,
        submitLabel: 'Redefinir',
        onSubmit: async (data) => {
          await api.post(`/users/${user.id}/reset-password`, { password: data.password });
          toast('Senha redefinida. Sessões encerradas.');
        },
      });
    }));
  }

  const newBtn = view.querySelector('#new-user');
  if (newBtn) {
    newBtn.addEventListener('click', async () => {
      const { roles, stores } = await loadData();
      openModal({
        title: 'Novo usuário',
        bodyHtml: userFormHtml({ roles, stores, user: null, currentUserId: session.me.user.id }),
        submitLabel: 'Cadastrar usuário',
        onSubmit: async (data) => {
          await api.post('/users', {
            name: data.name,
            email: data.email,
            password: data.password,
            role_slug: data.role_slug,
            store_id: data.store_id ? Number(data.store_id) : null,
          });
          toast('Usuário cadastrado.');
          state.page = 1;
          await refresh();
        },
      });
    });
  }

  await refresh();
}
