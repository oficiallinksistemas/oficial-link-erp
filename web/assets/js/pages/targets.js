/**
 * Módulo METAS (v1.3.1) — correções:
 * - campo "Vendedor" lista APENAS usuários com função "seller" (o backend
 *   também rejeita qualquer outro vínculo — dupla validação);
 * - desempenho vem EMBUTIDO na listagem (achieved_cents/percent/missing_cents/
 *   reached) — uma única requisição, sem N+1.
 * Segurança real no backend: módulo ativo + permissão + escopo por tenant.
 */

import { api } from '../api.js';
import { session } from '../app.js';
import {
  esc, toast, dataTable, pagination, openModal, confirmDialog,
  fmtDate, fmtMoney, moneyToCents, maskMoneyInput, optionsHtml,
} from '../ui.js';

const state = { page: 1, type: '', user_id: '', store_id: '', from: '', to: '' };

function progressBar(percent) {
  const pct = Math.min(Math.max(percent, 0), 100);
  const done = percent >= 100;
  return `
    <div class="progress" title="${esc(String(percent))}% atingido">
      <div class="progress-track"><div class="progress-fill ${done ? 'done' : ''}" style="width:${pct}%"></div></div>
      <span class="progress-value ${done ? 'done' : ''}">${esc(String(percent))}%</span>
    </div>`;
}

