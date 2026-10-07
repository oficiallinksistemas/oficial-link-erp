/**
 * Componentes de UI reutilizáveis — sem frameworks, só o necessário.
 * Tudo que é injetado no DOM passa por esc() contra XSS.
 */

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * Ícones SVG discretos e consistentes (nunca emojis como ícone principal).
 * Uso: icon('user') → string SVG pronta para innerHTML.
 */
const ICON_PATHS = {
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20c.8-3.6 3.6-5.4 7-5.4s6.2 1.8 7 5.4"/>',
  shield: '<path d="M12 3l7 2.8v5.4c0 4.6-3 7.6-7 9.8-4-2.2-7-5.2-7-9.8V5.8L12 3Z"/><path d="M9.3 12l2 2 3.6-3.8"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  building: '<path d="M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16M15 9h4a1 1 0 0 1 1 1v11M3 21h18M7.5 8h3M7.5 12h3M7.5 16h3"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.3 3.8 5.2 3.8 8.5s-1.3 6.2-3.8 8.5c-2.5-2.3-3.8-5.2-3.8-8.5S9.5 5.8 12 3.5Z"/>',
  key: '<circle cx="8" cy="14" r="4"/><path d="M11 11l8-8M15 7l2.5 2.5M18 4l2 2"/>',
  activity: '<path d="M4 12h4l2.5-6 4 12L16 12h4"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.5M4 12h.5M4 18h.5"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.6M12 18.6v2.6M21.2 12h-2.6M5.4 12H2.8M18.5 5.5l-1.9 1.9M7.4 16.6l-1.9 1.9M18.5 18.5l-1.9-1.9M7.4 7.4L5.5 5.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  store: '<path d="M4 9 5.5 4h13L20 9M4 9v11h16V9M4 9h16M9.5 20v-6h5v6"/>',
  chart: '<path d="M4 20V4M4 20h16M8 16v-5M12 16V7M16 16v-3"/>',
  ban: '<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>',
  sales: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 9.5l1.1 4.4a1.6 1.6 0 0 0 1.6 1.3h4.4M9.5 8.5h5M15 8.2l.8 4.3a1.5 1.5 0 0 1-1.5 1.8h-3.6"/>',
  coins: '<ellipse cx="9" cy="7" rx="6.5" ry="3.4"/><path d="M2.5 7v5c0 1.9 2.9 3.4 6.5 3.4s6.5-1.5 6.5-3.4V7"/><path d="M2.5 12v5c0 1.9 2.9 3.4 6.5 3.4s6.5-1.5 6.5-3.4v-5"/><path d="M18.5 9.5c2 .4 3.4 1.5 3.4 2.9s-1.6 2.6-3.8 2.9"/>',
};

// ---------------------------------------------------------------------------
// Moeda — componentes reutilizáveis (valores trafegam em CENTAVOS)
// ---------------------------------------------------------------------------

