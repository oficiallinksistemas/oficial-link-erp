/** Compras (v1.9) — rascunho → recebimento (entrada no estoque) → cancelamento. */
import { api } from '../api.js';
import { session } from '../app.js';
import { esc, toast, badge, dataTable, pagination, openModal, confirmDialog, debounce, fmtDate, fmtMoney, moneyToCents, optionsHtml } from '../ui.js';

const state = { page: 1, status: '' };
const STATUS = { draft: 'Rascunho', received: 'Recebida', canceled: 'Cancelada' };
function stBadge(s) { return s === 'received' ? '<span class="badge badge-active">Recebida</span>' : s === 'canceled' ? '<span class="badge badge-suspended">Cancelada</span>' : '<span class="badge badge-inactive">Rascunho</span>'; }

export async function render(view) {
  const canCreate = session.hasPerm('purchases.create');
  const canReceive = session.hasPerm('purchases.receive');
  const canCancel = session.hasPerm('purchases.cancel');

  view.innerHTML = `
    <div class="page-head"><div><h2>Compras</h2><p>Entrada de mercadoria com fornecedor — receber dá entrada no estoque.</p></div>
      <div class="spacer"></div>${canCreate ? '<button class="btn btn-primary" id="new">+ Nova compra</button>' : ''}</div>
    <div class="card" id="card"><div class="loading-line">Carregando…</div></div>`;

  async function refresh() {
    const card = view.querySelector('#card');
    const params = new URLSearchParams({ page: state.page });
    if (state.status) params.set('status', state.status);
    const data = await api.get(`/purchases?${params}`);
    card.innerHTML = `
      <div class="toolbar" style="padding:14px 14px 0">
        <select class="input" id="f-status" style="width:150px">
          <option value="">Todos</option>
          ${Object.entries(STATUS).map(([v, l]) => `<option value="${v}" ${state.status === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      ${dataTable([
        { label: '#', render: (p) => `<span class="td-sub">#${p.id}</span>` },
        { label: 'Fornecedor / Loja', render: (p) => `<div class="td-main">${esc(p.supplier_name)}</div><div class="td-sub">${esc(p.store_name)}</div>` },
        { label: 'Data', render: (p) => `<span class="td-sub">${esc(fmtDate(p.purchase_date))}</span>` },
        { label: 'Total', render: (p) => `<strong>${esc(fmtMoney(p.total_cents))}</strong>` },
        { label: 'Status', render: (p) => stBadge(p.status) },
        { label: '', class: 'td-actions', render: (p) => `
          <button class="btn-link" data-view="${p.id}">Detalhes</button>
          ${canReceive && p.status === 'draft' ? `<button class="btn-link" data-receive="${p.id}">Receber</button>` : ''}
          ${canCancel && p.status !== 'canceled' ? `<button class="btn-link danger" data-cancel="${p.id}">Cancelar</button>` : ''}
        ` },
      ], data.items, 'Nenhuma compra registrada.')}
      ${pagination({ ...data, onPage: (p) => { state.page = p; refresh(); } })}`;

    card.querySelector('#f-status').addEventListener('change', (e) => { state.status = e.target.value; state.page = 1; refresh(); });
    card.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', async () => {
      const p = await api.get(`/purchases/${b.dataset.view}`);
      openDetail(p);
    }));
    card.querySelectorAll('[data-receive]').forEach((b) => b.addEventListener('click', async () => {
      const go = await confirmDialog('Receber esta compra? Cada item dará entrada no estoque da loja.', { confirmLabel: 'Receber compra' });
      if (!go) return;
      await api.post(`/purchases/${b.dataset.receive}/receive`);
      toast('Compra recebida — estoque atualizado.');
      await refresh();
    }));
    card.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
      const go = await confirmDialog('Cancelar esta compra? Se já recebida, o estoque será estornado.', { danger: true, confirmLabel: 'Cancelar compra' });
      if (!go) return;
      openModal({
        title: 'Motivo do cancelamento',
        bodyHtml: `<div class="field"><label>Motivo *</label><textarea class="input" name="reason" rows="2" required minlength="3"></textarea></div>`,
        submitLabel: 'Confirmar cancelamento',
        onSubmit: async (d) => { await api.post(`/purchases/${b.dataset.cancel}/cancel`, { reason: d.reason }); toast('Compra cancelada.'); await refresh(); },
      });
    }));
  }

  function openDetail(p) {
    openModal({
      title: `Compra #${p.id} — ${p.supplier_name}`,
      wide: true, submitLabel: 'Fechar',
      bodyHtml: `
        <p class="td-sub" style="margin-bottom:10px">${esc(p.store_name)} · ${esc(fmtDate(p.purchase_date))} · ${stBadge(p.status)}${p.note ? ` · ${esc(p.note)}` : ''}</p>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Produto</th><th>Qtd</th><th>Custo unit.</th><th>Subtotal</th></tr></thead>
          <tbody>${p.items.map((it) => `<tr><td>${esc(it.product_name)}</td><td>${it.quantity}</td><td>${esc(fmtMoney(it.unit_cost_cents))}</td><td>${esc(fmtMoney(it.subtotal_cents))}</td></tr>`).join('')}</tbody>
        </table></div>
        <p style="text-align:right;margin-top:8px"><strong>TOTAL: ${esc(fmtMoney(p.total_cents))}</strong></p>`,
      onSubmit: async () => {},
    });
  }

  async function openNew() {
    const [stores, suppliers, products] = await Promise.all([
      api.get('/stores?per_page=50'), api.get('/suppliers?per_page=50&status=active'),
      api.get('/products?per_page=100&status=active'),
    ]);
    const items = [];
    openModal({
      title: 'Nova compra (rascunho)',
      wide: true,
      bodyHtml: `
        <div class="form-grid">
          <div class="field"><label>Fornecedor *</label><select class="input" name="supplier_id">${optionsHtml(suppliers.items)}</select></div>
          <div class="field"><label>Loja *</label><select class="input" name="store_id">${optionsHtml(stores.items)}</select></div>
          <div class="field"><label>Data *</label><input class="input" type="date" name="purchase_date" value="${new Date().toISOString().slice(0, 10)}" required></div>
          <div class="field"><label>Observação</label><input class="input" name="note" maxlength="300"></div>
        </div>
        <div class="toolbar" style="margin-bottom:8px">
          <select class="input" id="p-product" style="flex:1">${products.items.map((p) => `<option value="${p.id}">${esc(p.name)}${p.cost_cents != null ? ` (custo ${esc(fmtMoney(p.cost_cents))})` : ''}</option>`).join('')}</select>
          <input class="input" id="p-qty" type="number" min="1" step="1" value="1" style="width:80px">
          <input class="input" id="p-cost" placeholder="Custo unit. (opcional)" inputmode="decimal" style="width:170px">
          <button class="btn btn-ghost btn-sm" id="p-add" type="button">Adicionar</button>
        </div>
        <div id="p-items"><div class="td-sub">Nenhum item.</div></div>`,
      submitLabel: 'Criar compra',
      onSubmit: async () => {
        if (!items.length) { toast('Adicione ao menos um item.', 'error'); return; }
        const form = document.querySelector('.modal form');
        await api.post('/purchases', {
          supplier_id: Number(form.supplier_id.value), store_id: Number(form.store_id.value),
          purchase_date: form.purchase_date.value, note: form.note.value || null,
          items: items.map((it) => ({ product_id: it.product.id, quantity: it.quantity, unit_cost: it.cost })),
        });
        toast('Compra criada em rascunho.');
        state.page = 1; await refresh();
      },
    });
    const rerender = () => {
      document.getElementById('p-items').innerHTML = items.length ? `<div class="table-wrap"><table class="table">
        <thead><tr><th>Produto</th><th>Qtd</th><th>Custo</th><th></th></tr></thead>
        <tbody>${items.map((it, i) => `<tr><td>${esc(it.product.name)}</td><td>${it.quantity}</td><td>${it.cost != null ? esc(fmtMoney(Math.round(it.cost * 100))) : 'cadastral'}</td><td><button class="btn-link danger" data-ri="${i}">Remover</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="td-sub">Nenhum item.</div>';
      document.querySelectorAll('[data-ri]').forEach((b) => b.addEventListener('click', () => { items.splice(Number(b.dataset.ri), 1); rerender(); }));
    };
    document.getElementById('p-add').addEventListener('click', () => {
      const pid = Number(document.getElementById('p-product').value);
      const qty = Number(document.getElementById('p-qty').value);
      const costRaw = document.getElementById('p-cost').value;
      if (!Number.isInteger(qty) || qty <= 0) { toast('Quantidade inválida.', 'error'); return; }
      const product = products.items.find((p) => p.id === pid);
      let cost = null;
      if (costRaw) { const c = moneyToCents(costRaw); if (!Number.isFinite(c) || c <= 0) { toast('Custo inválido.', 'error'); return; } cost = c / 100; }
      const ex = items.find((it) => it.product.id === pid);
      if (ex) { ex.quantity += qty; if (cost != null) ex.cost = cost; } else items.push({ product, quantity: qty, cost });
      document.getElementById('p-qty').value = '1'; document.getElementById('p-cost').value = '';
      rerender();
    });
  }

  const newBtn = view.querySelector('#new');
  if (newBtn) newBtn.addEventListener('click', openNew);
  await refresh();
}
