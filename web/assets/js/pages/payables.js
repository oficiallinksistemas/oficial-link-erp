/** Contas a Pagar (v2.0) — resumo, listagem, lançamento manual, pagamento e cancelamento. */
import { api } from '../api.js';
import { session } from '../app.js';
import {
  esc, toast, badge, dataTable, pagination, openModal, confirmDialog,
  debounce, fmtDate, fmtMoney, moneyToCents, maskMoneyInput, optionsHtml,
} from '../ui.js';

const state = { page: 1, status: '', supplier_id: '', store_id: '', search: '' };
const STATUS = { open: 'Em aberto', overdue: 'Vencido', paid: 'Pago', canceled: 'Cancelado' };
function stBadge(t) {
  if (t.status === 'paid') return '<span class="badge badge-active">Pago</span>';
  if (t.status === 'canceled') return '<span class="badge badge-suspended">Cancelado</span>';
  if (t.effective_status === 'overdue') return '<span class="badge badge-inactive">Vencido</span>';
  return '<span class="badge badge-active">Em aberto</span>';
}

export async function render(view) {
  const canCreate = session.hasPerm('payables.create');
  const canUpdate = session.hasPerm('payables.update');
  const canPay = session.hasPerm('payables.pay');
  const canCancel = session.hasPerm('payables.cancel');

  view.innerHTML = `
    <div class="page-head"><div><h2>Contas a Pagar</h2><p>Obrigações financeiras da empresa — títulos de compras e lançamentos manuais.</p></div>
      <div class="spacer"></div>${canCreate ? '<button class="btn btn-primary" id="new">+ Novo título</button>' : ''}</div>
    <div class="cards-grid" id="summary"></div>
    <div class="card" id="card"><div class="loading-line">Carregando…</div></div>`;

  const [stores, suppliers] = await Promise.all([
    api.get('/stores?per_page=50'),
    api.get('/suppliers?per_page=50').catch(() => ({ items: [] })),
  ]);

  function renderSummary(s) {
    view.querySelector('#summary').innerHTML = `
      <div class="card stat-card"><span class="stat-label">Em aberto</span><span class="stat-value small">${esc(fmtMoney(s.open_cents))}</span><span class="stat-hint">${s.open_count} título(s)</span></div>
      <div class="card stat-card"><span class="stat-label">Vencido</span><span class="stat-value small">${esc(fmtMoney(s.overdue_cents))}</span><span class="stat-hint">${s.overdue_count} título(s)</span></div>
      <div class="card stat-card"><span class="stat-label">Vence hoje</span><span class="stat-value small">${esc(fmtMoney(s.due_today_cents))}</span></div>
      <div class="card stat-card"><span class="stat-label">Vence em 7 dias</span><span class="stat-value small">${esc(fmtMoney(s.due_7d_cents))}</span></div>
      <div class="card stat-card"><span class="stat-label">Pago no mês</span><span class="stat-value small">${esc(fmtMoney(s.paid_month_cents))}</span></div>`;
  }

  async function refresh() {
    const card = view.querySelector('#card');
    const params = new URLSearchParams({ page: state.page });
    for (const k of ['status', 'supplier_id', 'store_id', 'search']) if (state[k]) params.set(k, state[k]);
    const data = await api.get(`/payables?${params}`);
    renderSummary(data.summary);

    card.innerHTML = `
      <div class="toolbar" style="padding:14px 14px 0">
        <select class="input" id="f-status" style="width:140px">
          <option value="">Todos</option>
          ${Object.entries(STATUS).map(([v, l]) => `<option value="${v}" ${state.status === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <select class="input" id="f-supplier" style="width:180px">
          <option value="">Todos os fornecedores</option>${optionsHtml(suppliers.items, state.supplier_id)}
        </select>
        <select class="input" id="f-store" style="width:160px">
          <option value="">Todas as lojas</option>${optionsHtml(stores.items, state.store_id)}
        </select>
        <input class="input" id="search" placeholder="Buscar descrição, documento…" value="${esc(state.search)}">
      </div>
      ${dataTable([
        { label: 'Título', render: (t) => `<div class="td-main">${esc(t.description)}</div><div class="td-sub">${esc([t.document_number && `Doc ${t.document_number}`, t.origin_type === 'purchase' && `Compra #${t.purchase_id}`].filter(Boolean).join(' · ') || '')}</div>` },
        { label: 'Fornecedor', render: (t) => esc(t.supplier_name || '—') },
        { label: 'Valor', render: (t) => `<strong>${esc(fmtMoney(t.amount_cents))}</strong>` },
        { label: 'Vencimento', render: (t) => `<span class="td-sub">${esc(fmtDate(t.due_date))}</span>` },
        { label: 'Status', render: (t) => stBadge(t) },
        { label: 'Pagamento', render: (t) => t.paid_at ? `<span class="td-sub">${esc(fmtDate(t.paid_at))}<br>${esc(fmtMoney(t.paid_amount_cents))}</span>` : '<span class="td-sub">—</span>' },
        { label: '', class: 'td-actions', render: (t) => `
          ${canUpdate && t.status === 'open' ? `<button class="btn-link" data-edit="${t.id}">Editar</button>` : ''}
          ${canPay && t.status === 'open' ? `<button class="btn-link" data-pay="${t.id}">Pagar</button>` : ''}
          ${canCancel && t.status === 'open' ? `<button class="btn-link danger" data-cancel="${t.id}">Cancelar</button>` : ''}
        ` },
      ], data.items, 'Nenhum título encontrado com esses filtros.')}
      ${pagination({ ...data, onPage: (p) => { state.page = p; refresh(); } })}`;

    card.querySelector('#f-status').addEventListener('change', (e) => { state.status = e.target.value; state.page = 1; refresh(); });
    card.querySelector('#f-supplier').addEventListener('change', (e) => { state.supplier_id = e.target.value; state.page = 1; refresh(); });
    card.querySelector('#f-store').addEventListener('change', (e) => { state.store_id = e.target.value; state.page = 1; refresh(); });
    card.querySelector('#search').addEventListener('input', debounce((e) => { state.search = e.target.value.trim(); state.page = 1; refresh(); }));

    card.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      openForm(data.items.find((x) => x.id === Number(b.dataset.edit)));
    }));
    card.querySelectorAll('[data-pay]').forEach((b) => b.addEventListener('click', async () => {
      const t = data.items.find((x) => x.id === Number(b.dataset.pay));
      const go = await confirmDialog(`Confirmar pagamento de ${t.description} no valor de ${fmtMoney(t.amount_cents)}?`, { confirmLabel: 'Confirmar pagamento' });
      if (!go) return;
      try { await api.post(`/payables/${t.id}/pay`); toast('Título pago.'); await refresh(); }
      catch (err) { toast(err.message, 'error'); }
    }));
    card.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
      const t = data.items.find((x) => x.id === Number(b.dataset.cancel));
      const go = await confirmDialog(`Cancelar o título "${t.description}"? Essa ação não apaga o histórico.`, { danger: true, confirmLabel: 'Cancelar título' });
      if (!go) return;
      try { await api.post(`/payables/${t.id}/cancel`, { reason: 'cancelado pelo usuário' }); toast('Título cancelado.'); await refresh(); }
      catch (err) { toast(err.message, 'error'); }
    }));
  }

  function openForm(t = null) {
    const v = (k) => esc(t?.[k] ?? '');
    openModal({
      title: t ? `Editar título — ${t.description}` : 'Novo título a pagar',
      wide: true,
      bodyHtml: `
        <div class="form-grid">
          <div class="field full"><label>Descrição *</label>
            <input class="input" name="description" value="${v('description')}" required minlength="2" maxlength="200"></div>
          <div class="field"><label>Valor (R$) *</label>
            <input class="input" name="amount" id="f-amount" inputmode="decimal" required
              value="${t ? (t.amount_cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : ''}" ${t && t.origin_type === 'purchase' ? 'disabled' : ''}></div>
          <div class="field"><label>Vencimento *</label>
            <input class="input" type="date" name="due_date" required value="${v('due_date')}"></div>
          <div class="field"><label>Emissão</label>
            <input class="input" type="date" name="issue_date" value="${v('issue_date')}"></div>
          <div class="field"><label>Fornecedor</label>
            <select class="input" name="supplier_id">
              <option value="">— Sem fornecedor —</option>${optionsHtml(suppliers.items, t?.supplier_id)}
            </select></div>
          <div class="field"><label>Loja</label>
            <select class="input" name="store_id">
              <option value="">— Sem loja —</option>${optionsHtml(stores.items, t?.store_id)}
            </select></div>
          <div class="field"><label>Nº documento</label>
            <input class="input" name="document_number" value="${v('document_number')}" maxlength="40"></div>
          <div class="field"><label>Referência</label>
            <input class="input" name="reference" value="${v('reference')}" maxlength="60"></div>
          <div class="field full"><label>Observações</label>
            <textarea class="input" name="notes" rows="2" maxlength="500">${v('notes')}</textarea></div>
        </div>`,
      submitLabel: t ? 'Salvar alterações' : 'Lançar título',
      onSubmit: async (d) => {
        const cents = moneyToCents(d.amount);
        if (!Number.isFinite(cents) || cents <= 0) { toast('Informe um valor válido.', 'error'); return; }
        const payload = {
          description: d.description, due_date: d.due_date, issue_date: d.issue_date || undefined,
          supplier_id: d.supplier_id ? Number(d.supplier_id) : null,
          store_id: d.store_id ? Number(d.store_id) : null,
          document_number: d.document_number || null, reference: d.reference || null, notes: d.notes || null,
        };
        if (!(t && t.origin_type === 'purchase')) payload.amount = cents / 100;
        if (t) { await api.patch(`/payables/${t.id}`, payload); toast('Título atualizado.'); }
        else { await api.post('/payables', payload); toast('Título lançado.'); state.page = 1; }
        await refresh();
      },
    });
    const amt = document.getElementById('f-amount');
    if (amt && !amt.disabled) maskMoneyInput(amt);
  }

  const newBtn = view.querySelector('#new');
  if (newBtn) newBtn.addEventListener('click', () => openForm());
  await refresh();
}
