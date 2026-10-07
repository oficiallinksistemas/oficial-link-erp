'use strict';

/**
 * Validação manual e explícita dos dados de entrada.
 * Regra: nunca confiar no cliente — todo payload passa por aqui antes
 * de tocar o banco de dados.
 */

const { badRequest } = require('./errors');

const isStr = (v) => typeof v === 'string';

function reqString(value, field, opts = {}) {
  if (!isStr(value) || !value.trim()) throw badRequest(`${field} é obrigatório.`);
  const v = value.trim();
  const { min = 1, max = 255 } = opts;
  if (v.length < min) throw badRequest(`${field} deve ter no mínimo ${min} caracteres.`);
  if (v.length > max) throw badRequest(`${field} deve ter no máximo ${max} caracteres.`);
  return v;
}

function optString(value, field, opts = {}) {
  if (value === undefined || value === null) return undefined;
  return reqString(value, field, opts);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function reqEmail(value, field = 'E-mail') {
  const v = reqString(value, field, { max: 190 });
  if (!EMAIL_RE.test(v) || v.length > 190) throw badRequest(`${field} inválido.`);
  return v.toLowerCase();
}

function reqPassword(value, field = 'Senha') {
  const v = reqString(value, field, { min: 8, max: 100 });
  return v;
}

function optPassword(value, field = 'Senha') {
  if (value === undefined || value === null || value === '') return undefined;
  return reqPassword(value, field);
}

function reqInt(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw badRequest(`${field} inválido.`);
  return n;
}

function optInt(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  return reqInt(value, field);
}

function reqEnum(value, field, allowed) {
  const v = reqString(value, field);
  if (!allowed.includes(v)) throw badRequest(`${field} inválido.`);
  return v;
}

function optEnum(value, field, allowed) {
  if (value === undefined || value === null) return undefined;
  return reqEnum(value, field, allowed);
}

/** Paginação server-side com limites seguros. */
function pagination(query) {
  let page = parseInt(query.page, 10);
  let perPage = parseInt(query.per_page, 10);
  if (!Number.isInteger(page) || page < 1) page = 1;
  if (!Number.isInteger(perPage)) perPage = 10;
  perPage = Math.min(50, Math.max(5, perPage));
  return { page, perPage, offset: (page - 1) * perPage };
}

module.exports = {
  reqString,
  optString,
  reqEmail,
  reqPassword,
  optPassword,
  reqInt,
  optInt,
  reqEnum,
  optEnum,
  pagination,
};
