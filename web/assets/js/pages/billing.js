/**
 * Financeiro SaaS — camada comercial da plataforma (Master).
 *
 * Contexto DIFERENTE do financeiro do tenant (Contas a Pagar/Receber): aqui
 * é a cobrança que a Oficial Link faz de cada empresa (implantação,
 * mensalidade, avulsas), com registro manual de pagamentos e comprovantes.
 * Todas as ações sensíveis exigem platform.billing.manage no backend —
 * o frontend apenas esconde os botões.
 */

import { api } from '../api.js';
import { session } from '../app.js';
import {
  esc, icon, toast, openModal, confirmDialog, dataTable,
  pagination, maskMoneyInput, fmtMoney, fmtDate, fmtDateTime, moneyToCents,
} from '../ui.js';

const TYPE_LABEL = { implementation: 'Implantação', monthly: 'Mensalidade', custom: 'Avulsa' };
const METHOD_LABEL = {
  pix: 'Pix', transferencia: 'Transferência', boleto: 'Boleto',
  dinheiro: 'Dinheiro', cartao: 'Cartão', outro: 'Outro',
};
const SITUATION_LABEL = { overdue: 'Em atraso', due_soon: 'Vencendo em breve', none: 'Sem configuração' };

function statusBadge(status) {
  const map = { OPEN: 'active', OVERDUE: 'suspended', PAID: 'active', CANCELED: 'inactive' };
  const label = { OPEN: 'Em aberto', OVERDUE: 'Vencida', PAID: 'Paga', CANCELED: 'Cancelada' }[status] || status;
  return `<span class="badge badge-${map[status] || 'inactive'}">${esc(label)}</span>`;
}

function typeBadge(type) {
  const cls = { implementation: 'suspended', monthly: 'active', custom: 'inactive' }[type] || 'inactive';
  return `<span class="badge badge-${cls}">${esc(TYPE_LABEL[type] || type)}</span>`;
}

function daysLate(dueDate, todayStr) {
  const a = new Date(`${dueDate}T00:00:00Z`);
  const b = new Date(`${todayStr}T00:00:00Z`);
  return Math.floor((b - a) / 86400000);
}

const state = {
  section: 'panel',
  charges: { page: 1, status: '', type: '', search: '' },
  companies: { page: 1, search: '', situation: '' },
  overview: null,
  today: null,
};

const canManage = () => session.hasPerm('platform.billing.manage');

export async function render(view) {
  view.innerHTML = `
    <div class="page-head">
      <div><h2>Financeiro SaaS</h2><p>Cobranças da plataforma — implantação, mensalidades e inadimplência.</p></div>
    </div>
    <div class="toolbar" id="billing-tabs" style="margin-bottom:16px">
      <button class="btn" data-tab="panel">Painel</button>
      <button class="btn" data-tab="charges">Cobranças</button>
      <button class="btn" data-tab="companies">Empresas</button>
    </div>
    <div id="billing-body"><div class="card"><div class="loading-line">Carregando…</div></div></div>
  `;

  view.querySelector('#billing-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]')?.dataset.tab;
    if (!tab || tab === state.section) return;
    state.section = tab;
    paintTabs();
    loadSection(view);
  });
  paintTabs();

  try {
    const [ov, charges] = await Promise.all([
      api.get('/platform/billing/overview'),
      api.get('/platform/billing/charges?per_page=1'),
    ]);
    state.overview = ov;
    state.today = new Date().toISOString().slice(0, 10); // exibição de dias de atraso
    await loadSection(view);
  } catch (err) {
    view.querySelector('#billing-body').innerHTML = `
      <div class="card"><div class="empty-state">${icon('ban')}
        <p><strong>Não foi possível carregar o Financeiro SaaS.</strong></p>
        <p>${esc(err.message || 'Erro inesperado.')}</p>
      </div></div>`;
  }
}

function paintTabs() {
  document.querySelectorAll('#billing-tabs [data-tab]').forEach((b) => {
    b.classList.toggle('btn-primary', b.dataset.tab === state.section);
  });
}

async function loadSection(view) {
  const body = view.querySelector('#billing-body');
  body.innerHTML = `<div class="card"><div class="loading-line">Carregando…</div></div>`;
  try {
    if (state.section === 'panel') await renderPanel(body);
    if (state.section === 'charges') await renderCharges(body, view);
    if (state.section === 'companies') await renderCompanies(body, view);
  } catch (err) {
    body.innerHTML = `<div class="card"><div class="empty-state">${icon('ban')}
      <p><strong>Erro ao carregar.</strong></p><p>${esc(err.message || 'Erro inesperado.')}</p></div></div>`;
  }
}

