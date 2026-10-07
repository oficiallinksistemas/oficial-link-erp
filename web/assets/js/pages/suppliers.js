/** Fornecedores (v1.9) — CRUD com documento único por empresa. */
import { api } from '../api.js';
import { session } from '../app.js';
import { esc, toast, badge, dataTable, pagination, openModal, confirmDialog, debounce, fmtDate, optionsHtml } from '../ui.js';

const state = { page: 1, search: '', status: '' };

export async function render(view) {
  const canCreate = session.hasPerm('suppliers.create');
  const canEdit = session.hasPerm('suppliers.edit');
  const canDelete = session.hasPerm('suppliers.delete');

  view.innerHTML = `
    <div class="page-head"><div><h2>Fornecedores</h2><p>Cadastro de fornecedores da sua empresa.</p></div>
      <div class="spacer"></div>${canCreate ? '<button class="btn btn-primary" id="new">+ Novo fornecedor</button>' : ''}</div>
    <div class="card" id="card"><div class="loading-line">Carregando…</div></div>`;

  async function refresh() {
    const card = view.querySelector('#card');
    const params = new URLSearchParams({ page: state.page });
    if (state.search) params.set('search', state.search);
    if (state.status) params.set('status', state.status);
    const data = await api.get(`/suppliers?${params}`);

    card.innerHTML = `
      <div class="toolbar" style="padding:14px 14px 0">
        <input class="input" id="search" placeholder="Buscar por nome ou CNPJ…" value="${esc(state.search)}">
        <select class="input" id="f-status" style="width:140px">
          <option value="">Todos</option>
          <option value="active" ${state.status === 'active' ? 'selected' : ''}>Ativos</option>
          <option value="inactive" ${state.status === 'inactive' ? 'selected' : ''}>Inativos</option>
        </select>
      </div>
      ${dataTable([
        { label: 'Fornecedor', render: (s) => `<div class="td-main">${esc(s.name)}</div><div class="td-sub">${esc([s.phone, s.email].filter(Boolean).join(' · ') || '')}</div>` },
        { label: 'CNPJ/CPF', render: (s) => `<span class="td-sub">${esc(s.document || '—')}</span>` },
        { label: 'Cidade/UF', render: (s) => `<span class="td-sub">${esc([s.city, s.state].filter(Boolean).join(' / ') || '—')}</span>` },
        { label: 'Status', render: (s) => badge(s.status) },
        { label: '', class: 'td-actions', render: (s) => `
          ${canEdit ? `<button class="btn-link" data-edit="${s.id}">Editar</button>` : ''}
          ${canEdit ? `<button class="btn-link" data-toggle="${s.id}" data-status="${s.status}">${s.status === 'active' ? 'Desativar' : 'Reativar'}</button>` : ''}
          ${canDelete ? `<button class="btn-link danger" data-del="${s.id}">Excluir</button>` : ''}
        ` },
      ], data.items, 'Nenhum fornecedor encontrado.')}
      ${pagination({ ...data, onPage: (p) => { state.page = p; refresh(); } })}`;

    card.querySelector('#search').addEventListener('input', debounce((e) => { state.search = e.target.value.trim(); state.page = 1; refresh(); }));
    card.querySelector('#f-status').addEventListener('change', (e) => { state.status = e.target.value; state.page = 1; refresh(); });
    card.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      openForm(data.items.find((x) => x.id === Number(b.dataset.edit)));
    }));
    card.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
      const s = data.items.find((x) => x.id === Number(b.dataset.toggle));
      await api.patch(`/suppliers/${s.id}`, { status: s.status === 'active' ? 'inactive' : 'active' });
      toast('Status atualizado.');
      await refresh();
    }));
    card.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      const s = data.items.find((x) => x.id === Number(b.dataset.del));
      const go = await confirmDialog(`Excluir ${s.name}?`, { danger: true, confirmLabel: 'Excluir' });
      if (!go) return;
      try { await api.delete(`/suppliers/${s.id}`); toast('Fornecedor excluído.'); await refresh(); }
      catch (err) { toast(err.message, 'error'); }
    }));
  }

  function openForm(s = null) {
    const v = (k) => esc(s?.[k] || '');
    openModal({
      title: s ? `Editar fornecedor — ${s.name}` : 'Novo fornecedor',
      wide: true,
      bodyHtml: `<div class="form-grid">
        <div class="field full"><label>Nome *</label><input class="input" name="name" value="${v('name')}" required minlength="2" maxlength="120"></div>
        <div class="field"><label>CNPJ/CPF</label><input class="input" name="document" value="${v('document')}" maxlength="20"></div>
        <div class="field"><label>Telefone</label><input class="input" name="phone" value="${v('phone')}" maxlength="30"></div>
        <div class="field full"><label>E-mail</label><input class="input" type="email" name="email" value="${v('email')}" maxlength="190"></div>
        <div class="field"><label>Endereço</label><input class="input" name="address" value="${v('address')}" maxlength="150"></div>
        <div class="field"><label>Cidade</label><input class="input" name="city" value="${v('city')}" maxlength="80"></div>
        <div class="field"><label>UF</label><input class="input" name="state" value="${v('state')}" maxlength="2" style="text-transform:uppercase"></div>
        <div class="field"><label>CEP</label><input class="input" name="zip" value="${v('zip')}" maxlength="10"></div>
        <div class="field full"><label>Observações</label><textarea class="input" name="notes" rows="2" maxlength="500">${v('notes')}</textarea></div>
      </div>`,
      submitLabel: s ? 'Salvar alterações' : 'Cadastrar',
      onSubmit: async (d) => {
        const payload = { name: d.name, document: d.document || null, phone: d.phone || null, email: d.email || null, address: d.address || null, city: d.city || null, state: d.state ? d.state.toUpperCase() : null, zip: d.zip || null, notes: d.notes || null };
        if (s) { await api.patch(`/suppliers/${s.id}`, payload); toast('Fornecedor atualizado.'); }
        else { await api.post('/suppliers', payload); toast('Fornecedor cadastrado.'); state.page = 1; }
        await refresh();
      },
    });
  }

  const newBtn = view.querySelector('#new');
  if (newBtn) newBtn.addEventListener('click', () => openForm());
  await refresh();
}
