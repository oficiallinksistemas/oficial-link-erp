/**
 * Oficial Link ERP — núcleo do frontend.
 * Sessão, roteador (hash) e layout. Páginas são módulos ES carregados
 * sob demanda (import dinâmico) — o navegador só baixa o que for usar.
 *
 * A decisão "sou Master" é SEMPRE do backend: o menu usa as permissões
 * que vieram da sessão autenticada (session.me.permissions).
 */

import { api } from './api.js';
import { esc, toast, initials, icon } from './ui.js';

// ---------------------------------------------------------------------------
// Sessão
// ---------------------------------------------------------------------------
export const session = {
  me: null,
  modules: [],
  async load() {
    this.me = await api.get('/auth/me');
    // módulos ativos da empresa (menu dinâmico) — só para tenants
    this.modules = this.me.company
      ? await api.get('/modules').catch(() => [])
      : [];
    return this.me;
  },
  clear() { this.me = null; this.modules = []; resetBranding(); },
  hasPerm(code) {
    // globalAdmin: autoridade do Master refletida da sessão — a decisão final
    // é sempre do backend (requirePermission); aqui é só para exibir o menu.
    return !!this.me && (this.me.globalAdmin === true || this.me.permissions.includes(code));
  },
  /** Módulo ativo para a empresa (UX apenas — o backend revalida tudo). */
  moduleActive(slug) {
    if (!this.me || !this.me.company) return true; // Master: não se aplica
    return this.modules.some((m) => m.slug === slug && m.status === 'active');
  },
  get isMaster() { return !!this.me && this.me.company === null; },
};

window.addEventListener('session:expired', () => {
  session.clear();
  if (!location.hash.startsWith('#/login')) {
    toast('Sua sessão expirou. Faça login novamente.', 'error');
    location.hash = '#/login';
  }
});