// ---------------------------------------------------------------------------
// Painel — KPIs + Atenção + pagamentos recentes
// ---------------------------------------------------------------------------
async function renderPanel(body) {
  const o = state.overview;
  const kpi = (label, cents, hint) => `
    <div class="card stat-card">
      <span class="stat-label">${esc(label)}</span>
      <span class="stat-value small">${esc(fmtMoney(cents))}</span>
      ${hint ? `<span class="stat-hint">${esc(hint)}</span>` : ''}
    </div>`;
  const kpiCount = (label, value, hint) => `
    <div class="card stat-card">
      <span class="stat-label">${esc(label)}</span>
      <span class="stat-value small">${esc(String(value))}</span>
      ${hint ? `<span class="stat-hint">${esc(hint)}</span>` : ''}
    </div>`;

  const attentionRow = (c) => {
    const late = daysLate(c.due_date, state.today);
    const lateTxt = c.status === 'OVERDUE'
      ? `<span class="badge badge-suspended">${late} dia${late === 1 ? '' : 's'} em atraso</span>`
      : `<span class="badge badge-active">${late === 0 ? 'vence hoje' : `vence em ${late} dia${late === 1 ? '' : 's'}`}</span>`;
    return `<tr>
      <td><strong>${esc(c.company_name)}</strong></td>
      <td>${typeBadge(c.type)}</td>
      <td>${esc(c.reference || '—')}</td>
      <td>${fmtDate(c.due_date)}</td>
      <td>${lateTxt}</td>
    </tr>`;
  };

  body.innerHTML = `
    <div class="cards-grid" id="billing-kpis" style="margin-bottom:16px"></div>
    <div class="grid-2" id="billing-attention" style="margin-bottom:16px"></div>
    <div class="card" id="billing-recent"></div>
  `;

  body.querySelector('#billing-kpis').innerHTML = [
    kpi('MRR previsto', o.mrr_expected_cents, `${o.mrr_companies} assinatura(s) ativa(s)`),
    kpi('Recebido no mês', o.received_month_cents, `${o.received_month_count} pagamento(s)`),
    kpi('Em aberto', o.open_cents, `${o.open_count} cobrança(s)`),
    kpi('Em atraso', o.overdue_cents, `${o.overdue_count} cobrança(s)`),
    kpiCount('Empresas ativas', o.companies.active, `${o.companies.total} cadastrada(s)`),
    kpi('Implantações pendentes', o.implementation_pending_cents, `${o.implementation_pending_count} cobrança(s)`),
  ].join('');

  const attentionCard = (title, rows, emptyMsg) => `
    <div class="card">
      <h3 style="margin:0 0 10px">${esc(title)}</h3>
      ${rows.length ? `<div class="table-wrap"><table class="table">
        <thead><tr><th>Empresa</th><th>Tipo</th><th>Ref.</th><th>Vencimento</th><th></th></tr></thead>
        <tbody>${rows.map(attentionRow).join('')}</tbody>
      </table></div>` : `<div class="empty-state">${icon('check')} ${esc(emptyMsg)}</div>`}
    </div>`;
  body.querySelector('#billing-attention').innerHTML =
    attentionCard('Em atraso', o.attention_overdue, 'Nenhuma cobrança vencida.') +
    attentionCard('Vencendo em breve (7 dias)', o.attention_due_soon, 'Nada vencendo nos próximos 7 dias.');

  body.querySelector('#billing-recent').innerHTML = `
    <h3 style="margin:0 0 10px">Pagamentos recentes</h3>
    ${o.recent_payments.length ? `<div class="table-wrap"><table class="table">
      <thead><tr><th>Empresa</th><th>Valor</th><th>Data</th><th>Método</th><th>Comprovante</th></tr></thead>
      <tbody>${o.recent_payments.map((p) => `<tr>
        <td><strong>${esc(p.company_name)}</strong></td>
        <td>${fmtMoney(p.amount_cents)}</td>
        <td>${fmtDate(p.paid_on)}</td>
        <td>${esc(METHOD_LABEL[p.method] || p.method)}</td>
        <td>${p.receipt_id ? `<a class="btn btn-sm" href="/api/platform/billing/payments/${p.id}/receipt" target="_blank" rel="noopener">Ver</a>` : '—'}</td>
      </tr>`).join('')}</tbody>
    </table></div>` : `<div class="empty-state">${icon('list')} Nenhum pagamento registrado ainda.</div>`}
  `;
}

