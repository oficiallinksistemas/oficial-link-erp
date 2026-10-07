/** Inventário (v1.9) — contagem física por loja: abrir, contar, finalizar. */
import { api } from '../api.js';
import { session } from '../app.js';
import { esc, toast, badge, dataTable, pagination, openModal, confirmDialog, fmtDateTime, optionsHtml } from '../ui.js';

const state = { page: 1, status: '' };
const STATUS = { open: 'Aberto', completed: 'Finalizado', canceled: 'Cancelado' };
function stBadge(s) { return s === 'completed' ? '<span class="badge badge-active">Finalizado</span>' : s === 'canceled' ? '<span class="badge badge-suspended">Cancelado</span>' : '<span class="badge badge-inactive">Aberto</span>'; }

export async function render(view) {
  const canAdjust = session.hasPerm('stock.adjust');

  view.innerHTML = `
    <div class="page-head"><div><h2>Inventário</h2><p>Contagem física por loja — as diferenças ajustam o estoque com histórico.</p></div>
      <div class="spacer"></div>${canAdjust ? '<button class="btn btn-primary" id="new">+ Abrir inventário</button>' : ''}</div>
    <div class="card" id="card"><div class="loading-line">Carregando…</div></div>`;

  async function refresh() {
    const card = view.querySelector('#card');
    const params = new URLSearchParams({ page: state.page });
    if (state.status) params.set('status', state.status);
    const data = await api.get(`/stock/inventory?${params}`);
    card.innerHTML = `
      <div class="toolbar" style="padding:14px 14px 0">
        <select class="input" id="f-status" style="width:150px">
          <option value="">Todos</option>
          ${Object.entries(STATUS).map(([v, l]) => `<option value="${v}" ${state.status === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      ${dataTable([
        { label: '#', render: (i) => `<span class="td-sub">#${i.id}</span>` },
        { label: 'Loja', render: (i) => esc(i.store_name) },
        { label: 'Itens contados', render: (i) => esc(String(i.items_count)) },
        { label: 'Aberto em', render: (i) => `<span class="td-sub">${esc(fmtDateTime(i.started_at))}</span>` },
        { label: 'Status', render: (i) => stBadge(i.status) },
        { label: '', class: 'td-actions', render: (i) => `
          <button class="btn-link" data-view="${i.id}">Detalhes</button>
          ${canAdjust && i.status === 'open' ? `<button class="btn-link" data-count="${i.id}">Contar</button>` : ''}
          ${canAdjust && i.status === 'open' ? `<button class="btn-link" data-finalize="${i.id}">Finalizar</button>` : ''}
        ` },
      ], data.items, 'Nenhum inventário.')}
      ${pagination({ ...data, onPage: (p) => { state.page = p; refresh(); } })}`;

    card.querySelector('#f-status').addEventListener('change', (e) => { state.status = e.target.value; state.page = 1; refresh(); });
    card.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', async () => {
      const s = await api.get(`/stock/inventory/${b.dataset.view}`);
      openModal({
        title: `Inventário #${s.id} — ${s.store_name}`, wide: true, submitLabel: 'Fechar',
        bodyHtml: `${s.items.length ? `<div class="table-wrap"><table class="table">
          <thead><tr><th>Produto</th><th>Sistema</th><th>Contado</th><th>Diferença</th><th>Ajustado</th></tr></thead>
          <tbody>${s.items.map((it) => `<tr><td>${esc(it.product_name)}</td><td>${it.system_quantity}</td><td>${it.counted_quantity ?? '—'}</td><td>${it.difference ?? '—'}</td><td>${it.adjustment_applied ? '✓' : '—'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="td-sub">Nenhuma contagem registrada.</div>'}`,
        onSubmit: async () => {},
      });
    }));
    card.querySelectorAll('[data-count]').forEach((b) => b.addEventListener('click', () => openCount(Number(b.dataset.count))));
    card.querySelectorAll('[data-finalize]').forEach((b) => b.addEventListener('click', async () => {
      const go = await confirmDialog('Finalizar inventário? As diferenças ajustarão o estoque com movimentações de ajuste.', { confirmLabel: 'Finalizar' });
      if (!go) return;
      await api.post(`/stock/inventory/${b.dataset.finalize}/finalize`);
      toast('Inventário finalizado e estoque ajustado.');
      await refresh();
    }));
  }

  async function openCount(sessionId) {
    const s = await api.get(`/stock/inventory/${sessionId}`);
    const products = await api.get('/products?per_page=100&status=active').catch(() => ({ items: [] }));
    openModal({
      title: `Contagem — Inventário #${s.id} (${s.store_name})`,
      wide: true,
      bodyHtml: `
        <div class="toolbar" style="margin-bottom:8px">
          <select class="input" id="c-product" style="flex:1">${products.items.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
          <input class="input" id="c-qty" type="number" min="0" step="1" placeholder="Qtd contada" style="width:130px">
          <button class="btn btn-ghost btn-sm" id="c-add" type="button">Registrar</button>
        </div>
        <div id="c-list">${s.items.length ? `<ul class="activity-list">${s.items.map((it) => `<li><div class="activity-body" style="flex:1"><div>${esc(it.product_name)}</div><div class="when">sistema ${it.system_quantity} · contado ${it.counted_quantity ?? '—'}</div></div></li>`).join('')}</ul>` : '<div class="td-sub">Nenhuma contagem registrada.</div>'}</div>`,
      submitLabel: 'Fechar',
      onSubmit: async () => { await refresh(); },
    });
    document.getElementById('c-add').addEventListener('click', async () => {
      const pid = Number(document.getElementById('c-product').value);
      const qty = Number(document.getElementById('c-qty').value);
      if (!Number.isInteger(qty) || qty < 0) { toast('Quantidade inválida.', 'error'); return; }
      const updated = await api.post(`/stock/inventory/${sessionId}/count`, { product_id: pid, counted: qty });
      document.getElementById('c-list').innerHTML = updated.items.length ? `<ul class="activity-list">${updated.items.map((it) => `<li><div class="activity-body" style="flex:1"><div>${esc(it.product_name)}</div><div class="when">sistema ${it.system_quantity} · contado ${it.counted_quantity ?? '—'}</div></div></li>`).join('')}</ul>` : '';
      document.getElementById('c-qty').value = '';
      toast('Contagem registrada.');
    });
  }

  async function openNew() {
    const stores = await api.get('/stores?per_page=50');
    openModal({
      title: 'Abrir inventário',
      bodyHtml: `
        <div class="field"><label>Loja *</label><select class="input" name="store_id">${optionsHtml(stores.items)}</select></div>
        <div class="field"><label>Observação</label><input class="input" name="note" maxlength="300"></div>`,
      submitLabel: 'Abrir',
      onSubmit: async (d) => {
        await api.post('/stock/inventory', { store_id: Number(d.store_id), note: d.note || null });
        toast('Inventário aberto.');
        state.page = 1; await refresh();
      },
    });
  }

  const newBtn = view.querySelector('#new');
  if (newBtn) newBtn.addEventListener('click', openNew);
  await refresh();
}