// ---------------------------------------------------------------------------
// Rotas — adicionar novos módulos futuros aqui
// ---------------------------------------------------------------------------
const routes = [
  // Geral
  { path: '#/dashboard', title: 'Dashboard', perm: 'dashboard.view', load: () => import('./pages/dashboard.js') },
  // Comercial (módulos oficiais — exibidos só quando ativos para a empresa)
  { path: '#/vendas', title: 'Vendas', module: 'sales', perm: 'sales.view', tenantOnly: true, load: () => import('./pages/sales.js') },
  { path: '#/metas', title: 'Metas', module: 'targets', perm: 'targets.view', tenantOnly: true, load: () => import('./pages/targets.js') },
  { path: '#/ranking', title: 'Ranking', module: 'ranking', perm: 'ranking.view', tenantOnly: true, load: () => import('./pages/ranking.js') },
  { path: '#/clientes', title: 'Clientes', module: 'customers', perm: 'customers.view', tenantOnly: true, load: () => import('./pages/customers.js') },
  { path: '#/produtos', title: 'Produtos', module: 'products', perm: 'products.view', tenantOnly: true, load: () => import('./pages/products.js') },
  { path: '#/estoque', title: 'Estoque', module: 'stock', perm: 'stock.view', tenantOnly: true, load: () => import('./pages/stock.js') },
  { path: '#/compras', title: 'Compras', module: 'purchases', perm: 'purchases.view', tenantOnly: true, load: () => import('./pages/purchases.js') },
  { path: '#/transferencias', title: 'Transferências', module: 'stock', perm: 'stock.view', tenantOnly: true, load: () => import('./pages/transfers.js') },
  { path: '#/inventario', title: 'Inventário', module: 'stock', perm: 'stock.view', tenantOnly: true, load: () => import('./pages/inventory.js') },
  // Camada operacional V1 (v3.4)
  { path: '#/tarefas', title: 'Tarefas', module: 'tasks', perm: 'tasks.view', tenantOnly: true, load: () => import('./pages/tasks.js') },
  { path: '#/agenda', title: 'Agenda', module: 'agenda', perm: 'agenda.view', tenantOnly: true, load: () => import('./pages/agenda.js') },
  { path: '#/checklists', title: 'Checklists', module: 'checklists', perm: 'checklists.view', tenantOnly: true, load: () => import('./pages/checklists.js') },
  { path: '#/notificacoes', title: 'Notificações', module: 'notifications', perm: 'notifications.view', tenantOnly: true, load: () => import('./pages/notifications.js') },
  { path: '#/fornecedores', title: 'Fornecedores', module: 'suppliers', perm: 'suppliers.view', tenantOnly: true, load: () => import('./pages/suppliers.js') },
  { path: '#/relatorios', title: 'Relatórios', module: 'reports', perm: 'reports.view', tenantOnly: true, load: () => import('./pages/reports.js') },
  { path: '#/contas-a-pagar', title: 'Contas a Pagar', module: 'payables', perm: 'payables.view', tenantOnly: true, load: () => import('./pages/payables.js') },
  { path: '#/contas-a-receber', title: 'Contas a Receber', module: 'receivables', perm: 'receivables.view', tenantOnly: true, load: () => import('./pages/receivables.js') },
  // Gestão (tenant)
  { path: '#/lojas', title: 'Lojas', perm: 'stores.view', load: () => import('./pages/stores.js') },
  { path: '#/usuarios', title: 'Usuários', perm: 'users.view', load: () => import('./pages/users.js') },
  { path: '#/empresa', title: 'Minha empresa', perm: 'company.settings.view', load: () => import('./pages/company.js') },
  // Plataforma (Master)
  { path: '#/plataforma', title: 'Visão geral da plataforma', perm: 'platform.overview.view', load: () => import('./pages/platform-overview.js') },
  { path: '#/plataforma/assinaturas', title: 'Financeiro SaaS', perm: 'platform.billing.view', load: () => import('./pages/billing.js') },
  { path: '#/plataforma/empresas', title: 'Empresas da plataforma', perm: 'platform.companies.view', load: () => import('./pages/platform.js') },
  { path: '#/plataforma/lojas', title: 'Lojas da plataforma', perm: 'platform.stores.view', load: () => import('./pages/platform-stores.js') },
  { path: '#/plataforma/usuarios', title: 'Usuários da plataforma', perm: 'platform.users.view', load: () => import('./pages/platform-users.js') },
  { path: '#/plataforma/auditoria', title: 'Auditoria da plataforma', perm: 'platform.audit.view', load: () => import('./pages/platform-audit.js') },
  { path: '#/plataforma/config', title: 'Configurações da plataforma', perm: 'platform.settings.view', load: () => import('./pages/platform-settings.js') },
  // Conta
  { path: '#/perfil', title: 'Meu perfil', load: () => import('./pages/profile.js') },
];

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
function menuGroups() {
  const pick = (paths) => routes.filter((r) => paths.includes(r.path));
  // Item entra no menu somente se: permissão concedida E módulo ativo para a
  // empresa E (item de tenant ⇒ usuário vinculado a uma empresa).
  const visible = (r) =>
    (!r.perm || session.hasPerm(r.perm)) &&
    (!r.module || session.moduleActive(r.module)) &&
    (!r.tenantOnly || (session.me && session.me.company !== null));

  const groups = [];
  const geral = pick(['#/dashboard']).filter(visible);
  if (geral.length) groups.push({ title: 'Geral', items: geral });
  const comercial = pick(['#/vendas', '#/clientes', '#/produtos', '#/fornecedores', '#/metas', '#/ranking']).filter(visible);
  if (comercial.length) groups.push({ title: 'Comercial', items: comercial });
  const operacao = pick(['#/tarefas', '#/agenda', '#/checklists', '#/notificacoes',
    '#/estoque', '#/compras', '#/transferencias', '#/inventario']).filter(visible);
  const financeiro = pick(['#/contas-a-pagar', '#/contas-a-receber']).filter(visible);
  if (financeiro.length) groups.push({ title: 'Financeiro', items: financeiro });
  if (operacao.length) groups.push({ title: 'Operação', items: operacao });
  const relatorios = pick(['#/relatorios']).filter(visible);
  if (relatorios.length) groups.push({ title: 'Análise', items: relatorios });
  const gestao = pick(['#/lojas', '#/usuarios', '#/empresa'])
    .map((r) => ({ ...r, tenantOnly: true })).filter(visible);
  if (gestao.length) groups.push({ title: 'Gestão', items: gestao });
  const plat = pick(['#/plataforma', '#/plataforma/assinaturas', '#/plataforma/empresas', '#/plataforma/lojas',
    '#/plataforma/usuarios', '#/plataforma/auditoria', '#/plataforma/config']).filter(visible);
  if (plat.length) groups.push({ title: 'Plataforma', items: plat });
  return groups;
}

