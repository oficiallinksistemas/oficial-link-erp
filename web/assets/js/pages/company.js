/**
 * Minha empresa — dados cadastrais e configurações do tenant.
 * Somente leitura para quem tem apenas company.settings.view.
 */

import { api } from '../api.js';
import { session } from '../app.js';
import { esc, toast, badge, confirmDialog } from '../ui.js';

const TIMEZONES = [
  ['America/Fortaleza', 'Fortaleza (GMT-3)'],
  ['America/Sao_Paulo', 'São Paulo (GMT-3)'],
  ['America/Belem', 'Belém (GMT-3)'],
  ['America/Manaus', 'Manaus (GMT-4)'],
  ['America/Cuiaba', 'Cuiabá (GMT-4)'],
];

export async function render(view) {
  const canManage = session.hasPerm('company.settings.manage');
  const company = await api.get('/company');
  const tz = company.settings?.timezone || 'America/Fortaleza';

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h2>Minha empresa</h2>
        <p>Dados cadastrais e configurações — visíveis apenas para a sua empresa.</p>
      </div>
      <div class="spacer"></div>
      ${badge(company.status)}
    </div>

    <div class="card"><div class="card-pad">
      <h3 class="card-title">Dados cadastrais</h3>
      <p class="card-sub">Informações básicas da empresa no sistema.</p>
      <form id="company-form" novalidate>
        <div class="form-grid">
          <div class="field">
            <label>Razão social / Nome</label>
            <input class="input" name="name" value="${esc(company.name)}" required minlength="2" maxlength="120" ${canManage ? '' : 'disabled'}>
          </div>
          <div class="field">
            <label>Nome fantasia</label>
            <input class="input" name="trade_name" value="${esc(company.trade_name || '')}" maxlength="120" ${canManage ? '' : 'disabled'}>
          </div>
          <div class="field">
            <label>CNPJ</label>
            <input class="input" name="document" value="${esc(company.document || '')}" maxlength="20" placeholder="00.000.000/0001-00" ${canManage ? '' : 'disabled'}>
          </div>
          <div class="field">
            <label>Telefone</label>
            <input class="input" name="phone" value="${esc(company.phone || '')}" maxlength="30" placeholder="(99) 99999-9999" ${canManage ? '' : 'disabled'}>
          </div>
          <div class="field full">
            <label>E-mail de contato</label>
            <input class="input" type="email" name="email" value="${esc(company.email || '')}" maxlength="190" ${canManage ? '' : 'disabled'}>
          </div>
        </div>

        <h3 class="card-title" style="margin-top:22px">Configurações</h3>
        <p class="card-sub">Preferências operacionais da empresa.</p>
        <div class="form-grid">
          <div class="field">
            <label>Fuso horário</label>
            <select class="input" name="timezone" ${canManage ? '' : 'disabled'}>
              ${TIMEZONES.map(([v, l]) => `<option value="${v}" ${v === tz ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>Moeda padrão</label>
            <input class="input" value="Real (BRL)" disabled>
          </div>
        </div>

        ${canManage
          ? '<button class="btn btn-primary" type="submit" id="save-btn">Salvar alterações</button>'
          : '<div class="alert alert-info" style="margin-top:10px">Você tem permissão apenas para visualizar estas informações.</div>'}
      </form>
    </div></div>

    <div class="card" style="margin-top:16px"><div class="card-pad" id="branding-card">
      <h3 class="card-title">Identidade visual</h3>
      <p class="card-sub">Personalize a aparência do ERP para a sua empresa. Sem logotipo ou cores, o padrão Oficial Link é usado.</p>
      <div id="branding-body"><div class="loading-line">Carregando…</div></div>
    </div></div>`;

  // Identidade visual renderizada para TODOS que visualizam a tela
  // (company.settings.view): usuário somente leitura vê nome/cores/logo e a
  // prévia — a EDIÇÃO continua restrita a canManage dentro de renderBranding.
  await renderBranding();

  if (!canManage) return;

  const form = view.querySelector('#company-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = view.querySelector('#save-btn');
    btn.disabled = true;
    btn.textContent = 'Salvando…';
    try {
      await api.patch('/company', {
        name: form.name.value,
        trade_name: form.trade_name.value || null,
        document: form.document.value || null,
        email: form.email.value || null,
        phone: form.phone.value || null,
        timezone: form.timezone.value,
      });
      toast('Dados da empresa salvos.');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Salvar alterações';
    }
  });

  // ===================== Identidade visual (v3.1) ===========================
  async function renderBranding() {
    const body = view.querySelector('#branding-body');
    const full = await api.get('/company'); // inclui branding + logo_url
    const b = full.branding || {};
    const editable = canManage;

    body.innerHTML = `
      <div class="form-grid">
        <div class="field full">
          <label>Nome de exibição no ERP</label>
          <input class="input" id="b-display" maxlength="80" value="${esc(b.display_name || '')}"
                 placeholder="${esc(full.name)}" ${editable ? '' : 'disabled'}>
          <div class="hint">Deixe vazio para usar o nome cadastral (${esc(full.name)}).</div>
        </div>
        <div class="field full">
          <label>Cores</label>
          <div class="brand-preview">
            ${[['b-primary', 'Principal', b.primary_color || '#2563EB'],
               ['b-secondary', 'Secundária', b.secondary_color || '#06B6D4'],
               ['b-accent', 'Destaque', b.accent_color || '#22D3EE']].map(([id, label, val]) => `
              <div class="swatch"><input type="color" id="${id}" value="${esc(val)}" ${editable ? '' : 'disabled'}><span>${label}</span></div>
            `).join('')}
            <div class="swatch"><span id="sw-primary" style="background:${esc(b.primary_color || '#2563EB')}"></span><span>Botões</span></div>
            <div class="swatch"><span id="sw-secondary" style="background:${esc(b.secondary_color || '#06B6D4')}"></span><span>Menus</span></div>
            <button class="btn-demo" id="sw-demo" type="button">Exemplo</button>
          </div>
        </div>
        <div class="field full">
          <label>Logotipo (PNG ou JPEG, máx. 150 KB)</label>
          <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
            <img id="b-logo-preview" src="${esc(b.logo_url || '/assets/img/logo.png')}" alt="Logo"
                 style="width:120px;height:56px;object-fit:contain;background:#0a1330;border-radius:8px;padding:6px;border:1px solid var(--border)">
            ${editable ? `<input type="file" id="b-logo-file" accept="image/png,image/jpeg" class="input" style="max-width:280px">
            <button class="btn btn-ghost btn-sm" id="b-logo-clear" type="button">Remover logo</button>` : ''}
          </div>
        </div>
      </div>
      ${editable ? `
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn btn-primary" id="b-save">Salvar identidade</button>
        <button class="btn btn-ghost" id="b-reset">Restaurar padrões</button>
      </div>` : '<div class="alert alert-info">Apenas administradores podem alterar a identidade visual.</div>'}`;

    if (!editable) return;

    const updPreview = () => {
      const p = document.getElementById('b-primary').value;
      const s = document.getElementById('b-secondary').value;
      const a = document.getElementById('b-accent').value;
      document.getElementById('sw-primary').style.background = p;
      document.getElementById('sw-secondary').style.background = s;
      document.getElementById('sw-demo').style.background = `linear-gradient(135deg, ${s}, ${p})`;
      document.getElementById('sw-demo').style.boxShadow = `0 4px 14px -6px ${a}`;
    };
    ['b-primary', 'b-secondary', 'b-accent'].forEach((id) => document.getElementById(id).addEventListener('input', updPreview));
    updPreview();

    let pendingLogo; // undefined = inalterado; null = remover; string = novo
    document.getElementById('b-logo-file').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 150 * 1024) { toast('Logotipo excede 150 KB.', 'error'); e.target.value = ''; return; }
      const reader = new FileReader();
      reader.onload = () => {
        pendingLogo = String(reader.result);
        document.getElementById('b-logo-preview').src = pendingLogo;
        toast('Logo carregado — clique em "Salvar identidade".');
      };
      reader.readAsDataURL(file);
    });
    document.getElementById('b-logo-clear').addEventListener('click', () => {
      pendingLogo = null;
      document.getElementById('b-logo-preview').src = '/assets/img/logo.png';
      document.getElementById('b-logo-file').value = '';
      toast('Logo será removido ao salvar.');
    });

    const save = async (reset) => {
      const payload = reset
        ? { branding: { display_name: null, primary_color: null, secondary_color: null, accent_color: null }, logo_data: null }
        : {
            branding: {
              display_name: document.getElementById('b-display').value.trim() || null,
              primary_color: document.getElementById('b-primary').value,
              secondary_color: document.getElementById('b-secondary').value,
              accent_color: document.getElementById('b-accent').value,
            },
            ...(pendingLogo !== undefined ? { logo_data: pendingLogo } : {}),
          };
      try {
        await api.patch('/company', payload);
        toast(reset ? 'Identidade restaurada aos padrões.' : 'Identidade salva.');
        await session.load(); // repropaga branding no /me
        await renderBranding();
        document.dispatchEvent(new CustomEvent('branding:updated'));
      } catch (err) {
        toast(err.message, 'error');
      }
    };
    document.getElementById('b-save').addEventListener('click', () => save(false));
    document.getElementById('b-reset').addEventListener('click', async () => {
      const go = await confirmDialog('Restaurar a identidade visual padrão da Oficial Link?', { confirmLabel: 'Restaurar padrões' });
      if (go) await save(true);
    });
  }
}
