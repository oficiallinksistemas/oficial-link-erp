/**
 * Módulo VENDAS (v1.8) — novo lançamento com CARRINHO multi-item (preço do
 * catálogo, total calculado pelo backend) + fluxo legado (valor livre) para
 * empresas sem catálogo. Edição de venda com itens: somente dados gerais —
 * itens/valor não podem ser alterados (cancelar e recriar).
 */

import { api } from '../api.js';
import { session } from '../app.js';
import {
  esc, toast, badge, dataTable, pagination, openModal, confirmDialog,
  debounce, fmtDate, fmtMoney, moneyToCents, maskMoneyInput, optionsHtml,
} from '../ui.js';

const state = { page: 1, search: '', store_id: '', status: '' };

function saleBadge(status) {
  return status === 'canceled' ? '<span class="badge badge-suspended">Cancelada</span>'
    : '<span class="badge badge-active">Ativa</span>';
}

export async function render(view) {
  const canCreate = session.hasPerm('sales.create');
  const canEdit = session.hasPerm('sales.edit');
  const canCancel = session.hasPerm('sales.cancel');

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h2>Vendas</h2>
        <p>Registros de vendas da sua empresa.</p>
      </div>
      <div class="spacer"></div>
      ${canCreate ? '<button class="btn btn-primary" id="new-sale">+ Nova venda</button>' : ''}
    </div>
    <div class="card" id="card"><div class="loading-line">Carregando…</div></div>`;

  const [stores, sellers, products, stockView] = await Promise.all([
    api.get('/stores?per_page=50'),
    api.get('/users?per_page=50'),
    api.get('/products?per_page=100&status=active').catch(() => ({ items: [] })),
    api.get(`/stock?per_page=100${''}`).catch(() => null),
  ]);
  const stockByProduct = new Map();
  if (stockView) for (const row of stockView.items) stockByProduct.set(row.product_id, row.quantity);
  const useCart = products.items.length > 0;

  async function refresh() {
    const card = view.querySelector('#card');
    const params = new URLSearchParams({ page: state.page });
    if (state.search) params.set('search', state.search);
    if (state.store_id) params.set('store_id', state.store_id);
    if (state.status) params.set('status', state.status);
    const data = await api.get(`/sales?${params}`);

    card.innerHTML = `
      <div class="toolbar" style="padding:14px 14px 0">
        <select class="input" id="f-store" style="width:190px">
          <option value="">Todas as lojas</option>
          ${optionsHtml(stores.items, state.store_id)}
        </select>
        <select class="input" id="f-status" style="width:150px">
          <option value="">Todos os status</option>
          <option value="active" ${state.status === 'active' ? 'selected' : ''}>Ativas</option>
          <option value="canceled" ${state.status === 'canceled' ? 'selected' : ''}>Canceladas</option>
        </select>
        <input class="input" id="search" placeholder="Buscar por cliente…" value="${esc(state.search)}">
      </div>
      ${dataTable([
        { label: 'Data', render: (s) => `<span class="td-sub">${esc(fmtDate(s.sold_at))}</span>` },
        { label: 'Cliente', render: (s) => `<div class="td-main">${esc(s.customer_name)}</div>${s.note ? `<div class="td-sub">${esc(s.note)}</div>` : ''}` },
        { label: 'Produto(s)', render: (s) => `<span class="td-sub">${esc(s.product_name || (s.items_count > 0 ? `${s.items_count} item(ns)` : '—'))}</span>` },
        { label: 'Loja', render: (s) => esc(s.store_name) },
        { label: 'Vendedor', render: (s) => esc(s.seller_name) },
        { label: 'Valor', render: (s) => `<strong>${esc(fmtMoney(s.amount_cents))}</strong>` },
        { label: 'Status', render: (s) => saleBadge(s.status) },
        { label: '', class: 'td-actions', render: (s) => `
          ${canEdit && s.status === 'active' && !s.items_count ? `<button class="btn-link" data-edit="${s.id}">Editar</button>` : ''}
          ${canCancel && s.status === 'active' ? `<button class="btn-link danger" data-cancel="${s.id}">Cancelar</button>` : ''}
        ` },
      ], data.items, 'Nenhuma venda encontrada com esses filtros.')}
      ${pagination({ ...data, onPage: (p) => { state.page = p; refresh(); } })}`;

    card.querySelector('#f-store').addEventListener('change', (e) => {
      state.store_id = e.target.value; state.page = 1; refresh();
    });
    card.querySelector('#f-status').addEventListener('change', (e) => {
      state.status = e.target.value; state.page = 1; refresh();
    });
    card.querySelector('#search').addEventListener('input', debounce((e) => {
      state.search = e.target.value.trim(); state.page = 1; refresh();
    }));
    card.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      const sale = data.items.find((s) => s.id === Number(b.dataset.edit));
      openEditModal(sale);
    }));
    card.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', () => {
      const sale = data.items.find((s) => s.id === Number(b.dataset.cancel));
      openCancelModal(sale);
    }));
  }

  // -------------------------------------------------------------------------
  // NOVA VENDA — carrinho multi-item quando há catálogo; fluxo legado senão
  // -------------------------------------------------------------------------
  function openNewModal() {
    const cart = []; // {product, quantity}
    const today = new Date().toISOString().slice(0, 10);

    const cartRows = () => cart.map((it, i) => `
      <tr>
        <td>${esc(it.product.name)}</td>
        <td><input class="input" style="width:70px;padding:4px 8px" type="number" min="1" step="1" value="${it.quantity}" data-qty="${i}"></td>
        <td>${esc(fmtMoney(it.product.price_cents))}</td>
        <td>${esc(fmtMoney(it.product.price_cents * it.quantity))}</td>
        <td><button class="btn-link danger" data-remove="${i}">Remover</button></td>
      </tr>`).join('');

    const cartTotal = () => cart.reduce((acc, it) => acc + it.product.price_cents * it.quantity, 0);

    const bodyHtml = () => `
      <div class="form-grid">
        <div class="field"><label>Cliente *</label>
          <input class="input" name="customer_name" required minlength="2" maxlength="120"></div>
        <div class="field"><label>Data da venda *</label>
          <input class="input" type="date" name="sold_at" required value="${today}"></div>
        <div class="field"><label>Loja *</label>
          <select class="input" name="store_id" id="cart-store">${optionsHtml(stores.items)}</select></div>
        <div class="field"><label>Vendedor *</label>
          <select class="input" name="seller_id">${optionsHtml(sellers.items)}</select></div>
      </div>
      ${useCart ? `
        <div class="card card-pad" style="box-shadow:none; margin-bottom:14px">
          <h4 class="card-title" style="font-size:13.5px">Itens da venda</h4>
          <div class="toolbar" style="margin-bottom:8px">
            <select class="input" id="cart-product" style="flex:1">
              ${products.items.map((p) => `<option value="${p.id}">${esc(p.name)} — ${esc(fmtMoney(p.price_cents))}${stockByProduct.has(p.id) ? ` (disp. ${stockByProduct.get(p.id)})` : ''}</option>`).join('')}
            </select>
            <input class="input" id="cart-qty" type="number" min="1" step="1" value="1" style="width:80px">
            <button class="btn btn-ghost btn-sm" id="cart-add" type="button">Adicionar</button>
          </div>
          <div id="cart-wrap">${cart.length ? `
            <div class="table-wrap"><table class="table">
              <thead><tr><th>Produto</th><th>Qtd</th><th>Preço unit.</th><th>Subtotal</th><th></th></tr></thead>
              <tbody>${cartRows()}</tbody>
            </table></div>
            <p style="text-align:right;margin-top:8px"><strong>TOTAL: ${esc(fmtMoney(cartTotal()))}</strong></p>`
          : '<div class="td-sub">Nenhum item adicionado. Sem itens, informe o valor total abaixo.</div>'}</div>
        </div>` : ''}
      <div class="form-grid">
        ${useCart ? `
        <div class="field" id="wrap-amount" style="display:${cart.length ? 'none' : ''}">
          <label>Valor total (R$) ${cart.length ? '' : '*'}</label>
          <input class="input" name="amount" id="f-amount" inputmode="decimal" ${cart.length ? '' : 'required'} placeholder="0,00">
        </div>` : `
        <div class="field">
          <label>Valor (R$) *</label>
          <input class="input" name="amount" id="f-amount" inputmode="decimal" required placeholder="0,00">
        </div>`}
        <div class="field full"><label>Observação</label>
          <input class="input" name="note" maxlength="500"></div>
      </div>`;

    const modal = openModal({
      title: 'Nova venda',
      bodyHtml: bodyHtml(),
      submitLabel: 'Registrar venda',
      onSubmit: async (d) => {
        const payload = {
          customer_name: d.customer_name,
          store_id: Number(d.store_id),
          seller_id: Number(d.seller_id),
          sold_at: d.sold_at,
          note: d.note || null,
        };
        if (cart.length) {
          payload.items = cart.map((it) => ({ product_id: it.product.id, quantity: it.quantity }));
        } else {
          const cents = moneyToCents(d.amount);
          if (!Number.isFinite(cents) || cents <= 0) { toast('Informe um valor válido ou adicione itens.', 'error'); return; }
          payload.amount = cents / 100;
        }
        await api.post('/sales', payload);
        toast('Venda registrada.');
        state.page = 1;
        await refresh();
      },
    });

    if (useCart) {
      const addBtn = document.getElementById('cart-add');
      // Disponibilidade POR LOJA SELECIONADA: recarrega ao trocar de loja
      // (UX — o backend continua sendo a autoridade final).
      const reloadAvailability = async () => {
        const storeId = document.getElementById('cart-store').value;
        try {
          const view = await api.get(`/stock?store_id=${storeId}&per_page=100`);
          stockByProduct.clear();
          for (const row of view.items) stockByProduct.set(row.product_id, row.quantity);
        } catch { stockByProduct.clear(); }
        const selProd = document.getElementById('cart-product');
        if (selProd) {
          selProd.innerHTML = products.items.map((p) => `<option value="${p.id}">${esc(p.name)} — ${esc(fmtMoney(p.price_cents))}${stockByProduct.has(p.id) ? ` (disp. ${stockByProduct.get(p.id)})` : ''}</option>`).join('');
        }
      };
      document.getElementById('cart-store').addEventListener('change', reloadAvailability);
      reloadAvailability();

      const rerenderCart = () => {
        const wrap = document.getElementById('cart-wrap');
        const amountWrap = document.getElementById('wrap-amount');
        if (cart.length) {
          wrap.innerHTML = `
            <div class="table-wrap"><table class="table">
              <thead><tr><th>Produto</th><th>Qtd</th><th>Preço unit.</th><th>Subtotal</th><th></th></tr></thead>
              <tbody>${cartRows()}</tbody></table></div>
            <p style="text-align:right;margin-top:8px"><strong>TOTAL: ${esc(fmtMoney(cartTotal()))}</strong></p>`;
          if (amountWrap) amountWrap.style.display = 'none';
        } else {
          wrap.innerHTML = '<div class="td-sub">Nenhum item adicionado. Sem itens, informe o valor total abaixo.</div>';
          if (amountWrap) amountWrap.style.display = '';
        }
        wrap.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => {
          cart.splice(Number(b.dataset.remove), 1); rerenderCart();
        }));
        wrap.querySelectorAll('[data-qty]').forEach((input) => input.addEventListener('change', () => {
          const q = Number(input.value);
          if (Number.isInteger(q) && q > 0) cart[Number(input.dataset.qty)].quantity = q;
          rerenderCart();
        }));
      };
      addBtn.addEventListener('click', () => {
        const pid = Number(document.getElementById('cart-product').value);
        const qty = Number(document.getElementById('cart-qty').value);
        if (!Number.isInteger(qty) || qty <= 0) { toast('Quantidade inválida.', 'error'); return; }
        const product = products.items.find((p) => p.id === pid);
        if (!product) return;
        const existing = cart.find((it) => it.product.id === pid);
        if (existing) existing.quantity += qty; // regra: duplicado incrementa
        else cart.push({ product, quantity: qty });
        document.getElementById('cart-qty').value = '1';
        rerenderCart();
      });
    }
    const amt = document.getElementById('f-amount');
    if (amt) maskMoneyInput(amt);
  }

  // -------------------------------------------------------------------------
  // EDIÇÃO — apenas vendas legadas (sem itens); com itens: só cancelar/recriar
  // -------------------------------------------------------------------------
  function openEditModal(sale) {
    const today = new Date().toISOString().slice(0, 10);
    openModal({
      title: `Editar venda — ${sale.customer_name}`,
      bodyHtml: `
        <div class="form-grid">
          <div class="field"><label>Cliente *</label>
            <input class="input" name="customer_name" value="${esc(sale.customer_name)}" required minlength="2" maxlength="120"></div>
          <div class="field"><label>Valor (R$) *</label>
            <input class="input" name="amount" id="f-amount" inputmode="decimal" required
                   value="${(sale.amount_cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}"></div>
          <div class="field"><label>Loja *</label>
            <select class="input" name="store_id">${optionsHtml(stores.items, sale.store_id)}</select></div>
          <div class="field"><label>Vendedor *</label>
            <select class="input" name="seller_id">${optionsHtml(sellers.items, sale.seller_id)}</select></div>
          <div class="field"><label>Data da venda *</label>
            <input class="input" type="date" name="sold_at" required value="${esc(String(sale.sold_at).slice(0, 10))}"></div>
          <div class="field"><label>Produto (opcional)</label>
            <select class="input" name="product_id">
              <option value="">— Sem produto —</option>
              ${sale.product_id && !products.items.some((p) => p.id === sale.product_id)
                ? `<option value="${sale.product_id}" selected>${esc(sale.product_name || 'Produto')} (indisponível no catálogo)</option>` : ''}
              ${optionsHtml(products.items, sale.product_id)}
            </select></div>
          <div class="field full"><label>Observação</label>
            <input class="input" name="note" value="${esc(sale.note || '')}" maxlength="500"></div>
        </div>`,
      submitLabel: 'Salvar alterações',
      onSubmit: async (d) => {
        const cents = moneyToCents(d.amount);
        if (!Number.isFinite(cents) || cents <= 0) { toast('Informe um valor válido.', 'error'); return; }
        await api.patch(`/sales/${sale.id}`, {
          customer_name: d.customer_name,
          amount: cents / 100,
          store_id: Number(d.store_id),
          seller_id: Number(d.seller_id),
          product_id: d.product_id ? Number(d.product_id) : null,
          sold_at: d.sold_at,
          note: d.note || null,
        });
        toast('Venda atualizada.');
        await refresh();
      },
    });
    const amt = document.getElementById('f-amount');
    if (amt) maskMoneyInput(amt);
  }

  function openCancelModal(sale) {
    openModal({
      title: `Cancelar venda — ${sale.customer_name}`,
      bodyHtml: `
        <div class="alert alert-warning">A venda de <strong>${esc(fmtMoney(sale.amount_cents))}</strong>
        será cancelada${sale.items_count ? ' e o estoque dos itens será estornado' : ''}.
        Essa ação não apaga o registro, mas o torna imutável.</div>
        <div class="field">
          <label>Motivo do cancelamento *</label>
          <textarea class="input" name="reason" rows="3" required minlength="3" maxlength="300"></textarea>
        </div>`,
      submitLabel: 'Cancelar venda',
      onSubmit: async (d) => {
        await api.post(`/sales/${sale.id}/cancel`, { reason: d.reason });
        toast('Venda cancelada' + (sale.items_count ? ' e estoque estornado.' : '.'));
        await refresh();
      },
    });
  }

  const newBtn = view.querySelector('#new-sale');
  if (newBtn) newBtn.addEventListener('click', openNewModal);

  await refresh();
}