function renderMenu() {
  const menu = document.getElementById('menu');
  menu.innerHTML = menuGroups().map((g) => `
    <div class="menu-group">
      <div class="menu-group-title">${esc(g.title)}</div>
      ${g.items.map((r) => `
        <a class="menu-item" href="${r.path}" data-nav="${r.path}">${icon(r.path === '#/plataforma' ? 'chart' : menuIcon(r.path))}<span>${esc(r.title)}</span></a>
      `).join('')}
    </div>
  `).join('');

  const current = location.hash || '#/dashboard';
  menu.querySelectorAll('[data-nav]').forEach((a) => {
    const target = a.dataset.nav;
    const active = target === '#/plataforma'
      ? (current === '#/plataforma' || current.startsWith('#/plataforma'))
      : current.startsWith(target);
    a.classList.toggle('active', active);
  });
}

function menuIcon(path) {
  return {
    '#/dashboard': 'chart',
    '#/vendas': 'sales',
    '#/clientes': 'user',
    '#/produtos': 'store',
    '#/estoque': 'store',
    '#/tarefas': 'list',
    '#/agenda': 'clock',
    '#/checklists': 'check',
    '#/notificacoes': 'bell',
    '#/metas': 'chart',
    '#/lojas': 'store',
    '#/usuarios': 'user',
    '#/empresa': 'building',
    '#/plataforma/assinaturas': 'coins',
    '#/plataforma/empresas': 'building',
    '#/plataforma/lojas': 'store',
    '#/plataforma/usuarios': 'user',
    '#/plataforma/auditoria': 'list',
    '#/plataforma/config': 'gear',
    '#/perfil': 'user',
  }[path] || 'list';
}

/**
 * Volta à identidade padrão Oficial Link (logout / expiração de sessão).
 * Sem isso, o favicon/cores/logo da empresa anterior permaneciam na tela
 * de login do próximo usuário neste navegador.
 */
function resetBranding() {
  const root = document.documentElement;
  root.style.removeProperty('--blue-600');
  root.style.removeProperty('--cyan-500');
  root.style.removeProperty('--cyan-400');
  const brandImg = document.getElementById('brand-logo');
  if (brandImg) {
    brandImg.src = '/assets/img/logo.png';
    brandImg.classList.remove('brand-logo-custom');
  }
  document.querySelectorAll('[data-brand-name]').forEach((el) => { el.textContent = ''; });
  const favicon = document.querySelector('link[rel="icon"]');
  if (favicon) favicon.href = '/assets/img/favicon.png';
}

/**
 * Sino de notificações (v3.4) — só aparece com módulo ativo + permissão.
 * Badge de não lidas, dropdown com as últimas 6; clicar marca como lida e
 * navega pela action_url interna. Refresh: a cada troca de rota e a cada
 * 60s. Falhas são silenciosas (o sino nunca derruba a navegação).
 */
let bellTimer = null;

function canUseBell() {
  return session.me && session.hasPerm('notifications.view')
    && (session.modules || []).some((m) => m.slug === 'notifications');
}

async function refreshBellBadge() {
  const dot = document.getElementById('bell-dot');
  if (!dot) return;
  try {
    const s = await api.get('/notifications/summary');
    const n = s.unread || 0;
    dot.hidden = n === 0;
    dot.textContent = n > 9 ? '9+' : String(n);
  } catch { /* módulo desativado ou erro — mantém estado anterior */ }
}

