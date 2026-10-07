/**
 * Módulo PRODUTOS (consolidado) — listagem, busca, filtros, detalhe,
 * gestão de categorias (criar/editar/status/excluir com proteção de uso),
 * cadastro completo, desativação e exclusão protegida.
 * Preço em centavos; estoque mínimo é dado cadastral (sem "estoque atual").
 */

import { api } from '../api.js';
import { session } from '../app.js';
import {
  esc, toast, badge, dataTable, pagination, openModal, confirmDialog,
  debounce, fmtDateTime, fmtMoney, moneyToCents, maskMoneyInput, optionsHtml,
} from '../ui.js';

const state = { page: 1, search: '', category_id: '', status: '' };
const UNITS = ['UN', 'PC', 'CX', 'PCT', 'KG', 'G', 'LT', 'L', 'ML', 'MT', 'M', 'CM', 'M2', 'M3', 'PAR'];

export async function render(view) {
  const canCreate = session.hasPerm('products.create');
  const canEdit = session.hasPerm('products.edit');
  const canDelete = session.hasPerm('products.delete');

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h2>Produtos</h2>
        <p>Catálogo de produtos da sua empresa. Estoque mínimo é um dado cadastral.</p>
      </div>
      <div class="spacer"></div>
      ${canCreate ? '<button class="btn btn-primary" id="new-product">+ Novo produto</button>' : ''}
    </div>
    <div class="card" id="card"><div class="loading-line">Carregando…</div></div>`;

  const loadCategories = async () => {
    try { return await api.get('/products/categories'); } catch { return []; }
  };

  async function refresh() {
    const card = view.querySelector('#card');
    const [data, categories] = await Promise.all([
      api.get(`/products?page=${state.page}&search=${encodeURIComponent(state.search)}${state.category_id ? '&category_id=' + state.category_id : ''}${state.status ? '&status=' + state.status : ''}`),
      loadCategories(),
    ]);
    const activeCategories = categories.filter((c) => c.status === 'active');

    card.innerHTML = `
      <div class="toolbar" style="padding:14px 14px 0">
        <input class="input" id="search" placeholder="Buscar por nome, SKU ou código de barras…" value="${esc(state.search)}">
        <select class="input" id="f-category" style="width:180px">
          <option value="">Todas as categorias</option>
          ${optionsHtml(categories, state.category_id)}
        </select>
        <select class="input" id="f-status" style="width:140px">
          <option value="">Todos</option>
          <option value="active" ${state.status === 'active' ? 'selected' : ''}>Ativos</option>
          <option value="inactive" ${state.status === 'inactive' ? 'selected' : ''}>Inativos</option>
        </select>
        ${canCreate ? '<button class="btn btn-ghost btn-sm" id="manage-categories">Categorias</button>' : ''}
      </div>
      ${dataTable([
        { label: 'Produto', render: (p) => `
          <div class="td-main">${esc(p.name)}</div>
          <div class="td-sub">${[p.sku && `SKU ${p.sku}`, p.barcode && `EAN ${p.barcode}`].filter(Boolean).join(' · ') || esc(p.category_name || '')}</div>` },
        { label: 'Categoria', render: (p) => esc(p.category_name || '—') },
        { label: 'Unid.', render: (p) => esc(p.unit) },
        { label: 'Preço', render: (p) => `<strong>${esc(fmtMoney(p.price_cents))}</strong>` },
        { label: 'Estoque mín.', render: (p) => `<span class="td-sub">${p.minimum_stock ?? '—'}</span>` },
        { label: 'Status', render: (p) => badge(p.status) },
        { label: '', class: 'td-actions', render: (p) => `
          <button class="btn-link" data-view="${p.id}">Detalhes</button>
          ${canEdit ? `<button class="btn-link" data-edit="${p.id}">Editar</button>` : ''}
          ${canEdit ? `<button class="btn-link" data-toggle="${p.id}" data-status="${p.status}">${p.status === 'active' ? 'Desativar' : 'Reativar'}</button>` : ''}
          ${canDelete ? `<button class="btn-link danger" data-del="${p.id}">Excluir</button>` : ''}
        ` },
      ], data.items, 'Nenhum produto encontrado com esses filtros.')}
      ${pagination({ ...data, onPage: (p) => { state.page = p; refresh(); } })}`;

    card.querySelector('#search').addEventListener('input', debounce((e) => {
      state.search = e.target.value.trim(); state.page = 1; refresh();
    }));
    card.querySelector('#f-category').addEventListener('change', (e) => {
      state.category_id = e.target.value; state.page = 1; refresh();
    });
    card.querySelector('#f-status').addEventListener('change', (e) => {
      state.status = e.target.value; state.page = 1; refresh();
    });

    const catBtn = card.querySelector('#manage-categories');
    if (catBtn) catBtn.addEventListener('click', async () => {
      const cats = await loadCategories();
      openCategoryManager(cats);
    });

    card.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', async () => {
      const p = await api.get(`/products/${b.dataset.view}`);
      openDetail(p);
    }));
    card.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      const p = data.items.find((x) => x.id === Number(b.dataset.edit));
      openForm(p, activeCategories);
    }));
    card.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
      const p = data.items.find((x) => x.id === Number(b.dataset.toggle));
      const deactivating = b.dataset.status === 'active';
      const go = await confirmDialog(
        deactivating ? `Desativar ${p.name}? O histórico será preservado; produtos inativos não entram em novas vendas.`
                     : `Reativar ${p.name}?`,
        { danger: deactivating, confirmLabel: deactivating ? 'Desativar' : 'Reativar' }
      );
      if (!go) return;
      await api.patch(`/products/${p.id}`, { status: deactivating ? 'inactive' : 'active' });
      toast(deactivating ? 'Produto desativado.' : 'Produto reativado.');
      await refresh();
    }));
    card.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      const p = data.items.find((x) => x.id === Number(b.dataset.del));
      const go = await confirmDialog(
        `Excluir ${p.name} definitivamente? Só é possível excluir produtos SEM vendas.`,
        { danger: true, confirmLabel: 'Excluir definitivamente' }
      );
      if (!go) return;
      try {
        await api.delete(`/products/${p.id}`);
        toast('Produto excluído.');
        await refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    }));
  }

  // -------------------------------------------------------------------------
  // Detalhe (somente dados reais — sem "estoque atual")
  // -------------------------------------------------------------------------
  function openDetail(p) {
    openModal({
      title: p.name,
      wide: true,
      submitLabel: 'Fechar',
      bodyHtml: `
        <div class="form-grid">
          <div class="card card-pad" style="box-shadow:none">
            <h4 class="card-title" style="font-size:13.5px">Dados do produto</h4>
            <ul class="activity-list">
              <li><div class="activity-body"><div>SKU</div><div class="when">${esc(p.sku || '—')}</div></div></li>
              <li><div class="activity-body"><div>Código de barras</div><div class="when">${esc(p.barcode || '—')}</div></div></li>
              <li><div class="activity-body"><div>Categoria</div><div class="when">${esc(p.category_name || '—')}</div></div></li>
              <li><div class="activity-body"><div>Unidade</div><div class="when">${esc(p.unit)}</div></div></li>
              <li><div class="activity-body"><div>Preço de venda</div><div class="when"><strong>${esc(fmtMoney(p.price_cents))}</strong></div></div></li>
              <li><div class="activity-body"><div>Custo</div><div class="when">${p.cost_cents != null ? esc(fmtMoney(p.cost_cents)) : '—'}</div></div></li>
              <li><div class="activity-body"><div>Estoque mínimo</div><div class="when">${p.minimum_stock ?? '—'}</div></div></li>
              <li><div class="activity-body"><div>Status</div><div class="when">${p.status === 'active' ? 'Ativo' : 'Inativo'}</div></div></li>
              <li><div class="activity-body"><div>Criado em</div><div class="when">${esc(fmtDateTime(p.created_at))}</div></div></li>
              <li><div class="activity-body"><div>Última atualização</div><div class="when">${esc(fmtDateTime(p.updated_at))}</div></div></li>
              ${p.description ? `<li><div class="activity-body"><div>Descrição</div><div class="when">${esc(p.description)}</div></div></li>` : ''}
            </ul>
            ${canDelete ? `<button class="btn btn-danger btn-sm" id="del-product" style="margin-top:8px">Excluir produto</button>` : ''}
          </div>
          <div class="card card-pad" style="box-shadow:none">
            <h4 class="card-title" style="font-size:13.5px">Sobre o estoque</h4>
            <div class="td-sub" style="line-height:1.6">
              Este produto já possui unidade, estoque mínimo e vínculo com a empresa —
              a base cadastral do futuro módulo <strong>Estoque</strong>. O controle de
              saldo, entradas, saídas e inventário será implementado no módulo Estoque.
            </div>
          </div>
        </div>`,
      onSubmit: async () => { /* apenas fecha */ },
    });
    const delBtn = document.getElementById('del-product');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        const go = await confirmDialog(`Excluir ${p.name} definitivamente? Só é possível excluir produtos SEM vendas.`, { danger: true, confirmLabel: 'Excluir definitivamente' });
        if (!go) return;
        try {
          await api.delete(`/products/${p.id}`);
          toast('Produto excluído.');
          await refresh();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }
  }

  // -------------------------------------------------------------------------
  // Gestão de categorias (backend: criar/editar/status/excluir com proteção)
  // -------------------------------------------------------------------------
  function openCategoryManager(cats) {
    openModal({
      title: 'Categorias de produtos',
      wide: true,
      submitLabel: 'Fechar',
      bodyHtml: `
        <div class="toolbar" style="margin-bottom:10px">
          <input class="input" id="cat-name" placeholder="Nova categoria…" maxlength="80" style="flex:1">
          <button class="btn btn-primary btn-sm" id="cat-add">Adicionar</button>
        </div>
        ${cats.length ? `<ul class="activity-list">${cats.map((c) => `
          <li>
            <div class="activity-body" style="flex:1"><div><strong>${esc(c.name)}</strong></div>
              <div class="when">${c.status === 'active' ? 'Ativa' : 'Inativa'}</div></div>
            <button class="btn-link" data-rename="${c.id}" data-name="${esc(c.name)}">Renomear</button>
            <button class="btn-link" data-cattoggle="${c.id}" data-status="${c.status}">${c.status === 'active' ? 'Desativar' : 'Reativar'}</button>
            <button class="btn-link danger" data-catdel="${c.id}">Excluir</button>
          </li>`).join('')}</ul>` : '<div class="td-sub">Nenhuma categoria cadastrada.</div>'}`,
      onSubmit: async () => { /* apenas fecha */ },
    });

    document.getElementById('cat-add').addEventListener('click', async () => {
      const input = document.getElementById('cat-name');
      if (!input.value.trim()) return;
      try {
        await api.post('/products/categories', { name: input.value });
        toast('Categoria cadastrada.');
        await refresh();
        openCategoryManager(await loadCategories());
      } catch (err) { toast(err.message, 'error'); }
    });
    document.querySelectorAll('[data-rename]').forEach((b) => b.addEventListener('click', () => {
      openModal({
        title: 'Renomear categoria',
        bodyHtml: `<div class="field"><label>Nome *</label>
          <input class="input" name="name" value="${esc(b.dataset.name)}" required minlength="2" maxlength="80"></div>`,
        submitLabel: 'Salvar',
        onSubmit: async (d) => {
          await api.patch(`/products/categories/${b.dataset.rename}`, { name: d.name });
          toast('Categoria renomeada.');
          await refresh();
          openCategoryManager(await loadCategories());
        },
      });
    }));
    document.querySelectorAll('[data-cattoggle]').forEach((b) => b.addEventListener('click', async () => {
      const next = b.dataset.status === 'active' ? 'inactive' : 'active';
      await api.patch(`/products/categories/${b.dataset.cattoggle}`, { status: next });
      toast(next === 'active' ? 'Categoria reativada.' : 'Categoria desativada.');
      await refresh();
      openCategoryManager(await loadCategories());
    }));
    document.querySelectorAll('[data-catdel]').forEach((b) => b.addEventListener('click', async () => {
      const go = await confirmDialog('Excluir esta categoria? Só é possível se nenhum produto a utilizar.', { danger: true, confirmLabel: 'Excluir' });
      if (!go) return;
      try {
        await api.delete(`/products/categories/${b.dataset.catdel}`);
        toast('Categoria excluída.');
        await refresh();
        openCategoryManager(await loadCategories());
      } catch (err) { toast(err.message, 'error'); }
    }));
  }

  // -------------------------------------------------------------------------
  // Formulário de produto
  // -------------------------------------------------------------------------
  function openForm(p = null, categories = []) {
    const v = (k) => esc(p?.[k] ?? '');
    openModal({
      title: p ? `Editar produto — ${p.name}` : 'Novo produto',
      wide: true,
      bodyHtml: `
        <div class="form-grid">
          <div class="field full"><label>Nome *</label>
            <input class="input" name="name" value="${v('name')}" required minlength="2" maxlength="120"></div>
          <div class="field"><label>Categoria</label>
            <select class="input" name="category_id">
              <option value="">— Sem categoria —</option>
              ${optionsHtml(categories, p?.category_id)}
            </select></div>
          <div class="field"><label>Unidade *</label>
            <select class="input" name="unit">
              ${UNITS.map((u) => `<option value="${u}" ${(p?.unit || 'UN') === u ? 'selected' : ''}>${u}</option>`).join('')}
            </select></div>
          <div class="field"><label>SKU</label>
            <input class="input" name="sku" value="${v('sku')}" maxlength="40"></div>
          <div class="field"><label>Código de barras</label>
            <input class="input" name="barcode" value="${v('barcode')}" maxlength="40"></div>
          <div class="field"><label>Preço de venda (R$) *</label>
            <input class="input" name="price" id="f-price" inputmode="decimal" required
                   value="${p ? (p.price_cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : ''}"></div>
          <div class="field"><label>Custo (R$)</label>
            <input class="input" name="cost" id="f-cost" inputmode="decimal"
                   value="${p?.cost_cents != null ? (p.cost_cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : ''}"></div>
          <div class="field"><label>Estoque mínimo</label>
            <input class="input" type="number" name="minimum_stock" min="0" step="1" value="${p?.minimum_stock ?? ''}"></div>
          <div class="field full"><label>Descrição</label>
            <textarea class="input" name="description" rows="2" maxlength="500">${v('description')}</textarea></div>
        </div>`,
      submitLabel: p ? 'Salvar alterações' : 'Cadastrar produto',
      onSubmit: async (d) => {
        const price = moneyToCents(d.price);
        if (!Number.isFinite(price) || price <= 0) { toast('Informe um preço válido.', 'error'); return; }
        const cost = d.cost ? moneyToCents(d.cost) : null;
        if (cost !== null && (!Number.isFinite(cost) || cost <= 0)) { toast('Custo inválido.', 'error'); return; }
        const payload = {
          name: d.name, category_id: d.category_id ? Number(d.category_id) : null,
          unit: d.unit, sku: d.sku || null, barcode: d.barcode || null,
          price: price / 100, cost: cost !== null ? cost / 100 : null,
          minimum_stock: d.minimum_stock === '' ? null : Number(d.minimum_stock),
          description: d.description || null,
        };
        if (p) {
          await api.patch(`/products/${p.id}`, payload);
          toast('Produto atualizado.');
        } else {
          await api.post('/products', payload);
          toast('Produto cadastrado.');
          state.page = 1;
        }
        await refresh();
      },
    });
    for (const id of ['#f-price', '#f-cost']) {
      const el = document.querySelector(id);
      if (el) maskMoneyInput(el);
    }
  }

  const newBtn = view.querySelector('#new-product');
  if (newBtn) newBtn.addEventListener('click', async () => {
    const cats = (await loadCategories()).filter((c) => c.status === 'active');
    openForm(null, cats);
  });

  await refresh();
}