// ---------------------------------------------------------------------------
// Cobranças — filtros, nova cobrança, pagar (com comprovante), editar, cancelar
// ---------------------------------------------------------------------------
async function renderCharges(body, view) {
  body.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <input class="input" id="f-search" placeholder="Buscar empresa ou referência" value="${esc(state.charges.search)}">
        <select class="input" id="f-status">
          <option value="">Todos os status</option>
          <option value="OVERDUE" ${state.charges.status === 'OVERDUE' ? 'selected' : ''}>Vencidas</option>
          <option value="OPEN" ${state.charges.status === 'OPEN' ? 'selected' : ''}>Em aberto</option>
          <option value="PAID" ${state.charges.status === 'PAID' ? 'selected' : ''}>Pagas</option>
          <option value="CANCELED" ${state.charges.status === 'CANCELED' ? 'selected' : ''}>Canceladas</option>
        </select>
        <select class="input" id="f-type">
          <option value="">Todos os tipos</option>
          <option value="implementation" ${state.charges.type === 'implementation' ? 'selected' : ''}>Implantação</option>
          <option value="monthly" ${state.charges.type === 'monthly' ? 'selected' : ''}>Mensalidade</option>
          <option value="custom" ${state.charges.type === 'custom' ? 'selected' : ''}>Avulsa</option>
        </select>
        <span class="spacer"></span>
        ${canManage() ? `<button class="btn btn-primary" id="btn-new">${icon('coins')} Nova cobrança</button>` : ''}
      </div>
      <div id="charges-table"><div class="loading-line">Carregando…</div></div>
    </div>
  `;

  body.querySelector('#f-search').addEventListener('change', (e) => {
    state.charges.search = e.target.value.trim();
    state.charges.page = 1;
    refreshCharges();
  });
  body.querySelector('#f-status').addEventListener('change', (e) => {
    state.charges.status = e.target.value;
    state.charges.page = 1;
    refreshCharges();
  });
  body.querySelector('#f-type').addEventListener('change', (e) => {
    state.charges.type = e.target.value;
    state.charges.page = 1;
    refreshCharges();
  });
  body.querySelector('#btn-new')?.addEventListener('click', () => openChargeModal(refreshCharges));

  async function refreshCharges() {
    const box = body.querySelector('#charges-table');
    box.innerHTML = '<div class="loading-line">Carregando…</div>';
    const q = new URLSearchParams({ page: state.charges.page, per_page: 10 });
    if (state.charges.status) q.set('status', state.charges.status);
    if (state.charges.type) q.set('type', state.charges.type);
    if (state.charges.search) q.set('search', state.charges.search);
    let data;
    try {
      data = await api.get(`/platform/billing/charges?${q}`);
    } catch (err) {
      box.innerHTML = `<div class="empty-state">${icon('ban')}<p>${esc(err.message)}</p></div>`;
      return;
    }

    box.innerHTML = dataTable([
      { label: 'Empresa', render: (c) => `<strong>${esc(c.company_name)}</strong>` },
      { label: 'Tipo', render: (c) => typeBadge(c.type) },
      { label: 'Ref.', render: (c) => esc(c.reference || '—') },
      { label: 'Valor', render: (c) => fmtMoney(c.amount_cents) },
      { label: 'Vencimento', render: (c) => fmtDate(c.due_date) },
      { label: 'Status', render: (c) => statusBadge(c.status) },
      { label: 'Pagamento', render: (c) => (c.status === 'PAID' ? `${fmtDate(c.paid_on)} · ${esc(METHOD_LABEL[c.payment_method] || '')}` : '—') },
      { label: '', class: 'actions', render: (c) => chargeActions(c) },
    ], data.items, 'Nenhuma cobrança encontrada.') + pagination({
      page: data.page || state.charges.page,
      perPage: 10,
      total: data.total,
      onPage: (p) => { state.charges.page = p; refreshCharges(); },
    });

    box.querySelectorAll('.page-btn').forEach((b) => {
      b.addEventListener('click', () => {
        const p = Number(b.dataset.page);
        if (Number.isFinite(p)) { state.charges.page = p; refreshCharges(); }
      });
    });

    box.querySelectorAll('[data-pay]').forEach((b) => b.addEventListener('click', () => openPayModal(Number(b.dataset.pay), refreshCharges)));
    box.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openEditModal(Number(b.dataset.edit), refreshCharges)));
    box.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', () => cancelChargeFlow(Number(b.dataset.cancel), refreshCharges)));
  }

  function chargeActions(c) {
    const open = ['OPEN', 'OVERDUE'].includes(c.status);
    const out = [];
    if (canManage() && open) {
      out.push(`<button class="btn btn-sm btn-primary" data-pay="${c.id}">Pagar</button>`);
      out.push(`<button class="btn btn-sm" data-edit="${c.id}">Editar</button>`);
      out.push(`<button class="btn btn-sm btn-danger" data-cancel="${c.id}">Cancelar</button>`);
    }
    return out.join(' ');
  }

  await refreshCharges();
}

// ---------------------------------------------------------------------------
// Modais de cobrança
// ---------------------------------------------------------------------------
async function loadCompanyOptions(selectedId) {
  const r = await api.get('/platform/companies?per_page=100');
  return r.items.map((c) => `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
}