async function renderBellDropdown() {
  const list = document.getElementById('bell-list');
  if (!list) return;
  try {
    const s = await api.get('/notifications/summary');
    if (!s.recent.length) {
      list.innerHTML = '<div class="dropdown-empty">Nenhuma notificação no momento.</div>';
      return;
    }
    list.innerHTML = s.recent.map((n) => `
      <button class="notif-item ${n.read_at ? '' : 'unread'}" data-nid="${n.id}" data-url="${esc(n.action_url || '#/notificacoes')}">
        <span class="t">${esc(n.title)}</span>
        ${n.message ? `<span class="m">${esc(n.message)}</span>` : ''}
      </button>`).join('');
    list.querySelectorAll('.notif-item').forEach((b) => b.addEventListener('click', async () => {
      try { await api.post(`/notifications/${b.dataset.nid}/read`); } catch { /* já lida */ }
      closeBell();
      location.hash = b.dataset.url.startsWith('#/') ? b.dataset.url.slice(1) : b.dataset.url;
      refreshBellBadge();
    }));
  } catch {
    list.innerHTML = '<div class="dropdown-empty">Não foi possível carregar.</div>';
  }
}

function closeBell() {
  const drop = document.getElementById('bell-drop');
  const btn = document.getElementById('bell-btn');
  if (drop) drop.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function setupBell() {
  const wrap = document.getElementById('bell-wrap');
  if (!wrap) return;
  if (!canUseBell()) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const btn = document.getElementById('bell-btn');
  const drop = document.getElementById('bell-drop');
  btn.onclick = (e) => {
    e.stopPropagation();
    const open = drop.hidden;
    drop.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) renderBellDropdown();
  };
  drop.onclick = (e) => e.stopPropagation();
  if (!setupBell.outsideBound) {
    setupBell.outsideBound = true;
    document.addEventListener('click', closeBell);
  }
  const all = document.getElementById('bell-all');
  if (all) all.onclick = () => closeBell();
  refreshBellBadge();
  if (bellTimer) clearInterval(bellTimer);
  bellTimer = setInterval(refreshBellBadge, 60000);
}

/**
 * Identidade visual da empresa (v3.1) — aplicada a partir do /me (disponível
 * a todos os usuários do tenant). Cores validadas no backend (hex somente);
 * sem personalização, mantém o padrão Oficial Link. Falha de carregamento
 * NUNCA bloqueia o ERP — cai no padrão silenciosamente (exceto erros de
 * autorização, que o backend já trata).
 */
function applyBranding() {
  const b = session.me && session.me.branding;
  const root = document.documentElement;

  // Cores: sobrescrevem os tokens base do design system (botões, gradientes)
  if (b && b.primary_color) root.style.setProperty('--blue-600', b.primary_color);
  if (b && b.secondary_color) root.style.setProperty('--cyan-500', b.secondary_color);
  if (b && b.accent_color) root.style.setProperty('--cyan-400', b.accent_color);
  if (!b) {
    root.style.removeProperty('--blue-600');
    root.style.removeProperty('--cyan-500');
    root.style.removeProperty('--cyan-400');
  }

  // Nome de exibição (sidebar + contexto no topo)
  const displayName = (b && b.display_name) || (session.me.company && session.me.company.name) || '';
  document.querySelectorAll('[data-brand-name]').forEach((el) => { el.textContent = displayName; });

  // Logotipo personalizado (ou padrão Oficial Link)
  const brandImg = document.getElementById('brand-logo');
  if (brandImg) {
    if (b && b.logo_url) {
      brandImg.src = b.logo_url;
      brandImg.classList.add('brand-logo-custom');
    } else {
      brandImg.src = '/assets/img/logo.png';
      brandImg.classList.remove('brand-logo-custom');
    }
  }

  // Favicon dinâmico: selo SVG com a cor de destaque + inicial (seguro:
  // cores validadas no backend, texto escapado aqui)
  const favicon = document.querySelector('link[rel="icon"]');
  if (favicon) {
    if (b && (b.accent_color || b.primary_color)) {
      const initial = String(displayName || 'O').trim().charAt(0).toUpperCase();
      const bg = b.accent_color || b.primary_color;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${bg}"/><text x="32" y="44" font-family="Arial,sans-serif" font-size="34" font-weight="700" fill="#fff" text-anchor="middle">${initial}</text></svg>`;
      favicon.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    } else {
      favicon.href = '/assets/img/favicon.png';
    }
  }
}

