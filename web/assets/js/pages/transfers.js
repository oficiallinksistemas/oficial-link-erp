/** Transferências entre lojas (v1.9) — saída na origem + entrada no destino. */
import { api } from '../api.js';
import { session } from '../app.js';
import { esc, toast, badge, dataTable, pagination, openModal, confirmDialog, fmtDateTime, optionsHtml } from '../ui.js';

const state = { page: 1, status: '' };
const STATUS = { pending: 'Pendente', completed: 'Concluída', canceled: 'Cancelada' };
function stBadge(s) { return s === 'completed' ? '<span class="badge badge-active">Concluída</span>' : s === 'canceled' ? '<span class="badge badge-suspended">Cancelada</span>' : '<span class="badge badge-inactive">Pendente</span>'; }

export async function render(view) {
  const canMove = session.hasPerm('stock.move');

  view.innerHTML = `
    <div class="page-head"><div><h2>Transferências</h2><p>Movimentação de produtos entre lojas da empresa.</p></div>
      <div class="spacer"></div>${canMove ? '<button class="btn btn-primary" id="new">+ Nova transferência</button>' : ''}</div>
    <div class="card" id="card"><div class="loading-line">Carregando…</div></div>`;

  async function refresh() {
    const card = view.querySelector('#card');
    const params = new URLSearchParams({ page: state.page });
    if (state.status) params.set('status', state.status);
    const data = await api.get(`/stock/transfers?${params}`);
    card.innerHTML = `
      <div class="toolbar" style="padding:14px 14px 0">
        <select class="input" id="f-status" style="width:150px">
          <option value="">Todos</option>
          ${Object.entries(STATUS).map(([v, l]) => `<option value="${v}" ${state.status === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      ${dataTable([
        { label: '#', render: (t) => `<span class="td-sub">#${t.id}</span>` },
        { label: 'Origem → Destino', render: (t) => `<div class="td-main">${esc(t.from_store_name)} → ${esc(t.to_store_name)}</div><div class="td-sub">${esc(t.note || '')}</div>` },
        { label: 'Criada em', render: (t) => `<span class="td-sub">${esc(fmtDateTime(t.created_at))}</span>` },
        { label: 'Status', render: (t) => stBadge(t.status) },
        { label: '', class: 'td-actions', render: (t) => `
          <button class="btn-link" data-view="${t.id}">Detalhes</button>
          ${canMove && t.status === 'pending' ? `<button class="btn-link" data-complete="${t.id}">Concluir</button>` : ''}
          ${canMove && t.status === 'pending' ? `<button class="btn-link danger" data-cancel="${t.id}">Cancelar</button>` : ''}
        ` },
      ], data.items, 'Nenhuma transferência.')}
      ${pagination({ ...data, onPage: (p) => { state.page = p; refresh(); } })}`;

    card.querySelector('#f-status').addEventListener('change', (e) => { state.status = e.target.value; state.page = 1; refresh(); });
    card.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', async () => {
      const t = await api.get(`/stock/transfers/${b.dataset.view}`);
      openModal({
        title: `Transferência #${t.id}`, wide: true, submitLabel: 'Fechar',
        bodyHtml: `<p class="td-sub" style="margin-bottom:8px">${esc(t.from_store_name)} → ${esc(t.to_store_name)} · ${stBadge(t.status)}</p>
          <ul class="activity-list">${t.items.map((it) => `<li><div class="activity-body"><div>${esc(it.product_name)}</div><div class="when">${it.quantity} un.</div></div></li>`).join('') || '<li class="td-sub">Sem itens.</li>'}</ul>`,
        onSubmit: async () => {},
      });
    }));
    card.querySelectorAll('[data-complete]').forEach((b) => b.addEventListener('click', async () => {
      const go = await confirmDialog('Concluir transferência? Saída na origem e entrada no destino.', { confirmLabel: 'Concluir' });
      if (!go) return;
      await api.post(`/stock/transfers/${b.dataset.complete}/complete`);
      toast('Transferência concluída.');
      await refresh();
    }));
    card.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
      const go = await confirmDialog('Cancelar esta transferência?', { danger: true, confirmLabel: 'Cancelar' });
      if (!go) return;
      openModal({
        title: 'Motivo',
        bodyHtml: `<div class="field"><label>Motivo *</label><textarea class="input" name="reason" rows="2" required minlength="3"></textarea></div>`,
        submitLabel: 'Confirmar',
        onSubmit: async (d) => { await api.post(`/stock/transfers/${b.dataset.cancel}/cancel`, { reason: d.reason }); toast('Transferência cancelada.'); await refresh(); },
      });
    }));
  }

  async function openNew() {
    const [stores, products] = await Promise.all([
      api.get('/stores?per_page=50'), api.get('/products?per_page=100&status=active'),
    ]);
    const items = [];
    openModal({
      title: 'Nova transferência',
      wide: true,
      bodyHtml: `
        <div class="form-grid">
          <div class="field"><label>Loja de origem *</label><select class="input" name="from_store_id">${optionsHtml(stores.items)}</select></div>
          <div class="field"><label>Loja de destino *</label><select class="input" name="to_store_id">${optionsHtml(stores.items, stores.items[1]?.id)}</select></div>
          <div class="field full"><label>Observação</label><input class="input" name="note" maxlength="300"></div>
        </div>
        <div class="toolbar" style="margin-bottom:8px">
          <select class="input" id="t-product" style="flex:1">${products.items.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
          <input class="input" id="t-qty" type="number" min="1" step="1" value="1" style="width:80px">
          <button class="btn btn-ghost btn-sm" id="t-add" type="button">Adicionar</button>
        </div>
        <div id="t-items"><div class="td-sub">Nenhum item.</div></div>`,
      submitLabel: 'Criar transferência',
      onSubmit: async () => {
        if (!items.length) { toast('Adicione ao menos um item.', 'error'); return; }
        const form = document.querySelector('.modal form');
        await api.post('/stock/transfers', {
          from_store_id: Number(form.from_store_id.value), to_store_id: Number(form.to_store_id.value),
          note: form.note.value || null,
          items: items.map((it) => ({ product_id: it.product.id, quantity: it.quantity })),
        });
        toast('Transferência criada.');
        state.page = 1; await refresh();
      },
    });
    const rerender = () => {
      document.getElementById('t-items').innerHTML = items.length ? `<ul class="activity-list">${items.map((it, i) => `<li><div class="activity-body" style="flex:1"><div>${esc(it.product.name)}</div><div class="when">${it.quantity} un.</div></div><button class="btn-link danger" data-ri="${i}">Remover</button></li>`).join('')}</ul>` : '<div class="td-sub">Nenhum item.</div>';
      document.querySelectorAll('[data-ri]').forEach((b) => b.addEventListener('click', () => { items.splice(Number(b.dataset.ri), 1); rerender(); }));
    };
    document.getElementById('t-add').addEventListener('click', () => {
      const pid = Number(document.getElementById('t-product').value);
      const qty = Number(document.getElementById('t-qty').value);
      if (!Number.isInteger(qty) || qty <= 0) { toast('Quantidade inválida.', 'error'); return; }
      const product = products.items.find((p) => p.id === pid);
      const ex = items.find((it) => it.product.id === pid);
      if (ex) ex.quantity += qty; else items.push({ product, quantity: qty });
      rerender();
    });
  }

  const newBtn = view.querySelector('#new');
  if (newBtn) newBtn.addEventListener('click', openNew);
  await refresh();
}