async function openChargeModal(done) {
  let companiesHtml = '';
  try { companiesHtml = await loadCompanyOptions(); } catch (err) { toast(err.message, 'error'); return; }
  openModal({
    title: 'Nova cobrança',
    submitLabel: 'Criar cobrança',
    wide: true,
    bodyHtml: `
      <div class="form-grid">
        <div class="field full"><label>Empresa *</label>
          <select class="input" name="company_id" required>${companiesHtml}</select></div>
        <div class="field"><label>Tipo *</label>
          <select class="input" name="type" required>
            <option value="monthly">Mensalidade</option>
            <option value="implementation">Implantação</option>
            <option value="custom">Avulsa</option>
          </select></div>
        <div class="field"><label>Competência / referência</label>
          <input class="input" name="reference" maxlength="80" placeholder="ex.: 2026-10"></div>
        <div class="field"><label>Valor (R$) *</label>
          <input class="input" name="amount" id="f-amount" inputmode="decimal" required></div>
        <div class="field"><label>Vencimento *</label>
          <input class="input" type="date" name="due_date" required></div>
        <div class="field full"><label>Observação</label>
          <textarea class="input" name="notes" rows="2" maxlength="500"></textarea></div>
      </div>
    `,
    onSubmit: async (d, close) => {
      const cents = moneyToCents(d.amount);
      if (!Number.isFinite(cents) || cents <= 0) { toast('Informe um valor válido.', 'error'); return; }
      try {
        await api.post('/platform/billing/charges', {
          company_id: Number(d.company_id), type: d.type,
          reference: d.reference || undefined, amount: cents / 100,
          due_date: d.due_date, notes: d.notes || undefined,
        });
        toast('Cobrança criada.');
        reloadOverview();
        close();
        done?.();
      } catch (err) { toast(err.message, 'error'); }
    },
  });
  maskMoneyInput(document.getElementById('f-amount'));
}

async function openEditModal(id, done) {
  let c;
  try {
    c = await api.get(`/platform/billing/charges/${id}`);
  } catch (err) { toast(err.message, 'error'); return; }
  openModal({
    title: `Editar cobrança — ${c.company_name}`,
    submitLabel: 'Salvar alterações',
    wide: true,
    bodyHtml: `
      <div class="form-grid">
        <div class="field"><label>Valor (R$) *</label>
          <input class="input" name="amount" id="f-amount" inputmode="decimal" required
            value="${(c.amount_cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}"></div>
        <div class="field"><label>Vencimento *</label>
          <input class="input" type="date" name="due_date" required value="${esc(c.due_date)}"></div>
        <div class="field full"><label>Competência / referência</label>
          <input class="input" name="reference" maxlength="80" value="${esc(c.reference || '')}"></div>
        <div class="field full"><label>Observação</label>
          <textarea class="input" name="notes" rows="2" maxlength="500"></textarea></div>
      </div>
      <p class="muted" style="margin:4px 0 0">Somente cobranças em aberto podem ser editadas.</p>
    `,
    onSubmit: async (d, close) => {
      const cents = moneyToCents(d.amount);
      if (!Number.isFinite(cents) || cents <= 0) { toast('Informe um valor válido.', 'error'); return; }
      try {
        await api.put(`/platform/billing/charges/${id}`, {
          amount: cents / 100, due_date: d.due_date,
          reference: d.reference || undefined, notes: d.notes || undefined,
        });
        toast('Cobrança atualizada.');
        reloadOverview();
        close();
        done?.();
      } catch (err) { toast(err.message, 'error'); }
    },
  });
  maskMoneyInput(document.getElementById('f-amount'));
}