function ensureLayout() {
  if (document.getElementById('layout')) return;
  const app = document.getElementById('app');
  const me = session.me;
  const ctx = me.company
    ? `${me.company.name}${me.store ? ' · ' + me.store.name : ''}`
    : 'Oficial Link Sistemas';

  app.innerHTML = `
    <div class="layout" id="layout">
      <aside class="sidebar" id="sidebar">
        <div class="brand">
          <img id="brand-logo" src="/assets/img/logo.png" alt="Oficial Link">
          <span class="brand-names">
            <span class="brand-display" data-brand-name></span>
            <span class="brand-tag">ERP</span>
          </span>
        </div>
        <nav class="menu" id="menu"></nav>
        <div class="sidebar-foot">Oficial Link Sistemas<br>www.oficiallink.com</div>
      </aside>
      <div class="main">
        <header class="topbar">
          <button class="icon-btn menu-toggle" id="menu-toggle" aria-label="Abrir menu">☰</button>
          <div class="page-title" id="page-title"></div>
          <div class="topbar-spacer"></div>
          <div class="ctx-badge"><span class="dot"></span><span>${esc(ctx)}</span></div>
          <div class="bell-wrap" id="bell-wrap" hidden>
            <button class="icon-btn" id="bell-btn" aria-label="Notificações" aria-expanded="false">
              ${icon('activity')}<span class="bell-dot" id="bell-dot" hidden></span>
            </button>
            <div class="dropdown notif-drop" id="bell-drop" hidden>
              <div class="dropdown-title">Notificações</div>
              <div id="bell-list"><div class="dropdown-empty">Carregando…</div></div>
              <div class="dropdown-foot"><a href="#/notificacoes" id="bell-all">Ver todas</a></div>
            </div>
          </div>
          <div class="user-wrap">
            <button class="user-chip" id="user-btn">
              <span class="avatar">${esc(initials(me.user.name))}</span>
              <span class="who"><strong>${esc(me.user.name)}</strong><span>${esc(me.role.name)}</span></span>
            </button>
            <div class="dropdown" id="user-drop" style="min-width:250px">
              <div class="dropdown-head">
                <strong>${esc(me.user.name)}</strong>
                <span>${esc(me.user.email)}</span>
              </div>
              <a class="dropdown-item" href="#/perfil">${icon('user', 15)} Meu perfil</a>
              <button class="dropdown-item" id="logout-btn" style="color:var(--danger)">${icon('ban', 15)}&nbsp; Sair</button>
            </div>
          </div>
        </header>
        <main class="view" id="view"></main>
      </div>
    </div>`;

  // Menu mobile (≤860px): sidebar vira gaveta com overlay — abrir, fechar
  // (item selecionado, clique fora, Escape ou redimensionar para desktop).
  const sidebar = document.getElementById('sidebar');
  const toggleBtn = document.getElementById('menu-toggle');
  const overlay = document.createElement('div');
  overlay.className = 'sidebar-overlay';
  document.getElementById('layout').appendChild(overlay);

  const closeSidebar = () => {
    sidebar.classList.remove('open');
    overlay.classList.remove('show');
    toggleBtn.setAttribute('aria-expanded', 'false');
  };
  toggleBtn.addEventListener('click', () => {
    const open = sidebar.classList.toggle('open');
    overlay.classList.toggle('show', open);
    toggleBtn.setAttribute('aria-expanded', String(open));
  });
  overlay.addEventListener('click', closeSidebar);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSidebar(); });
  window.addEventListener('resize', () => { if (window.innerWidth > 860) closeSidebar(); });
  document.getElementById('menu').addEventListener('click', (e) => {
    if (e.target.closest('.menu-item')) closeSidebar();
  });

  const toggleDrop = (btnId, dropId) => {
    const btn = document.getElementById(btnId);
    const drop = document.getElementById(dropId);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.dropdown.open').forEach((d) => { if (d !== drop) d.classList.remove('open'); });
      drop.classList.toggle('open');
    });
  };
  setupBell();
  toggleDrop('user-btn', 'user-drop');
  document.addEventListener('click', () => {
    document.querySelectorAll('.dropdown.open').forEach((d) => d.classList.remove('open'));
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    try { await api.post('/auth/logout'); } catch { /* sessão já era */ }
    session.clear();
    location.hash = '#/login';
  });
}

