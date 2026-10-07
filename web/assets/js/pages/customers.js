/**
 * Módulo CLIENTES (v1.5) — cadastro completo, busca, histórico de vendas
 * derivado de Sales, desativação (histórico preservado) e exclusão apenas
 * sem vendas. Componentes reutilizáveis do design system; sem emojis.
 */

import { api } from '../api.js';
import { session } from '../app.js';
import {
  esc, toast, badge, dataTable, pagination, openModal, confirmDialog,
  debounce, fmtDateTime, fmtDate, fmtMoney, optionsHtml,
} from '../ui.js';

const state = { page: 1, search: '', status: '' };

function saleBadge(status) {
  return status === 'canceled' ? '<span class="badge badge-suspended">Cancelada</span>'
    : '<span class="badge badge-active">Ativa</span>';
}

export async function render(view) {
  const canCreate = session.hasPerm('customers.create');
  const canEdit = session.hasPerm('customers.edit');
  const canDelete = session.hasPerm('customers.delete');

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h2>Clientes</h2>
        <p>Cadastro de clientes da sua empresa, com histórico de vendas.</p>
      </div>
      <div class="spacer"></div>
      ${canCreate ? '<button class="btn btn-primary" id="new-customer">+ Novo cliente</button>' : ''}
    </div>
    <div class="card" id="card"><div class="loading-line">Carregando…</div></div>`;

  async function refresh() {
    const card = view.querySelector('#card');
    const params = new URLSearchParams({ page: state.page });
    if (state.search) params.set('search', state.search);
    if (state.status) params.set('status', state.status);
    const data = await api.get(`/customers?${params}`);

    card.innerHTML = `
      <div class="toolbar" style="padding:14px 14px 0">
        <input class="input" id="search" placeholder="Buscar por nome, telefone, e-mail ou CPF/CNPJ…" value="${esc(state.search)}">
        <select class="input" id="f-status" style="width:150px">
          <option value="">Todos</option>
          <option value="active" ${state.status === 'active' ? 'selected' : ''}>Ativos</option>
          <option value="inactive" ${state.status === 'inactive' ? 'selected' : ''}>Inativos</option>
        </select>
      </div>
      ${dataTable([
        { label: 'Cliente', render: (c) => `
          <div class="td-main">${esc(c.name)}</div>
          <div class="td-sub">${esc([c.phone, c.email].filter(Boolean).join(' · ') || c.document || '')}</div>` },
        { label: 'CPF/CNPJ', render: (c) => `<span class="td-sub">${esc(c.document || '—')}</span>` },
        { label: 'Cidade/UF', render: (c) => `<span class="td-sub">${esc([c.city, c.state].filter(Boolean).join(' / ') || '—')}</span>` },
        { label: 'Status', render: (c) => badge(c.status) },
        { label: 'Criado em', render: (c) => `<span class="td-sub">${esc(fmtDate(c.created_at))}</span>` },
        { label: '', class: 'td-actions', render: (c) => `
          <button class="btn-link" data-view="${c.id}">Detalhes</button>
          ${canEdit ? `<button class="btn-link" data-edit="${c.id}">Editar</button>` : ''}
          ${canDelete ? `<button class="btn-link ${c.status === 'active' ? 'danger' : ''}" data-toggle="${c.id}" data-status="${c.status}">${c.status === 'active' ? 'Desativar' : 'Reativar'}</button>` : ''}
        ` },
      ], data.items)}
      ${pagination({ ...data, onPage: (p) => { state.page = p; refresh(); } })}`;

    card.querySelector('#search').addEventListener('input', debounce((e) => {
      state.search = e.target.value.trim(); state.page = 1; refresh();
    }));
    card.querySelector('#f-status').addEventListener('change', (e) => {
      state.status = e.target.value; state.page = 1; refresh();
    });

    card.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => openDetail(Number(b.dataset.view))));
    card.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      const c = data.items.find((x) => x.id === Number(b.dataset.edit));
      openForm(c);
    }));
    card.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
      const c = data.items.find((x) => x.id === Number(b.dataset.toggle));
      const deactivating = b.dataset.status === 'active';
      const go = await confirmDialog(
        deactivating
          ? `Desativar ${c.name}? O histórico de vendas será preservado.`
          : `Reativar ${c.name}?`,
        { danger: deactivating, confirmLabel: deactivating ? 'Desativar' : 'Reativar' }
      );
      if (!go) return;
      await api.patch(`/customers/${c.id}`, { status: deactivating ? 'inactive' : 'active' });
      toast(deactivating ? 'Cliente desativado.' : 'Cliente reativado.');
      await refresh();
    }));
  }

  function formHtml(c = null) {
    const v = (k) => esc(c?.[k] || '');
    return `
      <div class="form-grid">
        <div class="field full"><label>Nome *</label>
          <input class="input" name="name" value="${v('name')}" required minlength="2" maxlength="120"></div>
        <div class="field"><label>CPF/CNPJ</label>
          <input class="input" name="document" value="${v('document')}" maxlength="20" placeholder="somente números"></div>
        <div class="field"><label>Telefone</label>
          <input class="input" name="phone" value="${v('phone')}" maxlength="30"></div>
        <div class="field full"><label>E-mail</label>
          <input class="input" type="email" name="email" value="${v('email')}" maxlength="190"></div>
        <div class="field"><label>Endereço</label>
          <input class="input" name="address" value="${v('address')}" maxlength="150"></div>
        <div class="field"><label>Número</label>
          <input class="input" name="number" value="${v('number')}" maxlength="20"></div>
        <div class="field"><label>Complemento</label>
          <input class="input" name="complement" value="${v('complement')}" maxlength="80"></div>
        <div class="field"><label>Bairro</label>
          <input class="input" name="district" value="${v('district')}" maxlength="80"></div>
        <div class="field"><label>Cidade</label>
          <input class="input" name="city" value="${v('city')}" maxlength="80"></div>
        <div class="field"><label>UF</label>
          <input class="input" name="state" value="${v('state')}" maxlength="2" style="text-transform:uppercase"></div>
        <div class="field"><label>CEP</label>
          <input class="input" name="zip" value="${v('zip')}" maxlength="10"></div>
        <div class="field full"><label>Observações</label>
          <textarea class="input" name="notes" rows="2" maxlength="500">${v('notes')}</textarea></div>
      </div>`;
  }

  function openForm(c = null) {
    openModal({
      title: c ? `Editar cliente — ${c.name}` : 'Novo cliente',
      bodyHtml: formHtml(c),
      wide: true,
      submitLabel: c ? 'Salvar alterações' : 'Cadastrar cliente',
      onSubmit: async (d) => {
        const payload = {
          name: d.name, document: d.document || null, phone: d.phone || null,
          email: d.email || null, address: d.address || null, number: d.number || null,
          complement: d.complement || null, district: d.district || null,
          city: d.city || null, state: d.state ? d.state.toUpperCase() : null,
          zip: d.zip || null, notes: d.notes || null,
        };
        if (c) {
          await api.patch(`/customers/${c.id}`, payload);
          toast('Cliente atualizado.');
        } else {
          await api.post('/customers', payload);
          toast('Cliente cadastrado.');
          state.page = 1;
        }
        await refresh();
      },
    });
  }

  async function openDetail(id) {
    const c = await api.get(`/customers/${id}`);
    const addr = [c.address, c.number && `nº ${c.number}`, c.complement,
      c.district, [c.city, c.state].filter(Boolean).join(' / '), c.zip]
      .filter(Boolean).join(', ');
    openModal({
      title: c.name,
      wide: true,
      submitLabel: 'Fechar',
      bodyHtml: `
        <div class="form-grid">
          <div class="card card-pad" style="box-shadow:none">
            <h4 class="card-title" style="font-size:13.5px">Dados cadastrais</h4>
            <ul class="activity-list">
              <li><div class="activity-body"><div>CPF/CNPJ</div><div class="when">${esc(c.document || '—')}</div></div></li>
              <li><div class="activity-body"><div>Telefone</div><div class="when">${esc(c.phone || '—')}</div></div></li>
              <li><div class="activity-body"><div>E-mail</div><div class="when">${esc(c.email || '—')}</div></div></li>
              <li><div class="activity-body"><div>Endereço</div><div class="when">${esc(addr || '—')}</div></div></li>
              <li><div class="activity-body"><div>Status</div><div class="when">${c.status === 'active' ? 'Ativo' : 'Inativo'}</div></div></li>
              <li><div class="activity-body"><div>Criado em</div><div class="when">${esc(fmtDateTime(c.created_at))}</div></div></li>
              <li><div class="activity-body"><div>Última atualização</div><div class="when">${esc(fmtDateTime(c.updated_at))}</div></div></li>
              ${c.notes ? `<li><div class="activity-body"><div>Observações</div><div class="when">${esc(c.notes)}</div></div></li>` : ''}
            </ul>
            ${canDelete ? `<button class="btn btn-danger btn-sm" id="del-customer" style="margin-top:8px">Excluir cliente</button>` : ''}
          </div>
          <div class="card card-pad" style="box-shadow:none">
            <h4 class="card-title" style="font-size:13.5px">Histórico de vendas (${c.sales_history.length}${c.sales_count === 10 ? '+' : ''})</h4>
            ${c.sales_history.length ? `<ul class="activity-list">${c.sales_history.map((s) => `
              <li><div class="activity-body">
                <div><strong>${esc(fmtMoney(s.amount_cents))}</strong> · ${esc(s.store_name)} · ${esc(s.seller_name)}</div>
                <div class="when">${esc(fmtDate(s.sold_at))} ${saleBadge(s.status)}</div>
              </div></li>`).join('')}</ul>` : '<div class="td-sub">Nenhuma venda registrada para este cliente.</div>'}
          </div>
        </div>`,
      onSubmit: async () => { /* apenas fecha */ },
    });
    const delBtn = document.getElementById('del-customer');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        const go = await confirmDialog(
          `Excluir ${c.name} definitivamente? Só é possível excluir clientes SEM vendas. Essa ação não pode ser desfeita.`,
          { danger: true, confirmLabel: 'Excluir definitivamente' }
        );
        if (!go) return;
        try {
          await api.delete(`/customers/${c.id}`);
          toast('Cliente excluído.');
          await refresh();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }
  }

  const newBtn = view.querySelector('#new-customer');
  if (newBtn) newBtn.addEventListener('click', () => openForm());

  await refresh();
}