async function cancelChargeFlow(id, done) {
  const okCancel = await confirmDialog('Cancelar esta cobrança? Ela permanece no histórico, mas não poderá ser paga.', { danger: true, confirmLabel: 'Cancelar cobrança' });
  if (!okCancel) return;
  openModal({
    title: 'Motivo do cancelamento',
    submitLabel: 'Confirmar cancelamento',
    bodyHtml: `
      <div class="form-grid">
        <div class="field full"><label>Motivo (opcional)</label>
          <textarea class="input" name="notes" rows="2" maxlength="500"></textarea></div>
      </div>
    `,
    onSubmit: async (d, close) => {
      try {
        await api.post(`/platform/billing/charges/${id}/cancel`, { notes: d.notes || undefined });
        toast('Cobrança cancelada.');
        reloadOverview();
        close();
        done?.();
      } catch (err) { toast(err.message, 'error'); }
    },
  });
}

/** Pagamento: integral, transacional e idempotente no backend. Comprovante
 *  (PNG/JPEG/PDF, máx 5 MB) vai como data URL — validado por magic bytes
 *  no servidor. */
async function openPayModal(id, done) {
  let c;
  try {
    c = await api.get(`/platform/billing/charges/${id}`);
  } catch (err) { toast(err.message, 'error'); return; }

  openModal({
    title: `Registrar pagamento — ${c.company_name}`,
    submitLabel: 'Confirmar pagamento',
    wide: true,
    bodyHtml: `
      <div class="form-grid">
        <div class="field"><label>Valor pago (R$) *</label>
          <input class="input" name="amount" id="f-amount" inputmode="decimal" required
            value="${(c.amount_cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}"></div>
        <div class="field"><label>Data do pagamento *</label>
          <input class="input" type="date" name="paid_on" required value="${esc(state.today)}"></div>
        <div class="field full"><label>Método *</label>
          <select class="input" name="method" required>
            ${Object.entries(METHOD_LABEL).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
          </select></div>
        <div class="field full"><label>Comprovante (PNG, JPEG ou PDF — máx 5 MB)</label>
          <input class="input" type="file" name="receipt" id="f-receipt" accept="image/png,image/jpeg,application/pdf">
          <span class="muted" id="receipt-hint"></span></div>
        <div class="field full"><label>Observação</label>
          <textarea class="input" name="notes" rows="2" maxlength="500"></textarea></div>
      </div>
      <p class="muted" style="margin:4px 0 0">Na V1 o pagamento deve ser integral (mesmo valor da cobrança). Dupla confirmação é bloqueada pelo servidor.</p>
    `,
    onSubmit: async (d, close) => {
      const cents = moneyToCents(d.amount);
      if (!Number.isFinite(cents) || cents <= 0) { toast('Informe um valor válido.', 'error'); return; }
      let receipt;
      const file = document.getElementById('f-receipt').files[0];
      if (file) {
        if (file.size > 5 * 1024 * 1024) { toast('Comprovante excede 5 MB.', 'error'); return; }
        if (!['image/png', 'image/jpeg', 'application/pdf'].includes(file.type)) {
          toast('Comprovante deve ser PNG, JPEG ou PDF.', 'error'); return;
        }
        receipt = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = () => reject(new Error('Não foi possível ler o comprovante.'));
          r.readAsDataURL(file);
        });
      }
      try {
        await api.post(`/platform/billing/charges/${id}/pay`, {
          amount: cents / 100, paid_on: d.paid_on, method: d.method,
          notes: d.notes || undefined, receipt,
        });
        toast('Pagamento registrado.');
        reloadOverview();
        close();
        done?.();
      } catch (err) { toast(err.message, 'error'); }
    },
  });
  maskMoneyInput(document.getElementById('f-amount'));
}

