'use strict';

/**
 * Datas de NEGÓCIO por empresa — fonte central (v3.0).
 * "Hoje" empresarial segue o timezone do cadastro da company (settings JSON);
 * NUNCA o UTC do servidor. Usado por Contas a Receber (e disponível para
 * refatoração futura do Contas a Pagar, que já possui cópia equivalente).
 */

const db = require('../database/connection');

async function companyTimezone(companyId) {
  const row = await db.prepare('SELECT settings FROM companies WHERE id = ?').get(companyId);
  try { return JSON.parse(row?.settings || '{}').timezone || 'America/Fortaleza'; } catch { return 'America/Fortaleza'; }
}

/** Formata uma Date como AAAA-MM-DD no fuso informado (formatToParts — confiável
 *  em qualquer ICU; não depende do formato do locale). */
function formatInTz(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function businessToday(companyId) {
  const tz = await companyTimezone(companyId);
  try {
    return formatInTz(new Date(), tz);
  } catch (err) {
    // NUNCA mascarar configuração inválida caindo para UTC — erro explícito e
    // determinístico (visível no log do servidor) em vez de data errada.
    throw new Error(`Timezone empresarial inválida (${tz}): ${err.message}`);
  }
}

async function businessMonthStart(companyId) {
  return `${(await businessToday(companyId)).slice(0, 8)}01`;
}

function addDays(yyyyMmDd, days) {
  const d = new Date(`${yyyyMmDd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

module.exports = { companyTimezone, formatInTz, businessToday, businessMonthStart, addDays };
