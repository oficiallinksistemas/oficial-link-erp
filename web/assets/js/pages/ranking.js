/**
 * Módulo RANKING (v1.4) — ranking de vendedores e lojas derivado de vendas +
 * metas. Uma única requisição agregada por visão (sem N+1, sem peso).
 */

import { api } from '../api.js';
import { esc, toast, dataTable, fmtMoney, optionsHtml } from '../ui.js';

const state = { tab: 'sellers', from: '', to: '', store_id: '', preset: 'month' };

function dateStr(d) {
  return d.toISOString().slice(0, 10);
}

function presetDates(preset) {
  const now = new Date();
  const day = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  if (preset === 'today') return { from: dateStr(day), to: dateStr(day) };
  if (preset === 'week') {
    const dow = (day.getUTCDay() + 6) % 7; // seg=0
    const start = new Date(day); start.setUTCDate(day.getUTCDate() - dow);
    return { from: dateStr(start), to: dateStr(day) };
  }
  // month
  const first = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
  const last = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 0));
  return { from: dateStr(first), to: dateStr(last) };
}

function rankPos(pos) {
  const cls = pos === 1 ? 'top1' : pos === 2 ? 'top2' : pos === 3 ? 'top3' : '';
  return `<span class="rank-pos ${cls}">${pos}º</span>`;
}

function progressBar(percent) {
  if (percent === null || percent === undefined) return '<span class="td-sub">—</span>';
  const pct = Math.min(Math.max(percent, 0), 100);
  const done = percent >= 100;
  return `
    <div class="progress" style="min-width:120px" title="${esc(String(percent))}% da meta">
      <div class="progress-track"><div class="progress-fill ${done ? 'done' : ''}" style="width:${pct}%"></div></div>
      <span class="progress-value ${done ? 'done' : ''}">${esc(String(percent))}%</span>
    </div>`;
}

