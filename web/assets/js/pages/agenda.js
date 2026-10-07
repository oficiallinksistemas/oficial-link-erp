/**
 * Agenda — compromissos operacionais V1 (v3.4).
 * Sem biblioteca pesada: grade mensal em CSS grid + visões semana/dia em
 * listas. Horários são locais da empresa (backend trata as fronteiras de
 * dia com o fuso do tenant).
 */

import { api } from '../api.js';
import { session } from '../app.js';
import {
  esc, icon, toast, openModal, dataTable,
} from '../ui.js';

const state = {
  mode: 'month',               // month | week | day
  cursor: new Date(),          // dia corrente das visões
  events: [],
};

const can = (p) => session.hasPerm(p);

function dstr(dt) {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
function monthKey(dt) { return dstr(dt).slice(0, 7); }
function fmtDay(dt) { return dt.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' }); }
function hm(ev) { return ev.all_day ? 'Dia todo' : `${ev.start_at.slice(11, 16)}${ev.end_at ? '–' + ev.end_at.slice(11, 16) : ''}`; }

export async function render(view) {
  view.innerHTML = `
    <div class="page-head">
      <div><h2>Agenda</h2><p>Compromissos, reuniões, visitas e retornos.</p></div>
      <div class="spacer"></div>
      ${can('agenda.create') ? `<button class="btn btn-primary" id="btn-new">${icon('clock')} Novo compromisso</button>` : ''}
    </div>
    <div class="toolbar" style="margin-bottom:14px">
      <button class="btn" data-mode="month">Mês</button>
      <button class="btn" data-mode="week">Semana</button>
      <button class="btn" data-mode="day">Dia</button>
      <span class="spacer"></span>
      <button class="btn" id="btn-prev">${icon('ban')} ←</button>
      <strong id="agenda-title" style="min-width:150px;text-align:center"></strong>
      <button class="btn" id="btn-next">→</button>
      <button class="btn" id="btn-today">Hoje</button>
    </div>
    <div id="agenda-body"><div class="card"><div class="loading-line">Carregando…</div></div></div>
  `;

  view.querySelector('#btn-new')?.addEventListener('click', () => openEventModal(null, dstr(state.cursor), refresh));
  view.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { state.mode = b.dataset.mode; paintMode(); refresh(); }));
  view.querySelector('#btn-prev').addEventListener('click', () => { shift(-1); refresh(); });
  view.querySelector('#btn-next').addEventListener('click', () => { shift(1); refresh(); });
  view.querySelector('#btn-today').addEventListener('click', () => { state.cursor = new Date(); refresh(); });

  paintMode();
  await refresh();

  function paintMode() {
    view.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('btn-primary', b.dataset.mode === state.mode));
  }
  function shift(dir) {
    const c = state.cursor;
    if (state.mode === 'month') state.cursor = new Date(c.getFullYear(), c.getMonth() + dir, 1);
    else if (state.mode === 'week') state.cursor = new Date(c.getFullYear(), c.getMonth(), c.getDate() + 7 * dir);
    else state.cursor = new Date(c.getFullYear(), c.getMonth(), c.getDate() + dir);
  }

  async function refresh() {
    const body = view.querySelector('#agenda-body');
    body.innerHTML = '<div class="card"><div class="loading-line">Carregando…</div></div>';
    let from; let to; let title;
    const c = state.cursor;
    if (state.mode === 'month') {
      from = new Date(c.getFullYear(), c.getMonth(), 1);
      to = new Date(c.getFullYear(), c.getMonth() + 1, 0);
      title = c.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    } else if (state.mode === 'week') {
      const dow = (c.getDay() + 6) % 7; // seg=0
      from = new Date(c.getFullYear(), c.getMonth(), c.getDate() - dow);
      to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 6);
      title = `${from.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })} – ${to.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })}`;
    } else {
      from = new Date(c.getFullYear(), c.getMonth(), c.getDate());
      to = from;
      title = c.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
    }
    view.querySelector('#agenda-title').textContent = title;
    let data;
    try { data = await api.get(`/agenda?from=${dstr(from)}&to=${dstr(to)}`); }
    catch (err) { body.innerHTML = `<div class="card"><div class="empty-state">${icon('ban')}<p>${esc(err.message)}</p></div></div>`; return; }
    state.events = data.items;
    if (state.mode === 'month') renderMonth(body, from, to);
    else if (state.mode === 'week') renderWeek(body, from, to);
    else renderDay(body, from);
  }
}

function eventChip(ev) {
  return `<span class="agenda-ev ${ev.status === 'completed' ? 'done' : ''}" data-ev="${ev.id}" title="${esc(ev.title)}">${esc(ev.title)}</span>`;
}