/** 123456 → 'R$ 1.234,56' */
export function fmtMoney(cents) {
  const n = Number(cents || 0) / 100;
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/** '1.234,56' | '1234.56' | 1234.56 → 123456 (centavos). Inválido → NaN. */
export function moneyToCents(value) {
  if (typeof value === 'number') return Math.round(value * 100);
  const s = String(value || '').trim();
  if (!s) return NaN;
  const normalized = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  const n = Number(normalized);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

/** Máscara leve para campo de moeda: mantém dígitos e formata pt-BR. */
export function maskMoneyInput(input) {
  input.addEventListener('input', () => {
    const digits = input.value.replace(/\D/g, '');
    if (!digits) { input.value = ''; return; }
    input.value = (Number(digits) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  });
}

export function icon(name, size = 17) {
  const d = ICON_PATHS[name] || ICON_PATHS.list;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}

export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('pt-BR');
}

export function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
}

const STATUS_LABELS = {
  active: 'Ativo', inactive: 'Inativo', suspended: 'Suspenso',
};

export function badge(status) {
  const label = STATUS_LABELS[status] || esc(status);
  return `<span class="badge badge-${esc(status)}">${label}</span>`;
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
function toastContainer() {
  let c = document.querySelector('.toast-container');
  if (!c) {
    c = document.createElement('div');
    c.className = 'toast-container';
    document.body.appendChild(c);
  }
  return c;
}

export function toast(message, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', 'status');
  el.innerHTML = `<span class="toast-dot"></span><span>${esc(message)}</span>`;
  toastContainer().appendChild(el);
  setTimeout(() => el.classList.add('toast-out'), 3200);
  setTimeout(() => el.remove(), 3700);
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------
/**
 * Abre um modal com formulário.
 * onSubmit(data, close) — se retornar sem lançar erro, o modal fecha.
 */
export function openModal({ title, bodyHtml, submitLabel = 'Salvar', wide = false, onSubmit, readonly = false }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head">
        <h3>${esc(title)}</h3>
        <button type="button" class="icon-btn" data-close aria-label="Fechar">✕</button>
      </div>
      <form class="modal-body" novalidate>
        ${bodyHtml}
        ${readonly ? '' : `
        <div class="modal-foot">
          <button type="button" class="btn btn-ghost" data-close>Fechar</button>
          <button type="submit" class="btn btn-primary">${esc(submitLabel)}</button>
        </div>`}
      </form>
    </div>`;
  document.body.appendChild(overlay);
  document.body.classList.add('no-scroll');

  const close = () => {
    overlay.remove();
    if (!document.querySelector('.modal-overlay')) document.body.classList.remove('no-scroll');
  };

  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  overlay.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  document.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape' && document.body.contains(overlay)) close();
    else document.removeEventListener('keydown', onEsc);
  });

  if (onSubmit) {
    const form = overlay.querySelector('form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type="submit"]');
      const data = Object.fromEntries(new FormData(form).entries());
      btn.disabled = true;
      btn.textContent = 'Salvando…';
      try {
        await onSubmit(data, close);
        close();
      } catch (err) {
        toast(err.message || 'Não foi possível salvar.', 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = submitLabel;
      }
    });
  }
  const first = overlay.querySelector('input, select');
  if (first) first.focus();
  return close;
}

/** Confirmação simples — retorna Promise<boolean>. */
export function confirmDialog(message, { danger = false, confirmLabel = 'Confirmar' } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal modal-sm" role="alertdialog" aria-modal="true">
        <div class="modal-head"><h3>Confirmar ação</h3></div>
        <div class="modal-body"><p class="confirm-text">${esc(message)}</p>
          <div class="modal-foot">
            <button type="button" class="btn btn-ghost" data-no>Cancelar</button>
            <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-yes>${esc(confirmLabel)}</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const done = (value) => { overlay.remove(); resolve(value); };
    overlay.querySelector('[data-no]').addEventListener('click', () => done(false));
    overlay.querySelector('[data-yes]').addEventListener('click', () => done(true));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done(false); });
  });
}

// ---------------------------------------------------------------------------
// Tabela + paginação
// ---------------------------------------------------------------------------
export function dataTable(columns, rows, emptyText = 'Nenhum registro encontrado.') {
  if (!rows.length) {
    return `<div class="empty-state"><p>${esc(emptyText)}</p></div>`;
  }
  const head = columns.map((c) => `<th class="${c.class || ''}">${esc(c.label)}</th>`).join('');
  const body = rows
    .map((r) => `<tr>${columns.map((c) => `<td class="${c.class || ''}">${c.render(r)}</td>`).join('')}</tr>`)
    .join('');
  return `<div class="table-wrap"><table class="table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function pagination({ page, perPage, total, onPage }) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  if (pages <= 1) return '';
  const btn = (p, label, opts = {}) =>
    `<button class="page-btn ${opts.active ? 'active' : ''}" data-page="${p}" ${opts.disabled ? 'disabled' : ''}>${label}</button>`;
  let html = `<div class="pagination">
    ${btn(page - 1, '‹ Anterior', { disabled: page <= 1 })}
    <span class="page-info">Página ${page} de ${pages} · ${total} registros</span>
    ${btn(page + 1, 'Próxima ›', { disabled: page >= pages })}
  </div>`;
  setTimeout(() => {
    document.querySelectorAll('.page-btn[data-page]').forEach((b) => {
      b.addEventListener('click', () => onPage(Number(b.dataset.page)));
    });
  });
  return html;
}

export function debounce(fn, ms = 350) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** Seletor simples de opções a partir de um array. */
export function optionsHtml(items, selected, { value = 'id', label = 'name' } = {}) {
  return items
    .map((it) => `<option value="${esc(it[value])}" ${String(it[value]) === String(selected) ? 'selected' : ''}>${esc(it[label])}</option>`)
    .join('');
}