// ---------------------------------------------------------------------------
// Troca de senha obrigatória (definida pelo backend via mustChangePassword)
// ---------------------------------------------------------------------------
async function enforcePasswordChange() {
  if (!session.me?.user?.mustChangePassword) return;
  document.body.classList.add('no-scroll');
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="alertdialog" aria-modal="true">
      <div class="modal-head"><h3>Defina uma nova senha</h3></div>
      <div class="modal-body">
        <div class="alert alert-warning">Sua senha foi redefinida por um administrador.
        Por segurança, você precisa criar uma nova senha antes de continuar.</div>
        <form id="forced-pwd" novalidate>
          <div class="field">
            <label>Nova senha</label>
            <input class="input" type="password" name="new_password" required minlength="8" autocomplete="new-password">
            <div class="hint">Mínimo de 8 caracteres.</div>
          </div>
          <div class="field">
            <label>Confirmar nova senha</label>
            <input class="input" type="password" name="confirm" required minlength="8" autocomplete="new-password">
          </div>
          <div class="modal-foot" style="margin-top:6px">
            <button class="btn btn-primary" type="submit" id="forced-btn">Salvar nova senha</button>
          </div>
        </form>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const form = overlay.querySelector('#forced-pwd');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (form.new_password.value !== form.confirm.value) {
      toast('As senhas não coincidem.', 'error');
      return;
    }
    const btn = overlay.querySelector('#forced-btn');
    btn.disabled = true;
    btn.textContent = 'Salvando…';
    try {
      // a senha atual é a temporária definida pelo administrador
      await api.post('/auth/change-password', {
        current_password: prompt('Informe a senha temporária recebida do administrador:') || '',
        new_password: form.new_password.value,
      });
      session.me = null;
      await session.load();
      overlay.remove();
      document.body.classList.remove('no-scroll');
      toast('Senha alterada com sucesso.');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Salvar nova senha';
    }
  });
}

// ---------------------------------------------------------------------------
// Roteador
// ---------------------------------------------------------------------------
async function renderLogin() {
  const app = document.getElementById('app');
  app.innerHTML = '<div class="login-screen" id="login-root"></div>';
  const { renderLogin: page } = await import('./pages/login.js');
  await page(document.getElementById('login-root'));
}

function renderForbidden(view) {
  view.innerHTML = `
    <div class="card"><div class="state-box">
      <h3>Acesso restrito</h3>
      <p>Sua função (“${esc(session.me.role.name)}”) não possui permissão para este módulo.<br>
      Solicite ao administrador da sua empresa caso precise de acesso.</p>
    </div></div>`;
}

async function route() {
  const hash = location.hash || '#/dashboard';

  if (hash.startsWith('#/login')) {
    if (session.me) { location.hash = '#/dashboard'; return; }
    await renderLogin();
    return;
  }

  if (!session.me) {
    try { await session.load(); } catch { location.hash = '#/login'; return; }
  }

  ensureLayout();
  renderMenu();
  applyBranding();
  await enforcePasswordChange();

  const view = document.getElementById('view');
  const match =
    routes.find((r) => r.path === hash) ||
    routes.find((r) => hash.startsWith(r.path + '/')) ||
    null;

  document.getElementById('page-title').textContent = match ? match.title : 'Página não encontrada';

  if (!match) {
    view.innerHTML = `
      <div class="card"><div class="state-box">
        <h3>Página não encontrada</h3>
        <p>O endereço acessado não existe no sistema.</p>
        <p style="margin-top:14px"><a class="btn btn-primary" href="#/dashboard">Ir para o Dashboard</a></p>
      </div></div>`;
    return;
  }

  if (match.perm && !session.hasPerm(match.perm)) {
    renderForbidden(view);
    return;
  }

  view.innerHTML = '<div class="loading-line">Carregando…</div>';
  try {
    const mod = await match.load();
    await mod.render(view);
  } catch (err) {
    if (err.status === 401) return; // sessão:expired já redirecionou
    if (err.code === 'MUST_CHANGE_PASSWORD' || /trocar sua senha/.test(err.message)) {
      await session.load();
      await enforcePasswordChange();
      return;
    }
    view.innerHTML = `
      <div class="alert alert-error">Não foi possível carregar esta tela: ${esc(err.message)}</div>`;
  }
}

window.addEventListener('hashchange', route);

(async function boot() {
  if (!location.hash) location.hash = '#/dashboard';
  await route();
})();