function renderMonth(body, from, to) {
  const startDow = (from.getDay() + 6) % 7;
  const gridStart = new Date(from.getFullYear(), from.getMonth(), from.getDate() - startDow);
  const todayStr = dstr(new Date());
  const byDay = {};
  for (const ev of state.events) {
    const d = ev.start_at.slice(0, 10);
    (byDay[d] = byDay[d] || []).push(ev);
  }
  const dows = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
  let cells = dows.map((d) => `<div class="agenda-dow">${d}</div>`).join('');
  for (let i = 0; i < 42; i++) {
    const dt = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    const ds = dstr(dt);
    const inMonth = dt.getMonth() === from.getMonth();
    const evs = (byDay[ds] || []).sort((a, b) => a.start_at.localeCompare(b.start_at));
    const chips = evs.slice(0, 3).map(eventChip).join('') +
      (evs.length > 3 ? `<span class="agenda-ev more">+${evs.length - 3}</span>` : '');
    cells += `<div class="agenda-day ${inMonth ? '' : 'out'} ${ds === todayStr ? 'today' : ''}" data-day="${ds}">
      <span class="num">${dt.getDate()}</span>${chips}</div>`;
  }
  body.innerHTML = `<div class="card"><div class="agenda-month">${cells}</div></div>
    <div class="card" style="margin-top:14px" id="agenda-detail">
      <div class="empty-state">${icon('clock')} Toque em um dia para ver os compromissos.</div></div>`;
  body.querySelectorAll('.agenda-day').forEach((el) => {
    el.addEventListener('click', () => {
      body.querySelectorAll('.agenda-day').forEach((x) => x.style.outline = '');
      el.style.outline = '2px solid var(--cyan-500)';
      renderDetail(body, el.dataset.day);
    });
  });
  body.querySelectorAll('[data-ev]').forEach((el) => el.addEventListener('click', (e) => {
    e.stopPropagation(); openEventModal(Number(el.dataset.ev), null, () => renderMonth(body, from, to));
  }));
}

function renderDetail(body, day) {
  const evs = state.events.filter((e) => e.start_at.slice(0, 10) === day).sort((a, b) => a.start_at.localeCompare(b.start_at));
  const box = body.querySelector('#agenda-detail');
  if (!evs.length) {
    box.innerHTML = `<div class="empty-state">${icon('check')} Sem compromissos em ${esc(day.split('-').reverse().join('/'))}.</div>`;
    return;
  }
  box.innerHTML = `<h3 style="margin:0 0 10px">${esc(day.split('-').reverse().join('/'))}</h3>` +
    dataTable([
      { label: 'Horário', render: (e) => hm(e) },
      { label: 'Compromisso', render: (e) => `<strong>${esc(e.title)}</strong>${e.location ? `<br><span class="muted">${esc(e.location)}</span>` : ''}` },
      { label: 'Responsável', render: (e) => esc(e.responsible_name || '—') },
      { label: '', class: 'actions', render: (e) => evActions(e) },
    ], evs, '');
  box.querySelectorAll('[data-ev-complete]').forEach((b) => b.addEventListener('click', async () => {
    try { await api.post(`/agenda/${b.dataset.evComplete}/complete`); toast('Compromisso realizado.'); refreshEvents(body); }
    catch (err) { toast(err.message, 'error'); }
  }));
  box.querySelectorAll('[data-ev-cancel]').forEach((b) => b.addEventListener('click', async () => {
    try { await api.post(`/agenda/${b.dataset.evCancel}/cancel`); toast('Compromisso cancelado.'); refreshEvents(body); }
    catch (err) { toast(err.message, 'error'); }
  }));
  box.querySelectorAll('[data-ev-edit]').forEach((b) => b.addEventListener('click', () => openEventModal(Number(b.dataset.evEdit), null, () => refreshEvents(body))));

  function refreshEvents() {
    // re-render via roteador (simples e barato: uma única query)
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }
}

function evActions(e) {
  const out = [];
  if (e.status === 'scheduled') {
    if (can('agenda.edit')) out.push(`<button class="btn btn-sm" data-ev-edit="${e.id}">Editar</button>`);
    if (can('agenda.edit')) out.push(`<button class="btn btn-sm btn-primary" data-ev-complete="${e.id}">Realizado</button>`);
    if (can('agenda.delete')) out.push(`<button class="btn btn-sm btn-danger" data-ev-cancel="${e.id}">Cancelar</button>`);
  }
  return out.join(' ');
}

function renderWeek(body, from, to) {
  let cols = '';
  for (let i = 0; i < 7; i++) {
    const dt = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
    const ds = dstr(dt);
    const evs = state.events.filter((e) => e.start_at.slice(0, 10) === ds).sort((a, b) => a.start_at.localeCompare(b.start_at));
    cols += `<div class="day-col"><h4>${esc(fmtDay(dt))}</h4>
      ${evs.map((e) => `<div class="agenda-ev ${e.status === 'completed' ? 'done' : ''}" style="display:block;margin-bottom:4px;white-space:normal;cursor:pointer" data-ev="${e.id}">${hm(e)} · ${esc(e.title)}</div>`).join('') || '<span class="muted">—</span>'}
    </div>`;
  }
  body.innerHTML = `<div class="card"><div class="agenda-week">${cols}</div></div>`;
  body.querySelectorAll('[data-ev]').forEach((el) => el.addEventListener('click', () => openEventModal(Number(el.dataset.ev), null, () => window.dispatchEvent(new HashChangeEvent('hashchange')))));
}