export async function render(view) {
  const canCreate = session.hasPerm('targets.create');
  const canEdit = session.hasPerm('targets.edit');
  const canDelete = session.hasPerm('targets.delete');

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h2>Metas</h2>
        <p>Metas comerciais por vendedor ou loja, com acompanhamento automático sobre as vendas.</p>
      </div>
      <div class="spacer"></div>
      ${canCreate ? '<button class="btn btn-primary" id="new-target">+ Nova meta</button>' : ''}
    </div>
    <div class="cards-grid" id="indicators"><div class="loading-line">Carregando…</div></div>
    <div class="card" id="card"><div class="loading-line">Carregando…</div></div>`;

  const [stores, users] = await Promise.all([
    api.get('/stores?per_page=50'),
    api.get('/users?per_page=50'),
  ]);
  // V1.3.1 — somente usuários com função "seller" podem ser vinculados como vendedor
  const sellers = { items: users.items.filter((u) => u.role_slug === 'seller') };

  function renderIndicators(items) {
    const box = view.querySelector('#indicators');
    const totalTarget = items.reduce((acc, t) => acc + t.target_cents, 0);
    let totalAchieved = 0;
    for (const t of items) totalAchieved += Math.min(t.achieved_cents || 0, t.target_cents);
    const avgPercent = items.length
      ? Math.round(items.reduce((acc, t) => acc + (t.percent || 0), 0) / items.length * 10) / 10
      : 0;
    const card = (label, value, ico) => `
      <div class="card stat-card">
        <span class="stat-ico">${ico}</span>
        <span class="stat-label">${esc(label)}</span>
        <span class="stat-value ${String(value).length > 10 ? 'small' : ''}">${esc(value)}</span>
      </div>`;
    box.innerHTML =
      card('Metas no período', String(items.length), '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 3v18M5 12h14"/><circle cx="12" cy="12" r="8.5"/></svg>') +
      card('Meta total definida', fmtMoney(totalTarget), '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="8.5"/><path d="M8.5 9.5l1.1 4.4a1.6 1.6 0 0 0 1.6 1.3h4.4M9.5 8.5h5M15 8.2l.8 4.3a1.5 1.5 0 0 1-1.5 1.8h-3.6"/></svg>') +
      card('Realizado', fmtMoney(totalAchieved), '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>') +
      card('Percentual médio', `${avgPercent}%`, '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 20V4M4 20h16M8 16v-5M12 16V7M16 16v-3"/></svg>');
  }

  async function refresh() {
    const card = view.querySelector('#card');
    const params = new URLSearchParams({ page: state.page });
    if (state.type) params.set('type', state.type);
    if (state.user_id) params.set('user_id', state.user_id);
    if (state.store_id) params.set('store_id', state.store_id);
    if (state.from) params.set('from', state.from);
    if (state.to) params.set('to', state.to);

    const data = await api.get(`/targets?${params}`);
    // Indicadores usam a primeira página (até 50) — sem N+1: desempenho já
    // vem embutido em cada item da listagem
    const ind = await api.get('/targets?per_page=50');
    renderIndicators(ind.items);

    card.innerHTML = `
      <div class="toolbar" style="padding:14px 14px 0">
        <select class="input" id="f-type" style="width:160px">
          <option value="">Todos os tipos</option>
          <option value="seller" ${state.type === 'seller' ? 'selected' : ''}>Por vendedor</option>
          <option value="store" ${state.type === 'store' ? 'selected' : ''}>Por loja</option>
        </select>
        <select class="input" id="f-user" style="width:170px">
          <option value="">Todos os vendedores</option>
          ${optionsHtml(sellers.items, state.user_id)}
        </select>
        <select class="input" id="f-store" style="width:160px">
          <option value="">Todas as lojas</option>
          ${optionsHtml(stores.items, state.store_id)}
        </select>
        <input class="input" type="date" id="f-from" style="width:150px" value="${esc(state.from)}" title="De">
        <input class="input" type="date" id="f-to" style="width:150px" value="${esc(state.to)}" title="Até">
      </div>
      ${dataTable([
        { label: 'Tipo', render: (t) => t.type === 'seller' ? 'Vendedor' : 'Loja' },
        { label: 'Vendedor / Loja', render: (t) => `<div class="td-main">${esc(t.seller_name || t.store_name)}</div>` },
        { label: 'Período', render: (t) => `<span class="td-sub">${esc(fmtDate(t.start_date))} → ${esc(fmtDate(t.end_date))}</span>` },
        { label: 'Meta', render: (t) => `<strong>${esc(fmtMoney(t.target_cents))}</strong>` },
        { label: 'Realizado', render: (t) => esc(fmtMoney(t.achieved_cents || 0)) },
        { label: '% atingido', render: (t) => progressBar(t.percent || 0) },
        { label: 'Falta', render: (t) => esc(fmtMoney(t.missing_cents ?? Math.max(t.target_cents - (t.achieved_cents || 0), 0))) },
        { label: '', class: 'td-actions', render: (t) => `
          ${canEdit ? `<button class="btn-link" data-edit="${t.id}">Editar</button>` : ''}
          ${canDelete ? `<button class="btn-link danger" data-del="${t.id}">Excluir</button>` : ''}
        ` },
      ], data.items, 'Nenhuma meta encontrada com esses filtros.')}
      ${pagination({ ...data, onPage: (p) => { state.page = p; refresh(); } })}`;

    const bind = (id, key) => card.querySelector(id).addEventListener('change', (e) => {
      state[key] = e.target.value; state.page = 1; refresh();
    });
    bind('#f-type', 'type'); bind('#f-user', 'user_id'); bind('#f-store', 'store_id');
    bind('#f-from', 'from'); bind('#f-to', 'to');

    card.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      const t = data.items.find((x) => x.id === Number(b.dataset.edit));
      openModal({
        title: `Editar meta — ${t.seller_name || t.store_name}`,
        bodyHtml: formHtml(t),
        submitLabel: 'Salvar alterações',
        onSubmit: async (d) => {
          const cents = moneyToCents(d.target_value);
          if (!Number.isFinite(cents) || cents <= 0) { toast('Informe um valor válido.', 'error'); return; }
          await api.patch(`/targets/${t.id}`, {
            type: d.type,
            user_id: d.type === 'seller' ? Number(d.user_id) : undefined,
            store_id: d.type === 'store' ? Number(d.store_id) : undefined,
            start_date: d.start_date, end_date: d.end_date,
            target_value: cents / 100,
            notes: d.notes || null,
          });
          toast('Meta atualizada.');
          await refresh();
        },
      });
      bindTypeToggle(document); bindMask(document);
    }));

    card.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      const t = data.items.find((x) => x.id === Number(b.dataset.del));
      const go = await confirmDialog(
        `Excluir a meta de ${t.seller_name || t.store_name} (${fmtMoney(t.target_cents)})? Essa ação remove o registro de meta.`,
        { danger: true, confirmLabel: 'Excluir meta' }
      );
      if (!go) return;
      await api.delete(`/targets/${t.id}`);
      toast('Meta excluída.');
      await refresh();
    }));
  }

  function formHtml(t = null) {
    const type = t?.type || 'seller';
    return `
      <div class="form-grid">
        <div class="field full">
          <label>Tipo de meta *</label>
          <select class="input" name="type" id="t-type">
            <option value="seller" ${type === 'seller' ? 'selected' : ''}>Por vendedor</option>
            <option value="store" ${type === 'store' ? 'selected' : ''}>Por loja</option>
          </select>
        </div>
        <div class="field" id="wrap-user">
          <label>Vendedor *</label>
          <select class="input" name="user_id">${optionsHtml(sellers.items, t?.user_id)}</select>
        </div>
        <div class="field" id="wrap-store">
          <label>Loja *</label>
          <select class="input" name="store_id">${optionsHtml(stores.items, t?.store_id)}</select>
        </div>
        <div class="field">
          <label>Data inicial *</label>
          <input class="input" type="date" name="start_date" required value="${esc(t?.start_date || '')}">
        </div>
        <div class="field">
          <label>Data final *</label>
          <input class="input" type="date" name="end_date" required value="${esc(t?.end_date || '')}">
        </div>
        <div class="field full">
          <label>Valor da meta (R$) *</label>
          <input class="input" name="target_value" id="f-value" inputmode="decimal" required
                 placeholder="0,00" value="${t ? (t.target_cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : ''}">
        </div>
        <div class="field full">
          <label>Observação</label>
          <input class="input" name="notes" value="${esc(t?.notes || '')}" maxlength="500">
        </div>
      </div>`;
  }

  function bindTypeToggle(root) {
    const typeSel = root.querySelector('#t-type');
    if (!typeSel) return;
    const update = () => {
      const isSeller = typeSel.value === 'seller';
      root.querySelector('#wrap-user').style.display = isSeller ? '' : 'none';
      root.querySelector('#wrap-store').style.display = isSeller ? 'none' : '';
    };
    typeSel.addEventListener('change', update);
    update();
  }

  function bindMask(root) {
    const v = root.querySelector('#f-value');
    if (v) maskMoneyInput(v);
  }

  const newBtn = view.querySelector('#new-target');
  if (newBtn) {
    newBtn.addEventListener('click', () => {
      openModal({
        title: 'Nova meta',
        bodyHtml: formHtml(),
        submitLabel: 'Cadastrar meta',
        onSubmit: async (d) => {
          const cents = moneyToCents(d.target_value);
          if (!Number.isFinite(cents) || cents <= 0) { toast('Informe um valor válido.', 'error'); return; }
          await api.post('/targets', {
            type: d.type,
            user_id: d.type === 'seller' ? Number(d.user_id) : undefined,
            store_id: d.type === 'store' ? Number(d.store_id) : undefined,
            start_date: d.start_date, end_date: d.end_date,
            target_value: cents / 100,
            notes: d.notes || null,
          });
          toast('Meta cadastrada.');
          state.page = 1;
          await refresh();
        },
      });
      bindTypeToggle(document); bindMask(document);
    });
  }

  await refresh();
}