// ---------------------------------------------------------------------------
// Empresas — visão comercial (config + histórico)
// ---------------------------------------------------------------------------
async function renderCompanies(body, view) {
  body.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <input class="input" id="c-search" placeholder="Buscar empresa" value="${esc(state.companies.search)}">
        <select class="input" id="c-situation">
          <option value="">Todas as situações</option>
          <option value="overdue" ${state.companies.situation === 'overdue' ? 'selected' : ''}>Em atraso</option>
          <option value="due_soon" ${state.companies.situation === 'due_soon' ? 'selected' : ''}>Vencendo em breve</option>
          <option value="none" ${state.companies.situation === 'none' ? 'selected' : ''}>Sem configuração</option>
        </select>
      </div>
      <div id="companies-table"><div class="loading-line">Carregando…</div></div>
    </div>
  `;

  body.querySelector('#c-search').addEventListener('change', (e) => {
    state.companies.search = e.target.value.trim();
    state.companies.page = 1;
    refreshCompanies();
  });
  body.querySelector('#c-situation').addEventListener('change', (e) => {
    state.companies.situation = e.target.value;
    state.companies.page = 1;
    refreshCompanies();
  });

  async function refreshCompanies() {
    const box = body.querySelector('#companies-table');
    box.innerHTML = '<div class="loading-line">Carregando…</div>';
    const q = new URLSearchParams({ page: state.companies.page, per_page: 10 });
    if (state.companies.search) q.set('search', state.companies.search);
    if (state.companies.situation) q.set('situation', state.companies.situation);
    let data;
    try {
      data = await api.get(`/platform/billing/companies?${q}`);
    } catch (err) {
      box.innerHTML = `<div class="empty-state">${icon('ban')}<p>${esc(err.message)}</p></div>`;
      return;
    }

    box.innerHTML = dataTable([
      { label: 'Empresa', render: (c) => `<strong>${esc(c.name)}</strong>` },
      { label: 'Plano', render: (c) => esc(c.plan || '—') },
      {
        label: 'Mensalidade', render: (c) => (c.monthly_fee_cents ? fmtMoney(c.monthly_fee_cents) : '—'),
      },
      { label: 'Vencimento', render: (c) => (c.billing_due_day ? `Dia ${c.billing_due_day}` : '—') },
      {
        label: 'Próxima cobrança',
        render: (c) => (c.next_charge_due ? fmtDate(c.next_charge_due) : (c.next_due_date ? fmtDate(c.next_due_date) : '—')),
      },
      {
        label: 'Situação',
        render: (c) => {
          if (c.overdue_count > 0) return `<span class="badge badge-suspended">Em atraso (${c.overdue_count})</span>`;
          if (!c.monthly_fee_cents && !c.billing_due_day) return `<span class="badge badge-inactive">Sem configuração</span>`;
          return `<span class="badge badge-active">Em dia</span>`;
        },
      },
      { label: 'Assinatura', render: (c) => esc(c.subscription_status || '—') },
      { label: '', class: 'actions', render: (c) => `<button class="btn btn-sm" data-detail="${c.id}">Detalhe</button>` },
    ], data.items, 'Nenhuma empresa encontrada.') + pagination({
      page: data.page || state.companies.page,
      perPage: 10,
      total: data.total,
      onPage: (p) => { state.companies.page = p; refreshCompanies(); },
    });

    box.querySelectorAll('.page-btn').forEach((b) => {
      b.addEventListener('click', () => {
        const p = Number(b.dataset.page);
        if (Number.isFinite(p)) { state.companies.page = p; refreshCompanies(); }
      });
    });
    box.querySelectorAll('[data-detail]').forEach((b) => {
      b.addEventListener('click', () => openCompanyModal(Number(b.dataset.detail), refreshCompanies));
    });
  }

  await refreshCompanies();
}

async function openCompanyModal(companyId, done) {
  let d;
  try {
    d = await api.get(`/platform/billing/companies/${companyId}`);
  } catch (err) { toast(err.message, 'error'); return; }
  const cfg = d.config || {};
  const manage = canManage();

  openModal({
    title: `Assinatura — ${d.name}`,
    submitLabel: 'Salvar configuração',
    readonly: !manage,
    wide: true,
    bodyHtml: `
      <div class="grid-2" style="margin-bottom:14px">
        <div class="card stat-card">
          <span class="stat-label">Plano</span>
          <span class="stat-value small">${esc(d.plan || '—')}</span>
          <span class="stat-hint">Assinatura: ${esc(d.subscription_status || '—')} · Empresa: ${esc(d.status || '—')}</span>
        </div>
        <div class="card stat-card">
          <span class="stat-label">Situação da cobrança</span>
          <span class="stat-value small">${d.charge_totals.overdue_count > 0 ? `Em atraso (${fmtMoney(d.charge_totals.overdue_cents)})` : 'Em dia'}</span>
          <span class="stat-hint">Aberto: ${fmtMoney(d.charge_totals.open_cents)} · Pago: ${fmtMoney(d.charge_totals.paid_cents)}</span>
        </div>
      </div>
      <h3 style="margin:0 0 10px">Configuração comercial</h3>
      ${manage ? `
      <div class="form-grid">
        <div class="field"><label>Taxa de implantação (R$)</label>
          <input class="input" name="implementation_fee" id="f-impl" inputmode="decimal"
            value="${cfg.implementation_fee_cents ? (cfg.implementation_fee_cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : ''}"></div>
        <div class="field"><label>Mensalidade (R$)</label>
          <input class="input" name="monthly_fee" id="f-monthly" inputmode="decimal"
            value="${cfg.monthly_fee_cents ? (cfg.monthly_fee_cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : ''}"></div>
        <div class="field"><label>Dia de vencimento (1–28)</label>
          <input class="input" type="number" name="billing_due_day" min="1" max="28"
            value="${cfg.billing_due_day ?? 10}"></div>
        <div class="field"><label>Método padrão</label>
          <select class="input" name="payment_method">
            ${Object.entries(METHOD_LABEL).map(([v, l]) => `<option value="${v}" ${cfg.payment_method === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select></div>
        <div class="field"><label>Próximo vencimento</label>
          <input class="input" type="date" name="next_due_date" value="${esc(cfg.next_due_date || '')}"></div>
        <div class="field full"><label>Observações comerciais</label>
          <textarea class="input" name="billing_notes" rows="2" maxlength="500">${esc(cfg.billing_notes || '')}</textarea></div>
      </div>
      ` : `<div class="empty-state">${icon('key')} Somente Master pode editar a configuração comercial.</div>`}
      <h3 style="margin:16px 0 10px">Histórico de cobranças</h3>
      <div id="company-charges">
        ${d.charges.length ? `<div class="table-wrap"><table class="table">
          <thead><tr><th>Tipo</th><th>Ref.</th><th>Valor</th><th>Vencimento</th><th>Status</th><th>Pagamento</th></tr></thead>
          <tbody>${d.charges.map((c) => `<tr>
            <td>${typeBadge(c.type)}</td>
            <td>${esc(c.reference || '—')}</td>
            <td>${fmtMoney(c.amount_cents)}</td>
            <td>${fmtDate(c.due_date)}</td>
            <td>${statusBadge(c.status)}</td>
            <td>${c.status === 'PAID' ? `${fmtDate(c.paid_on)} · ${esc(METHOD_LABEL[c.payment_method] || '')}` : '—'}</td>
          </tr>`).join('')}</tbody>
        </table></div>` : `<div class="empty-state">${icon('list')} Nenhuma cobrança para esta empresa.</div>`}
      </div>
    `,
    onSubmit: manage ? async (fd, close) => {
      const impl = moneyToCents(fd.implementation_fee || '0') || 0;
      const monthly = moneyToCents(fd.monthly_fee || '0') || 0;
      try {
        await api.put(`/platform/billing/companies/${companyId}/config`, {
          implementation_fee: impl / 100, monthly_fee: monthly / 100,
          billing_due_day: Number(fd.billing_due_day) || 10,
          payment_method: fd.payment_method,
          next_due_date: fd.next_due_date || undefined,
          billing_notes: fd.billing_notes || undefined,
        });
        toast('Configuração comercial salva.');
        reloadOverview();
        close();
        done?.();
      } catch (err) { toast(err.message, 'error'); }
    } : undefined,
  });
  maskMoneyInput(document.getElementById('f-impl'));
  maskMoneyInput(document.getElementById('f-monthly'));
}

/** Releitura leve do painel (KPIs/atrasos) após ações de cobrança/config. */
function reloadOverview() {
  api.get('/platform/billing/overview')
    .then((ov) => { state.overview = ov; })
    .catch(() => { /* painel recarrega na próxima visita */ });
}
