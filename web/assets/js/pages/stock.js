/**
 * Módulo ESTOQUE (v1.8) — saldos por loja, movimentação (entrada/saída/ajuste)
 * e histórico imutável de movimentações. Componentes do design system;
 * backend é autoridade em saldo e permissões.
 */

import { api } from '../api.js';
import { session } from '../app.js';
import {
  esc, toast, badge, dataTable, pagination, openModal, confirmDialog,
  debounce, fmtDateTime, optionsHtml,
} from '../ui.js';

const state = { view: 'balances', page: 1, store_id: '', search: '', category_id: '', low: '', zero: '', status: '' };
const movState = { page: 1, store_id: '', product_id: '', type: '', from: '', to: '' };

const MOV_TYPES = {
  ENTRY: 'Entrada', EXIT: 'Saída', ADJUST_IN: 'Ajuste +', ADJUST_OUT: 'Ajuste −',
  SALE: 'Venda', SALE_REVERSAL: 'Estorno',
};

export async function render(view) {
  const canMove = session.hasPerm('stock.move');
  const canAdjust = session.hasPerm('stock.adjust');

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h2>Estoque</h2>
        <p>Saldos por loja e histórico de movimentações.</p>
      </div>
      <div class="spacer"></div>
      <div class="tabs">
        <button class="tab active" data-view="balances">Saldos</button>
        <button class="tab" data-view="movements">Movimentações</button>
      </div>
    </div>
    <div class="cards-grid" id="summary"></div>
    <div class="card" id="card"><div class="loading-line">Carregando…</div></div>`;

  const [stores, categories, products] = await Promise.all([
    api.get('/stores?per_page=50'),
    api.get('/products/categories').catch(() => []),
    api.get('/products?per_page=50&status=active').catch(() => ({ items: [] })),
  ]);
  if (!state.store_id && stores.items.length) state.store_id = String(stores.items[0].id);

  const activeCats = categories.filter((c) => c.status === 'active');

  function renderSummary(s) {
    view.querySelector('#summary').innerHTML = `
      <div class="card stat-card"><span class="stat-label">Unidades em estoque</span><span class="stat-value">${esc(String(s.total_units))}</span></div>
      <div class="card stat-card"><span class="stat-label">Produtos com estoque baixo</span><span class="stat-value">${esc(String(s.low_stock))}</span></div>
      <div class="card stat-card"><span class="stat-label">Produtos zerados</span><span class="stat-value">${esc(String(s.zero_stock))}</span></div>`;
  }

  async function refreshBalances() {
    const card = view.querySelector('#card');
    const params = new URLSearchParams({ page: state.page });
    if (state.store_id) params.set('store_id', state.store_id);
    if (state.search) params.set('search', state.search);
    if (state.category_id) params.set('category_id', state.category_id);
    if (state.low) params.set('low', '1');
    if (state.zero) params.set('zero', '1');
    if (state.status) params.set('status', state.status);
    const data = await api.get(`/stock?${params}`);
    renderSummary(data.summary);

    card.innerHTML = `
      <div class="toolbar" style="padding:14px 14px 0">
        <select class="input" id="f-store" style="width:170px">${optionsHtml(stores.items, state.store_id)}</select>
        <input class="input" id="search" placeholder="Buscar produto, SKU, código…" value="${esc(state.search)}">
        <select class="input" id="f-category" style="width:160px">
          <option value="">Todas as categorias</option>${optionsHtml(activeCats, state.category_id)}
        </select>
        <select class="input" id="f-flag" style="width:150px">
          <option value="">Todos</option>
          <option value="low" ${state.low ? 'selected' : ''}>Estoque baixo</option>
          <option value="zero" ${state.zero ? 'selected' : ''}>Zerados</option>
        </select>
        ${canMove ? '<button class="btn btn-primary btn-sm" id="do-move">Movimentar</button>' : ''}
      </div>
      ${dataTable([
        { label: 'Produto', render: (p) => `
          <div class="td-main">${esc(p.name)}</div>
          <div class="td-sub">${[p.sku && `SKU ${p.sku}`, esc(p.category_name || '')].filter(Boolean).join(' · ')}</div>` },
        { label: 'Unid.', render: (p) => esc(p.unit) },
        { label: 'Saldo', render: (p) => `<strong>${esc(String(p.quantity))}</strong>` },
        { label: 'Mínimo', render: (p) => `<span class="td-sub">${p.minimum_stock ?? '—'}</span>` },
        { label: 'Situação', render: (p) => p.quantity === 0 ? '<span class="badge badge-suspended">Zerado</span>'
          : (p.minimum_stock != null && p.quantity <= p.minimum_stock) ? '<span class="badge badge-inactive">Baixo</span>'
          : '<span class="badge badge-active">OK</span>' },
        { label: 'Status', render: (p) => badge(p.status) },
      ], data.items, 'Nenhum produto encontrado para esses filtros.')}
      ${pagination({ ...data, onPage: (pg) => { state.page = pg; refreshBalances(); } })}`;

    card.querySelector('#f-store').addEventListener('change', (e) => { state.store_id = e.target.value; state.page = 1; refreshBalances(); });
    card.querySelector('#search').addEventListener('input', debounce((e) => { state.search = e.target.value.trim(); state.page = 1; refreshBalances(); }));
    card.querySelector('#f-category').addEventListener('change', (e) => { state.category_id = e.target.value; state.page = 1; refreshBalances(); });
    card.querySelector('#f-flag').addEventListener('change', (e) => {
      state.low = e.target.value === 'low' ? '1' : ''; state.zero = e.target.value === 'zero' ? '1' : '';
      state.page = 1; refreshBalances();
    });
    const mv = card.querySelector('#do-move');
    if (mv) mv.addEventListener('click', () => openMovement());
  }

  function openMovement() {
    openModal({
      title: 'Movimentar estoque',
      bodyHtml: `
        <div class="form-grid">
          <div class="field full"><label>Tipo *</label>
            <select class="input" name="type" id="mv-type">
              <option value="ENTRY">Entrada (compra/ajuste positivo)</option>
              ${canMove ? '<option value="EXIT">Saída manual</option>' : ''}
              ${canAdjust ? '<option value="ADJUST">Ajuste para quantidade exata</option>' : ''}
            </select></div>
          <div class="field"><label>Loja *</label>
            <select class="input" name="store_id">${optionsHtml(stores.items, state.store_id)}</select></div>
          <div class="field"><label>Produto *</label>
            <select class="input" name="product_id" id="mv-product">${optionsHtml(products.items)}</select></div>
          <div class="field" id="wrap-qty"><label>Quantidade *</label>
            <input class="input" type="number" name="quantity" min="1" step="1" value="1"></div>
          <div class="field" id="wrap-target" style="display:none"><label>Saldo ajustado para *</label>
            <input class="input" type="number" name="new_quantity" min="0" step="1"></div>
          <div class="field full"><label>Motivo / observação</label>
            <input class="input" name="note" maxlength="300"></div>
        </div>`,
      submitLabel: 'Confirmar movimentação',
      onSubmit: async (d, close) => {
        const type = d.type;
        const body = { store_id: Number(d.store_id), product_id: Number(d.product_id), note: d.note || null };
        let endpoint;
        if (type === 'ADJUST') { endpoint = '/stock/adjust'; body.new_quantity = Number(d.new_quantity); }
        else { endpoint = type === 'ENTRY' ? '/stock/entry' : '/stock/exit'; body.quantity = Number(d.quantity); }
        await api.post(endpoint, body);
        toast('Movimentação registrada.');
        await refreshBalances();
      },
    });
    const typeSel = document.getElementById('mv-type');
    const toggle = () => {
      const isAdjust = typeSel.value === 'ADJUST';
      document.getElementById('wrap-qty').style.display = isAdjust ? 'none' : '';
      document.getElementById('wrap-target').style.display = isAdjust ? '' : 'none';
    };
    typeSel.addEventListener('change', toggle);
    toggle();
  }

  async function refreshMovements() {
    const card = view.querySelector('#card');
    const params = new URLSearchParams({ page: movState.page });
    for (const k of ['store_id', 'product_id', 'type', 'from', 'to']) if (movState[k]) params.set(k, movState[k]);
    const data = await api.get(`/stock/movements?${params}`);

    card.innerHTML = `
      <div class="toolbar" style="padding:14px 14px 0">
        <select class="input" id="m-store" style="width:160px">
          <option value="">Todas as lojas</option>${optionsHtml(stores.items, movState.store_id)}
        </select>
        <select class="input" id="m-product" style="width:200px">
          <option value="">Todos os produtos</option>${optionsHtml(products.items, movState.product_id)}
        </select>
        <select class="input" id="m-type" style="width:150px">
          <option value="">Todos os tipos</option>
          ${Object.entries(MOV_TYPES).map(([v, l]) => `<option value="${v}" ${movState.type === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <input class="input" type="date" id="m-from" style="width:145px" value="${esc(movState.from)}" title="De">
        <input class="input" type="date" id="m-to" style="width:145px" value="${esc(movState.to)}" title="Até">
      </div>
      ${dataTable([
        { label: 'Data', render: (m) => `<span class="td-sub">${esc(fmtDateTime(m.created_at))}</span>` },
        { label: 'Produto', render: (m) => `<div class="td-main">${esc(m.product_name)}</div><div class="td-sub">${esc(m.store_name)}</div>` },
        { label: 'Tipo', render: (m) => esc(MOV_TYPES[m.type] || m.type) },
        { label: 'Qtd', render: (m) => {
          const negative = ['EXIT', 'ADJUST_OUT', 'SALE'].includes(m.type);
          return `<strong style="color:${negative ? 'var(--danger)' : 'var(--success)'}">${negative ? '−' : '+'}${esc(String(m.quantity))}</strong>`;
        } },
        { label: 'Saldo', render: (m) => `<span class="td-sub">${m.balance_before} → <strong>${m.balance_after}</strong></span>` },
        { label: 'Origem', render: (m) => `<span class="td-sub">${esc(m.reference_type || 'manual')}${m.reference_id ? ' #' + m.reference_id : ''}</span>` },
        { label: 'Por', render: (m) => `<span class="td-sub">${esc(m.user_name)}</span>` },
        { label: 'Motivo', render: (m) => `<span class="td-sub">${esc(m.note || '—')}</span>` },
      ], data.items, 'Nenhuma movimentação com esses filtros.')}
      ${pagination({ ...data, onPage: (pg) => { movState.page = pg; refreshMovements(); } })}`;

    const bind = (id, key) => card.querySelector(id).addEventListener('change', (e) => {
      movState[key] = e.target.value; movState.page = 1; refreshMovements();
    });
    bind('#m-store', 'store_id'); bind('#m-product', 'product_id'); bind('#m-type', 'type');
    bind('#m-from', 'from'); bind('#m-to', 'to');
  }

  view.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    view.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    state.view = t.dataset.view;
    if (state.view === 'movements') refreshMovements(); else refreshBalances();
  }));

  await refreshBalances();
}
