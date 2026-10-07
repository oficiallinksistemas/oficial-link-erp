/**
 * Plataforma — gestão de empresas (tenants). Exclusivo do Master.
 * Aqui a Oficial Link cadastra, edita e suspende empresas do SaaS.
 */

import { api } from '../api.js';
import { session } from '../app.js';
import { esc, toast, badge, fmtDate, dataTable, pagination, openModal, confirmDialog, debounce } from '../ui.js';

const state = { page: 1, search: '' };

export async function render(view) {
  const canManage = session.hasPerm('platform.companies.manage');
  view.innerHTML = `
    <div class="page-head">
      <div>
        <h2>Empresas da plataforma</h2>
        <p>Empresas cadastradas no Oficial Link ERP e seus respectivos escopos.</p>
      </div>
      <div class="spacer"></div>
      ${canManage ? '<button class="btn btn-primary" id="new-company">+ Nova empresa</button>' : ''}
    </div>
    <div class="card" id="companies-card"><div class="loading-line">Carregando…</div></div>`;

  async function refresh() {
    const card = view.querySelector('#companies-card');
    const data = await api.get(`/platform/companies?page=${state.page}&search=${encodeURIComponent(state.search)}`);

    card.innerHTML = `
      <div class="toolbar" style="padding:14px 14px 0">
        <input class="input" id="search" placeholder="Buscar por nome ou CNPJ…" value="${esc(state.search)}">
      </div>
      ${dataTable([
        { label: 'Empresa', render: (c) => `<div class="td-main">${esc(c.name)}</div><div class="td-sub">${esc(c.trade_name || '')}</div>` },
        { label: 'CNPJ', render: (c) => `<span class="td-sub">${esc(c.document || '—')}</span>` },
        { label: 'Lojas', render: (c) => String(c.stores_count) },
        { label: 'Usuários', render: (c) => String(c.users_count) },
        { label: 'Status', render: (c) => badge(c.status) },
        { label: 'Desde', render: (c) => `<span class="td-sub">${esc(fmtDate(c.created_at))}</span>` },
        ...(canManage ? [{ label: '', class: 'td-actions', render: (c) => `
          <button class="btn-link" data-edit="${c.id}">Editar</button>
          <button class="btn-link ${c.status === 'active' ? 'danger' : ''}" data-toggle="${c.id}" data-status="${c.status}">
            ${c.status === 'active' ? 'Suspender' : 'Reativar'}
          </button>` }] : []),
      ], data.items, 'Nenhuma empresa cadastrada ainda.')}
      ${pagination({ ...data, onPage: (p) => { state.page = p; refresh(); } })}`;

    card.querySelector('#search').addEventListener('input', debounce((e) => {
      state.search = e.target.value.trim();
      state.page = 1;
      refresh();
    }));

    card.querySelectorAll('[data-detail]').forEach((b) => b.addEventListener('click', async () => {
      const company = await api.get(`/platform/companies/${b.dataset.detail}`);
      openModal({
        title: `Detalhes — ${company.name}`,
        wide: true,
        submitLabel: 'Fechar',
        bodyHtml: `
          <div class="form-grid">
            <div class="card card-pad" style="box-shadow:none">
              <h4 class="card-title" style="font-size:13.5px">Lojas (${company.stores.length})</h4>
              ${company.stores.length ? `<ul class="activity-list">${company.stores.map((s) => `
                <li><span class="activity-ico"></span><div class="activity-body">
                  <div><strong>${esc(s.name)}</strong> <span class="td-sub">(${esc(s.code)})</span></div>
                  <div class="when">${esc([s.city, s.state].filter(Boolean).join(' / ') || '—')} · ${s.status === 'active' ? 'Ativa' : 'Inativa'}</div>
                </div></li>`).join('')}</ul>` : '<div class="td-sub">Nenhuma loja cadastrada.</div>'}
            </div>
            <div class="card card-pad" style="box-shadow:none">
              <h4 class="card-title" style="font-size:13.5px">Usuários (${company.users.length})</h4>
              ${company.users.length ? `<ul class="activity-list">${company.users.map((u) => `
                <li><span class="activity-ico"></span><div class="activity-body">
                  <div><strong>${esc(u.name)}</strong></div>
                  <div class="when">${esc(u.email)} · ${esc(u.role_name)}${u.store_name ? ' · ' + esc(u.store_name) : ''}</div>
                </div></li>`).join('')}</ul>` : '<div class="td-sub">Nenhum usuário cadastrado.</div>'}
            </div>
          </div>`,
        onSubmit: async () => { /* apenas fecha */ },
      });
    }));

    card.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      const company = data.items.find((c) => c.id === Number(b.dataset.edit));
      openModal({
        title: `Editar empresa — ${company.name}`,
        bodyHtml: `
          <div class="form-grid">
            <div class="field full">
              <label>Nome</label>
              <input class="input" name="name" value="${esc(company.name)}" required minlength="2" maxlength="120">
            </div>
            <div class="field full">
              <label>Nome fantasia</label>
              <input class="input" name="trade_name" value="${esc(company.trade_name || '')}" maxlength="120">
            </div>
            <div class="field">
              <label>E-mail</label>
              <input class="input" type="email" name="email" value="${esc(company.email || '')}" maxlength="190">
            </div>
            <div class="field">
              <label>Telefone</label>
              <input class="input" name="phone" value="${esc(company.phone || '')}" maxlength="30">
            </div>
          </div>`,
        submitLabel: 'Salvar alterações',
        onSubmit: async (d) => {
          await api.patch(`/platform/companies/${company.id}`, {
            name: d.name, trade_name: d.trade_name || null, email: d.email || null, phone: d.phone || null,
          });
          toast('Empresa atualizada.');
          await refresh();
        },
      });
    }));

    card.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
      const company = data.items.find((c) => c.id === Number(b.dataset.toggle));
      const suspending = b.dataset.status === 'active';
      const okGo = await confirmDialog(
        suspending
          ? `Suspender “${company.name}”? Todos os usuários dessa empresa perderão o acesso imediatamente.`
          : `Reativar “${company.name}”? Os usuários ativos poderão acessar o sistema novamente.`,
        { danger: suspending, confirmLabel: suspending ? 'Suspender empresa' : 'Reativar empresa' }
      );
      if (!okGo) return;
      await api.patch(`/platform/companies/${company.id}`, { status: suspending ? 'suspended' : 'active' });
      toast(suspending ? 'Empresa suspensa.' : 'Empresa reativada.');
      await refresh();
    }));
  }

  const newBtn = view.querySelector('#new-company');
  if (newBtn) {
    newBtn.addEventListener('click', () => {
      openModal({
        title: 'Nova empresa',
        bodyHtml: `
          <div class="form-grid">
            <div class="field full">
              <label>Nome</label>
              <input class="input" name="name" required minlength="2" maxlength="120" placeholder="Ex.: Anjos">
            </div>
            <div class="field full">
              <label>Nome fantasia</label>
              <input class="input" name="trade_name" maxlength="120">
            </div>
            <div class="field">
              <label>CNPJ</label>
              <input class="input" name="document" maxlength="20" placeholder="00.000.000/0001-00">
            </div>
            <div class="field">
              <label>Telefone</label>
              <input class="input" name="phone" maxlength="30">
            </div>
            <div class="field full">
              <label>E-mail</label>
              <input class="input" type="email" name="email" maxlength="190">
            </div>
          </div>`,
        submitLabel: 'Cadastrar empresa',
        onSubmit: async (d) => {
          await api.post('/platform/companies', {
            name: d.name,
            trade_name: d.trade_name || null,
            document: d.document || null,
            phone: d.phone || null,
            email: d.email || null,
          });
          toast('Empresa cadastrada. Ela já pode receber lojas e usuários.');
          state.page = 1;
          await refresh();
        },
      });
    });
  }

  await refresh();
}
