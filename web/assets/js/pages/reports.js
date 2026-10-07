/** Relatórios operacionais (v1.9) — vendas, por produto, estoque, movimentações, compras. */
import { api } from '../api.js';
import { esc, fmtMoney, fmtDateTime, optionsHtml, dataTable } from '../ui.js';

const state = { tab: 'sales', from: '2026-10-01', to: '2026-10-31', store_id: '' };

export async function render(view) {
  view.innerHTML = `
    <div class="page-head"><div><h2>Relatórios</h2><p>Indicadores operacionais — filtros por período e loja.</p></div></div>
    <div class="card">
      <div class="toolbar" style="padding:14px 14px 0">
        <div class="tabs">
          ${[['sales', 'Vendas'], ['products', 'Por produto'], ['stock', 'Estoque'], ['movements', 'Movimentações'], ['purchases', 'Compras']].map(([v, l]) => `<button class="tab ${state.tab === v ? 'active' : ''}" data-tab="${v}">${l}</button>`).join('')}
        </div>
        <div class="spacer"></div>
        <input class="input" type="date" id="f-from" style="width:145px" value="${esc(state.from)}">
        <input class="input" type="date" id="f-to" style="width:145px" value="${esc(state.to)}">
        <select class="input" id="f-store" style="width:170px"><option value="">Todas as lojas</option></select>
      </div>
      <div id="content" style="padding:14px"><div class="loading-line">Carregando…</div></div>
    </div>`;

  const stores = await api.get('/stores?per_page=50');
  view.querySelector('#f-store').innerHTML = '<option value="">Todas as lojas</option>' + optionsHtml(stores.items, state.store_id);

  async function refresh() {
    const box = view.querySelector('#content');
    const params = new URLSearchParams({ from: state.from, to: state.to });
    if (state.store_id) params.set('store_id', state.store_id);
    try {
      if (state.tab === 'sales') {
        const r = await api.get(`/reports/sales?${params}`);
        const s = r.summary;
        box.innerHTML = `<div class="cards-grid">
          <div class="card stat-card"><span class="stat-label">Vendas</span><span class="stat-value">${s.sales_count}</span></div>
          <div class="card stat-card"><span class="stat-label">Total vendido</span><span class="stat-value small">${esc(fmtMoney(s.total_cents))}</span></div>
          <div class="card stat-card"><span class="stat-label">Ticket médio</span><span class="stat-value small">${esc(fmtMoney(s.avg_ticket_cents))}</span></div>
          <div class="card stat-card"><span class="stat-label">Produtos vendidos</span><span class="stat-value">${s.products_sold}</span></div>
        </div>`;
      } else if (state.tab === 'products') {
        const r = await api.get(`/reports/products?${params}`);
        box.innerHTML = dataTable([
          { label: 'Produto', render: (p) => `<div class="td-main">${esc(p.product_name)}</div><div class="td-sub">${esc(p.product_sku || '')}</div>` },
          { label: 'Qtd vendida', render: (p) => `<strong>${p.quantity}</strong>` },
          { label: 'Faturamento', render: (p) => esc(fmtMoney(p.total_cents)) },
        ], r.items, 'Sem vendas no período.');
      } else if (state.tab === 'stock') {
        const r = await api.get(`/reports/stock?${new URLSearchParams({ store_id: state.store_id, low: '1' })}`);
        box.innerHTML = `<p class="td-sub" style="margin-bottom:8px">Produtos com estoque baixo ou zerado${state.store_id ? ' nesta loja' : ' (todas as lojas)'}.</p>` + dataTable([
          { label: 'Produto', render: (p) => `<div class="td-main">${esc(p.name)}</div><div class="td-sub">${esc(p.store_id ? '' : 'agregado')}</div>` },
          { label: 'Saldo', render: (p) => `<strong>${p.quantity}</strong>` },
          { label: 'Mínimo', render: (p) => p.minimum_stock ?? '—' },
        ], r.items.filter((p) => p.quantity === 0 || (p.minimum_stock != null && p.quantity <= p.minimum_stock)));
      } else if (state.tab === 'movements') {
        const r = await api.get(`/reports/movements?${params}&per_page=50`);
        box.innerHTML = dataTable([
          { label: 'Data', render: (m) => `<span class="td-sub">${esc(fmtDateTime(m.created_at))}</span>` },
          { label: 'Produto', render: (m) => `<div class="td-main">${esc(m.product_name)}</div><div class="td-sub">${esc(m.store_name)}</div>` },
          { label: 'Tipo', render: (m) => esc(m.type) },
          { label: 'Qtd', render: (m) => esc(String(m.quantity)) },
          { label: 'Saldo', render: (m) => `<span class="td-sub">${m.balance_before} → ${m.balance_after}</span>` },
        ], r.items, 'Sem movimentações no período.');
      } else {
        const r = await api.get(`/reports/purchases?${params}`);
        box.innerHTML = `<div class="cards-grid">
          <div class="card stat-card"><span class="stat-label">Compras</span><span class="stat-value">${r.summary.purchases_count}</span></div>
          <div class="card stat-card"><span class="stat-label">Total comprado</span><span class="stat-value small">${esc(fmtMoney(r.summary.total_cents))}</span></div>
        </div>` + dataTable([
          { label: 'Fornecedor', render: (p) => esc(p.supplier_name) },
          { label: 'Compras', render: (p) => esc(String(p.purchases_count)) },
          { label: 'Total', render: (p) => esc(fmtMoney(p.total_cents)) },
        ], r.by_supplier, 'Sem compras no período.');
      }
    } catch (err) {
      box.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    }
  }

  view.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    view.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    state.tab = t.dataset.tab;
    refresh();
  }));
  for (const [id, key] of [['#f-from', 'from'], ['#f-to', 'to'], ['#f-store', 'store_id']]) {
    view.querySelector(id).addEventListener('change', (e) => { state[key] = e.target.value; refresh(); });
  }
  await refresh();
}
