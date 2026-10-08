'use strict';

/**
 * Branding da empresa (v3.1) — validação e leitura da identidade visual.
 * Persistido em companies.settings.branding (JSON existente) + logo em
 * company_assets (BLOB). NUNCA permite CSS/JS arbitrário: cores apenas em
 * hexadecimal validado; logo apenas PNG/JPEG validado por MAGIC BYTES.
 */

const db = require('../../database/connection');
const { badRequest } = require('../../core/errors');

const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const DEFAULTS = {
  display_name: null,   // null = usa o nome cadastral
  primary_color: null,  // null = padrão Oficial Link
  secondary_color: null,
  accent_color: null,
};
const LOGO_MAX_BYTES = 150 * 1024;

function validColor(value, field) {
  const s = String(value || '').trim();
  if (!COLOR_RE.test(s)) throw badRequest(`${field} inválida. Use hexadecimal, ex.: #2563EB.`);
  return s.toUpperCase();
}

function validDisplayName(value) {
  const s = String(value || '').trim();
  if (s.length < 2 || s.length > 80) throw badRequest('Nome de exibição inválido (2 a 80 caracteres).');
  return s;
}

/** Lê o branding salvo no settings, aplicando defaults seguros. */
function parseBranding(settingsJson) {
  let raw = {};
  try { raw = JSON.parse(settingsJson || '{}').branding || {}; } catch { /* defaults */ }
  const out = { ...DEFAULTS };
  if (typeof raw.display_name === 'string' && raw.display_name.trim()) out.display_name = raw.display_name.trim().slice(0, 80);
  for (const k of ['primary_color', 'secondary_color', 'accent_color']) {
    if (typeof raw[k] === 'string' && COLOR_RE.test(raw[k])) out[k] = raw[k].toUpperCase();
  }
  return out;
}

/** Valida e normaliza o payload de branding do PATCH (campos opcionais). */
function validateBrandingPayload(data) {
  const out = {};
  if (data.display_name !== undefined) {
    out.display_name = data.display_name === null || data.display_name === '' ? null : validDisplayName(data.display_name);
  }
  for (const [k, label] of [['primary_color', 'Cor principal'], ['secondary_color', 'Cor secundária'], ['accent_color', 'Cor de destaque']]) {
    if (data[k] !== undefined) {
      out[k] = data[k] === null || data[k] === '' ? null : validColor(data[k], label);
    }
  }
  return out;
}

/**
 * Valida logo em base64: magic bytes PNG/JPEG (nunca confia em extensão/MIME),
 * limite de 150 KB. Retorna { mime, buffer } ou lança 400.
 */
function decodeLogo(logoData) {
  if (typeof logoData !== 'string' || !logoData) throw badRequest('Logotipo inválido.');
  const base64 = logoData.includes(',') ? logoData.slice(logoData.indexOf(',') + 1) : logoData;
  let buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch {
    throw badRequest('Logotivo inválido (base64).');
  }
  if (!buffer.length) throw badRequest('Logotipo vazio.');
  if (buffer.length > LOGO_MAX_BYTES) throw badRequest('Logotipo excede o limite de 150 KB.');
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { mime: 'image/png', buffer };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: 'image/jpeg', buffer };
  }
  throw badRequest('Formato de logotipo não permitido. Use PNG ou JPEG.');
}

async function saveLogo(companyId, decoded) {
  await db.prepare(
    `INSERT INTO company_assets (company_id, mime, data, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(company_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`
  ).run(companyId, decoded.mime, decoded.buffer);
}

async function getLogo(companyId) {
  return await db.prepare('SELECT mime, data, updated_at FROM company_assets WHERE company_id = ?').get(companyId);
}

async function clearLogo(companyId) {
  await db.prepare('DELETE FROM company_assets WHERE company_id = ?').run(companyId);
}

module.exports = { DEFAULTS, parseBranding, validateBrandingPayload, decodeLogo, saveLogo, getLogo, clearLogo };