export async function render(view) {
  view.innerHTML = `
    <div class="page-head">
      <div>
        <h2>Ranking</h2>
        <p>Desempenho comercial por vendedor ou loja, calculado sobre as vendas e metas.</p>
      </div>
    </div>
    <div class="card">
      <div class="toolbar" style="padding:14px 14px 0">
        <div class="tabs" style="margin-right:8px">
          <button class="tab active" data-tab="sellers">Vendedores</button>
          <button class="tab" data-tab="stores">Lojas</button>
        </div>
        <div class="spacer"></div>
        <select class="input" id="f-preset" style="width:140px">
          <option value="month" ${state.preset === 'month' ? 'selected' : ''}>Este mês</option>
          <option value="week" ${state.preset === 'week' ? 'selected' : ''}>Esta semana</option>
          <option value="today" ${state.preset === 'today' ? 'selected' : ''}>Hoje</option>
          <option value="custom" ${state.preset === 'custom' ? 'selected' : ''}>Personalizado</option>
        </select>
        <input class="input" type="date" id="f-from" style="width:150px" value="${esc(state.from)}" title="De">
        <input class="input" type="date" id="f-to" style="width:150px" value="${esc(state.to)}" title="Até">
        <select class="input" id="f-store" style="width:180px">
          <option value="">Todas as lojas</option>
        </select>
      </div>
      <div class="cards-grid" id="summary" style="padding:14px 14px 0; margin-bottom:0"></div>
      <div id="table" style="padding-top:6px"><div class="loading-line">Carregando…</div></div>
    </div>`;

  const stores = await api.get('/stores?per_page=50');
  const storeSel = view.querySelector('#f-store');
  storeSel.innerHTML = '<option value="">Todas as lojas</option>' + optionsHtml(stores.items, state.store_id);

  async function refresh() {
    const table = view.querySelector('#table');
    const summary = view.querySelector('#summary');
    const preset = state.preset === 'custom'
      ? { from: state.from, to: state.to }
      : presetDates(state.preset);
    if (state.preset !== 'custom') { state.from = preset.from; state.to = preset.to; }
    view.querySelector('#f-from').value = state.from;
    view.querySelector('#f-to').value = state.to;

    const params = new URLSearchParams({ from: state.from, to: state.to });
    if (state.tab === 'sellers' && state.store_id) params.set('store_id', state.store_id);
    view.querySelector('#f-store').style.display = state.tab === 'sellers' ? '' : 'none';

    try {
      if (state.tab === 'sellers') {
        const data = await api.get(`/ranking?${params}`);
        const s = data.summary;
        summary.innerHTML = `
          <div class="card stat-card"><span class="stat-label">Total vendido</span><span class="stat-value small">${esc(fmtMoney(s.total_cents))}</span></div>
          <div class="card stat-card"><span class="stat-label">Vendas no período</span><span class="stat-value">${esc(String(s.sales_count))}</span></div>
          <div class="card stat-card"><span class="stat-label">Líder</span><span class="stat-value small">${esc(s.leader ? s.leader.name : '—')}</span><span class="stat-hint">${s.leader ? esc(fmtMoney(s.leader.total_cents)) : 'sem vendas'}</span></div>
          <div class="card stat-card"><span class="stat-label">% médio da meta</span><span class="stat-value">${s.avg_meta_percent === null ? '—' : esc(String(s.avg_meta_percent)) + '%'}</span></div>`;
        table.innerHTML = dataTable([
          { label: '', class: '', render: (r) => rankPos(r.position) },
          { label: 'Vendedor', render: (r) => `<div class="td-main">${esc(r.name)}</div>` },
          { label: 'Vendas', render: (r) => `<strong>${esc(fmtMoney(r.total_cents))}</strong>` },
          { label: 'Quantidade', render: (r) => esc(String(r.sales_count)) },
          { label: 'Meta', render: (r) => r.target_cents === null ? '<span class="td-sub">—</span>' : esc(fmtMoney(r.target_cents)) },
          { label: '% Meta', render: (r) => progressBar(r.percent) },
          { label: 'Dif. p/ líder', render: (r) => r.gap_to_leader_cents > 0 ? `<span class="td-sub">${esc(fmtMoney(r.gap_to_leader_cents))}</span>` : '<span class="badge badge-active">Líder</span>' },
        ], data.items, 'Nenhuma venda no período.');
      } else {
        const data = await api.get(`/ranking/stores?${params}`);
        summary.innerHTML = `
          <div class="card stat-card"><span class="stat-label">Total vendido</span><span class="stat-value small">${esc(fmtMoney(data.items.reduce((a, r) => a + r.total_cents, 0)))}</span></div>
          <div class="card stat-card"><span class="stat-label">Vendas no período</span><span class="stat-value">${esc(String(data.items.reduce((a, r) => a + r.sales_count, 0)))}</span></div>`;
        table.innerHTML = dataTable([
          { label: '', render: (r) => rankPos(r.position) },
          { label: 'Loja', render: (r) => `<div class="td-main">${esc(r.name)}</div>` },
          { label: 'Vendas', render: (r) => `<strong>${esc(fmtMoney(r.total_cents))}</strong>` },
          { label: 'Quantidade', render: (r) => esc(String(r.sales_count)) },
          { label: 'Meta', render: (r) => r.target_cents === null ? '<span class="td-sub">—</span>' : esc(fmtMoney(r.target_cents)) },
          { label: '% Meta', render: (r) => progressBar(r.percent) },
        ], data.items, 'Nenhuma venda no período.');
      }
    } catch (err) {
      table.innerHTML = `<div class="alert alert-error" style="margin:14px">${esc(err.message)}</div>`;
    }
  }

  view.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    view.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    state.tab = t.dataset.tab;
    refresh();
  }));
  view.querySelector('#f-preset').addEventListener('change', (e) => { state.preset = e.target.value; refresh(); });
  view.querySelector('#f-from').addEventListener('change', (e) => { state.from = e.target.value; state.preset = 'custom'; view.querySelector('#f-preset').value = 'custom'; refresh(); });
  view.querySelector('#f-to').addEventListener('change', (e) => { state.to = e.target.value; state.preset = 'custom'; view.querySelector('#f-preset').value = 'custom'; refresh(); });
  storeSel.addEventListener('change', (e) => { state.store_id = e.target.value; refresh(); });

  await refresh();
}