function renderDay(body, day) {
  const ds = dstr(day);
  const evs = state.events.filter((e) => e.start_at.slice(0, 10) === ds).sort((a, b) => a.start_at.localeCompare(b.start_at));
  body.innerHTML = `<div class="card" id="agenda-detail">
    ${evs.length ? dataTable([
      { label: 'Horário', render: (e) => hm(e) },
      { label: 'Compromisso', render: (e) => `<strong>${esc(e.title)}</strong>${e.location ? `<br><span class="muted">${esc(e.location)}</span>` : ''}` },
      { label: 'Responsável', render: (e) => esc(e.responsible_name || '—') },
      { label: '', class: 'actions', render: (e) => evActions(e) },
    ], evs, '') : `<div class="empty-state">${icon('check')} Sem compromissos neste dia.</div>`}
  </div>`;
  body.querySelectorAll('[data-ev-complete]').forEach((b) => b.addEventListener('click', async () => {
    try { await api.post(`/agenda/${b.dataset.evComplete}/complete`); toast('Compromisso realizado.'); window.dispatchEvent(new HashChangeEvent('hashchange')); }
    catch (err) { toast(err.message, 'error'); }
  }));
  body.querySelectorAll('[data-ev-cancel]').forEach((b) => b.addEventListener('click', async () => {
    try { await api.post(`/agenda/${b.dataset.evCancel}/cancel`); toast('Compromisso cancelado.'); window.dispatchEvent(new HashChangeEvent('hashchange')); }
    catch (err) { toast(err.message, 'error'); }
  }));
  body.querySelectorAll('[data-ev-edit]').forEach((b) => b.addEventListener('click', () => openEventModal(Number(b.dataset.evEdit), null, () => window.dispatchEvent(new HashChangeEvent('hashchange')))));
}

async function openEventModal(id, presetDay, done) {
  let ev = null; let userOpts = '';
  try {
    const users = await api.get('/users?per_page=100');
    if (id) ev = await api.get(`/agenda/${id}`);
    userOpts = users.items.map((u) => `<option value="${u.id}" ${ev?.responsible_user_id === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
  } catch (err) { toast(err.message, 'error'); return; }

  const startVal = ev ? ev.start_at.replace(' ', 'T').slice(0, 16) : (presetDay ? `${presetDay}T09:00` : '');
  const endVal = ev?.end_at ? ev.end_at.replace(' ', 'T').slice(0, 16) : '';
  openModal({
    title: ev ? 'Editar compromisso' : 'Novo compromisso',
    submitLabel: ev ? 'Salvar' : 'Criar compromisso',
    wide: true,
    bodyHtml: `
      <div class="form-grid">
        <div class="field full"><label>Título *</label>
          <input class="input" name="title" required minlength="3" maxlength="120" value="${esc(ev?.title || '')}"></div>
        <div class="field"><label>Início *</label>
          <input class="input" type="datetime-local" name="start_at" required value="${esc(startVal)}"></div>
        <div class="field"><label>Fim</label>
          <input class="input" type="datetime-local" name="end_at" value="${esc(endVal)}"></div>
        <div class="field"><label>Dia inteiro</label>
          <select class="input" name="all_day"><option value="0" ${!ev?.all_day ? 'selected' : ''}>Não</option><option value="1" ${ev?.all_day ? 'selected' : ''}>Sim</option></select></div>
        <div class="field"><label>Responsável</label>
          <select class="input" name="responsible_user_id"><option value="">—</option>${userOpts}</select></div>
        <div class="field full"><label>Local</label>
          <input class="input" name="location" maxlength="120" value="${esc(ev?.location || '')}"></div>
        <div class="field full"><label>Descrição</label>
          <textarea class="input" name="description" rows="2" maxlength="1000">${esc(ev?.description || '')}</textarea></div>
      </div>
      <p class="muted" style="margin:4px 0 0">Horários no fuso da empresa. Fim deve ser depois do início (salvo dia inteiro).</p>
    `,
    onSubmit: async (d, close) => {
      const toLocal = (v) => (v ? v.replace('T', ' ').slice(0, 16) : null);
      const body = {
        title: d.title, start_at: toLocal(d.start_at), end_at: toLocal(d.end_at),
        all_day: d.all_day === '1', responsible_user_id: d.responsible_user_id || null,
        location: d.location || null, description: d.description || null,
      };
      try {
        if (ev) await api.patch(`/agenda/${ev.id}`, body);
        else await api.post('/agenda', body);
        toast(ev ? 'Compromisso atualizado.' : 'Compromisso criado.');
        close(); done?.();
      } catch (err) { toast(err.message, 'error'); }
    },
  });
}
