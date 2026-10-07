/** Contas a Receber (v3.0) — resumo, listagem, lançamento manual, recebimento e cancelamento. */
import { api } from '../api.js';
import { session } from '../app.js';
import { buildReceivablePayload } from '../lib/receivablePayload.js';
import {
  esc, toast, badge, dataTable, pagination, openModal, confirmDialog,
  debounce, fmtDate, fmtMoney, moneyToCents, maskMoneyInput, optionsHtml,
} from '../ui.js';

const state = { page: 1, status: '', customer_id: '', store_id: '', search: '' };
const STATUS = { open: 'Em aberto', overdue: 'Vencido', paid: 'Recebido', canceled: 'Cancelado' };
function stBadge(t) {
  if (t.status === 'paid') return '<span class="badge badge-active">Recebido</span>';
  if (t.status === 'canceled') return '<span class="badge badge-suspended">Cancelado</span>';
  if (t.effective_status === 'overdue') return '<span class="badge badge-inactive">Vencido</span>';
  return '<span class="badge badge-active">Em aberto</span>';
}

export async function render(view) {
  const canCreate = session.hasPerm('receivables.create');
  const canUpdate = session.hasPerm('receivables.update');
  const canReceive = session.hasPerm('receivables.receive');
  const canCancel = session.hasPerm('receivables.cancel');

  view.innerHTML = `
    <div class="page-head"><div><h2>Contas a Receber</h2><p>Créditos da empresa — títulos vinculados a vendas e lançamentos manuais.</p></div>
      <div class="spacer"></div>${canCreate ? '<button class="btn btn-primary" id="new">+ Novo título</button>' : ''}</div>
    <div class="cards-grid" id="summary"></div>
    <div class="card" id="card"><div class="loading-line">Carregando…</div></div>`;

  const [stores, customers, sales] = await Promise.all([
    api.get('/stores?per_page=50'),
    api.get('/customers?per_page=50').catch(() => ({ items: [] })),
    api.get('/sales?per_page=20&status=active').catch(() => ({ items: [] })),
  ]);

  function renderSummary(s) {
    view.querySelector('#summary').innerHTML = `
      <div class="card stat-card"><span class="stat-label">A receber</span><span class="stat-value small">${esc(fmtMoney(s.open_cents))}</span><span class="stat-hint">${s.open_count} título(s)</span></div>
      <div class="card stat-card"><span class="stat-label">Vencido</span><span class="stat-value small">${esc(fmtMoney(s.overdue_cents))}</span><span class="stat-hint">${s.overdue_count} título(s)</span></div>
      <div class="card stat-card"><span class="stat-label">Vence hoje</span><span class="stat-value small">${esc(fmtMoney(s.due_today_cents))}</span></div>
      <div class="card stat-card"><span class="stat-label">Vence em 7 dias</span><span class="stat-value small">${esc(fmtMoney(s.due_7d_cents))}</span></div>
      <div class="card stat-card"><span class="stat-label">Recebido no mês</span><span class="stat-value small">${esc(fmtMoney(s.received_month_cents))}</span></div>`;
  }

  async function refresh() {
    const card = view.querySelector('#card');
    const params = new URLSearchParams({ page: state.page });
    for (const k of ['status', 'customer_id', 'store_id', 'search']) if (state[k]) params.set(k, state[k]);
    const data = await api.get(`/receivables?${params}`);
    renderSummary(data.summary);

    card.innerHTML = `
      <div class="toolbar" style="padding:14px 14px 0">
        <select class="input" id="f-status" style="width:140px">
          <option value="">Todos</option>
          ${Object.entries(STATUS).map(([v, l]) => `<option value="${v}" ${state.status === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <select class="input" id="f-customer" style="width:180px">
          <option value="">Todos os clientes</option>${optionsHtml(customers.items, state.customer_id)}
        </select>
        <select class="input" id="f-store" style="width:160px">
          <option value="">Todas as lojas</option>${optionsHtml(stores.items, state.store_id)}
        </select>
        <input class="input" id="search" placeholder="Buscar descrição…" value="${esc(state.search)}">
      </div>
      ${dataTable([
        { label: 'Título', render: (t) => `<div class="td-main">${esc(t.description)}</div><div class="td-sub">${esc(t.origin === 'sale' ? `Venda #${t.sale_id}` : 'Lançamento manual')}</div>` },
        { label: 'Cliente', render: (t) => esc(t.customer_name || t.sale_customer || '—') },
        { label: 'Valor', render: (t) => `<strong>${esc(fmtMoney(t.amount_cents))}</strong>` },
        { label: 'Vencimento', render: (t) => `<span class="td-sub">${esc(fmtDate(t.due_date))}</span>` },
        { label: 'Status', render: (t) => stBadge(t) },
        { label: 'Recebimento', render: (t) => t.received_at ? `<span class="td-sub">${esc(fmtDate(t.received_at))}<br>${esc(fmtMoney(t.received_amount_cents))}</span>` : '<span class="td-sub">—</span>' },
        { label: '', class: 'td-actions', render: (t) => `
          ${canUpdate && t.status === 'open' && t.origin === 'manual' ? `<button class="btn-link" data-edit="${t.id}">Editar</button>` : ''}
          ${canReceive && t.status === 'open' ? `<button class="btn-link" data-receive="${t.id}">Receber</button>` : ''}
          ${canCancel && t.status === 'open' && t.origin === 'manual' ? `<button class="btn-link danger" data-cancel="${t.id}">Cancelar</button>` : ''}
        ` },
      ], data.items, 'Nenhum título encontrado com esses filtros.')}
      ${pagination({ ...data, onPage: (p) => { state.page = p; refresh(); } })}`;

    card.querySelector('#f-status').addEventListener('change', (e) => { state.status = e.target.value; state.page = 1; refresh(); });
    card.querySelector('#f-customer').addEventListener('change', (e) => { state.customer_id = e.target.value; state.page = 1; refresh(); });
    card.querySelector('#f-store').addEventListener('change', (e) => { state.store_id = e.target.value; state.page = 1; refresh(); });
    card.querySelector('#search').addEventListener('input', debounce((e) => { state.search = e.target.value.trim(); state.page = 1; refresh(); }));

    card.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      openForm(data.items.find((x) => x.id === Number(b.dataset.edit)));
    }));
    card.querySelectorAll('[data-receive]').forEach((b) => b.addEventListener('click', async () => {
      const t = data.items.find((x) => x.id === Number(b.dataset.receive));
      const go = await confirmDialog(`Confirmar recebimento de ${t.description} no valor de ${fmtMoney(t.amount_cents)}?`, { confirmLabel: 'Confirmar recebimento' });
      if (!go) return;
      try { await api.post(`/receivables/${t.id}/receive`); toast('Título recebido.'); await refresh(); }
      catch (err) { toast(err.message, 'error'); }
    }));
    card.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
      const t = data.items.find((x) => x.id === Number(b.dataset.cancel));
      const go = await confirmDialog(`Cancelar o título "${t.description}"? Essa ação não apaga o histórico.`, { danger: true, confirmLabel: 'Cancelar título' });
      if (!go) return;
      try { await api.post(`/receivables/${t.id}/cancel`, { reason: 'cancelado pelo usuário' }); toast('Título cancelado.'); await refresh(); }
      catch (err) { toast(err.message, 'error'); }
    }));
  }

  function openForm(t = null) {
    const v = (k) => esc(t?.[k] ?? '');
    openModal({
      title: t ? `Editar título — ${t.description}` : 'Novo título a receber',
      wide: true,
      bodyHtml: `
        <div class="form-grid">
          <div class="field full"><label>Descrição *</label>
            <input class="input" name="description" value="${v('description')}" required minlength="2" maxlength="200"></div>
          ${!t ? `
          <div class="field full"><label>Vincular à venda (opcional — origem SALE)</label>
            <select class="input" name="sale_id" id="f-sale">
              <option value="">— Sem vincular (manual) —</option>
              ${sales.items.map((s) => `<option value="${s.id}">#${s.id} · ${esc(s.customer_name)} · ${esc(fmtMoney(s.amount_cents))}</option>`).join('')}
            </select></div>
          <div class="field full" id="derived-info" style="display:none">
            <div class="alert alert-info" style="margin:0"></div>
          </div>` : ''}
          <div class="field"><label>Valor (R$) *</label>
            <input class="input" name="amount" id="f-amount" inputmode="decimal" required
              value="${t ? (t.amount_cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : ''}"></div>
          <div class="field"><label>Vencimento *</label>
            <input class="input" type="date" name="due_date" required value="${v('due_date')}"></div>
          <div class="field"><label>Emissão</label>
            <input class="input" type="date" name="issue_date" value="${v('issue_date')}"></div>
          <div class="field"><label>Cliente</label>
            <select class="input" name="customer_id" id="f-customer-sel">
              <option value="">— Sem cliente —</option>${optionsHtml(customers.items, t?.customer_id)}
            </select></div>
          <div class="field"><label>Loja</label>
            <select class="input" name="store_id" id="f-store-sel">
              <option value="">— Sem loja —</option>${optionsHtml(stores.items, t?.store_id)}
            </select></div>
          <div class="field full"><label>Observações</label>
            <textarea class="input" name="notes" rows="2" maxlength="500">${v('notes')}</textarea></div>
        </div>`,
      submitLabel: t ? 'Salvar alterações' : 'Lançar título',
      onSubmit: async (d) => {
        // Com venda selecionada, o payload é derivado da venda pela função
        // pura (campos visuais travados/disabled não podem fazer o valor
        // "sumir"). Sem venda, valida o valor manual.
        const payload = t ? {
          description: d.description, due_date: d.due_date,
          issue_date: d.issue_date || undefined, notes: d.notes || null,
        } : buildReceivablePayload(d, sales.items);
        if (t) {
          const cents = moneyToCents(d.amount);
          if (!Number.isFinite(cents) || cents <= 0) { toast('Informe um valor válido.', 'error'); return; }
          payload.amount = cents / 100;
        } else if (!payload.sale_id) {
          const cents = moneyToCents(payload.amount);
          if (!Number.isFinite(cents) || cents <= 0) { toast('Informe um valor válido.', 'error'); return; }
          payload.amount = cents / 100;
        }
        if (t) { await api.patch(`/receivables/${t.id}`, payload); toast('Título atualizado.'); }
        else { await api.post('/receivables', payload); toast('Título lançado.'); state.page = 1; }
        await refresh();
      },
    });
    const amt = document.getElementById('f-amount');
    if (amt) maskMoneyInput(amt);

    // ORIGEM SALE — valor/loja/cliente são DERIVADOS da venda (somente leitura
    // no frontend; o backend rejeita qualquer divergência).
    const saleSel = document.getElementById('f-sale');
    if (saleSel) {
      const derivedBox = document.getElementById('derived-info');
      const derivedText = derivedBox.querySelector('.alert');
      const syncDerived = () => {
        const s = sales.items.find((x) => String(x.id) === saleSel.value);
        const locked = !!s;
        // readOnly (não disabled): mantém o campo no FormData — disabled
        // excluiria o valor do submit e quebraria a criação do título.
        amt.readOnly = locked;
        amt.style.opacity = locked ? '.65' : '';
        amt.tabIndex = locked ? -1 : 0;
        for (const el of [document.getElementById('f-customer-sel'), document.getElementById('f-store-sel')]) {
          el.disabled = locked; // selects não têm readOnly; o submit deriva da venda
          el.style.opacity = locked ? '.65' : '';
        }
        if (s) {
          amt.value = (s.amount_cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
          document.getElementById('f-customer-sel').value = s.customer_id || '';
          document.getElementById('f-store-sel').value = s.store_id || '';
          derivedText.innerHTML = `<strong>Origem: Venda #${esc(String(s.id))}</strong> — Valor: <strong>${esc(fmtMoney(s.amount_cents))}</strong> · Cliente: <strong>${esc(s.customer_name)}</strong> · Loja: <strong>${esc(s.store_name)}</strong>.<br>Estes dados vêm da venda e não podem ser alterados.`;
          derivedBox.style.display = '';
        } else {
          derivedBox.style.display = 'none';
        }
      };
      saleSel.addEventListener('change', syncDerived);
      syncDerived();
    }
  }

  const newBtn = view.querySelector('#new');
  if (newBtn) newBtn.addEventListener('click', () => openForm());
  await refresh();
}
