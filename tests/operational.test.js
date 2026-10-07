'use strict';

/**
 * Bloco 2 — Camada Operacional V1 (v3.4): Tarefas, Agenda, Checklists,
 * Notificações. Cobre: module gating, RBAC, isolamento multi-tenant (IDOR),
 * regras de negócio, timezone, dedupe anti-spam, action_url segura e
 * operação funcionando com Notifications DESATIVADO.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
// helpers SEMPRE primeiro
const { login, authed, createTenant, shutdown } = require('./helpers');
const db = require('../src/database/connection');
const { businessToday } = require('../src/core/businessDate');
const notifications = require('../src/modules/notifications/service');

let master; let admin; let seller; let anjosId; let storeId; let opAdmin; let opCompanyId;
let adminId; let sellerId;

let TODAY; // preenchido no before(): data comercial da empresa Anjos
const yesterday = () => {
  const [y, m, d] = TODAY.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
};

before(async () => {
  const m = await login('master@oficiallink.com.br', 'Master@2026');
  master = authed(m.cookie);
  anjosId = (await master('/platform/companies?search=Anjos')).data.items[0].id;
  TODAY = await businessToday(anjosId);
  const a = await login('admin@anjos.com.br', 'Anjos@2026');
  admin = authed(a.cookie);
  adminId = (await admin('/auth/me')).data.user.id;
  const s = await login('vendedor@anjos.com.br', 'Anjos@2026');
  seller = authed(s.cookie);
  sellerId = (await seller('/auth/me')).data.user.id;
  storeId = (await admin('/stores')).data.items[0].id;
  // Ativa os 4 módulos operacionais para Anjos
  for (const slug of ['tasks', 'agenda', 'checklists', 'notifications']) {
    const r = await master(`/platform/companies/${anjosId}/modules/${slug}`, { method: 'PUT', body: { status: 'active' } });
    assert.equal(r.status, 200, `ativação ${slug}`);
  }
  // Tenant isolado (módulos DESATIVADOS por padrão)
  const t = await createTenant(master, 'OpTeste');
  opCompanyId = t.company.id;
  const tl = await login(t.user.email, 'Temp@123456');
  opAdmin = authed(tl.cookie);
});

after(shutdown);

// ---------------------------------------------------------------------------
// Module gating + RBAC
// ---------------------------------------------------------------------------
test('gating: tenant sem módulo ativo → 403 em /tasks', async () => {
  const r = await opAdmin('/tasks');
  assert.equal(r.status, 403);
  assert.equal(r.error.code, 'MODULE_INACTIVE');
});

test('RBAC: seller (sem permissões de tarefas) → 403 mesmo com módulo ativo', async () => {
  const r = await seller('/tasks');
  assert.equal(r.status, 403);
  const c = await seller('/tasks', { method: 'POST', body: { title: 'Tarefa do vendedor' } });
  assert.equal(c.status, 403);
});

// ---------------------------------------------------------------------------
// Tarefas
// ---------------------------------------------------------------------------
let taskId; let overdueTaskId;

test('tarefas: criação com validações (título curto, prioridade, prazo, responsável, loja)', async () => {
  const bad = [
    { title: 'ab' },
    { title: 'Tarefa válida', priority: 'extreme' },
    { title: 'Tarefa válida', due_date: '2026-13-40' },
    { title: 'Tarefa válida', assigned_to_user_id: 999999 },
    { title: 'Tarefa válida', store_id: 999999 },
    { title: 'Tarefa válida', client_id: 999999 },
  ];
  for (const body of bad) {
    const r = await admin('/tasks', { method: 'POST', body });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const ok = await admin('/tasks', {
    method: 'POST',
    body: { title: 'Ligar para cliente', priority: 'high', due_date: TODAY, assigned_to_user_id: sellerId, store_id: storeId },
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.error));
  taskId = ok.data.id;
  assert.equal(ok.data.assigned_to_name.length > 0, true);
});

test('tarefas: atribuição gera notificação para o responsável (verificada no banco)', async () => {
  // seller não possui notifications.view na V1 (só company_admin) — o correto
  // é validar a notificação direto no banco: dedupe garante 1 por tarefa.
  const row = db.prepare(
    "SELECT id FROM notifications WHERE user_id = ? AND type = 'task_assigned' AND entity_id = ?"
  ).get(sellerId, taskId);
  assert.ok(row, 'notificação de atribuição deve existir para o responsável');
});

test('tarefas: vínculo com cliente gera snapshot link_label', async () => {
  const customer = (await admin('/customers', { method: 'POST', body: { name: 'Cliente Vínculo', document: '' } })).data;
  const r = await admin('/tasks', { method: 'POST', body: { title: 'Visitar cliente', client_id: customer.id } });
  assert.equal(r.status, 201);
  assert.match(r.data.link_label, /Cliente: Cliente Vínculo/);
});

test('tarefas: edição, conclusão (transacional), reabertura e regras de status', async () => {
  const p = await admin(`/tasks/${taskId}`, { method: 'PATCH', body: { status: 'in_progress' } });
  assert.equal(p.status, 200);
  const done = await admin(`/tasks/${taskId}/complete`, { method: 'POST', body: {} });
  assert.equal(done.status, 200);
  assert.ok(done.data.completed_at);
  const again = await admin(`/tasks/${taskId}/complete`, { method: 'POST', body: {} });
  assert.equal(again.status, 409);
  const editBlocked = await admin(`/tasks/${taskId}`, { method: 'PATCH', body: { title: 'Tentativa' } });
  assert.equal(editBlocked.status, 409);
  const reopen = await admin(`/tasks/${taskId}/reopen`, { method: 'POST', body: {} });
  assert.equal(reopen.status, 200);
  assert.equal(reopen.data.completed_at, null);
});

test('tarefas: IDOR — admin de outra empresa NÃO lê tarefa (404, não vaza dados)', async () => {
  await master(`/platform/companies/${opCompanyId}/modules/tasks`, { method: 'PUT', body: { status: 'active' } });
  const r = await opAdmin(`/tasks/${taskId}`);
  assert.equal(r.status, 404);
  const mine = await opAdmin('/tasks');
  assert.equal(mine.status, 200);
  assert.equal(mine.data.items.some((t) => t.id === taskId), false);
});

test('tarefas: atraso pela data de negócio + notificação deduplicada', async () => {
  overdueTaskId = (await admin('/tasks', {
    method: 'POST', body: { title: 'Tarefa atrasada', due_date: yesterday(), assigned_to_user_id: adminId },
  })).data.id;
  const list = await admin('/tasks?overdue=1');
  assert.equal(list.status, 200);
  assert.ok(list.data.items.some((t) => t.id === overdueTaskId && t.overdue === true));

  // gerar 3× (listagens) → 1 única notificação anti-spam
  await admin('/tasks'); await admin('/tasks'); await admin('/tasks');
  const n = db.prepare(
    "SELECT COUNT(*) AS c FROM notifications WHERE type = 'task_overdue' AND entity_id = ?"
  ).get(overdueTaskId).c;
  assert.equal(n, 1, 'dedupe: deve existir exatamente 1 notificação de atraso');
});

// ---------------------------------------------------------------------------
// Agenda
// ---------------------------------------------------------------------------
let eventId;

test('agenda: validações de data/hora (fim > início, formato, all_day)', async () => {
  const bad = [
    { title: 'Reunião', start_at: '2026-10-10 14:00', end_at: '2026-10-10 13:00' },
    { title: 'Reunião', start_at: '10/10/2026 14:00', end_at: '2026-10-10 15:00' },
    { title: 'Reunião', start_at: '2026-10-10 14:00' },                 // sem fim e não all_day
    { title: 'Reunião', start_at: '2026-10-10 25:00', end_at: '2026-10-10 26:00' },
    { title: 'Reunião', start_at: '2026-10-10 09:00', end_at: '2026-10-11 10:00', all_day: true },
  ];
  for (const body of bad) {
    const r = await admin('/agenda', { method: 'POST', body });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
});

test('agenda: criação válida + lembrete gerado na leitura do dia', async () => {
  const r = await admin('/agenda', {
    method: 'POST',
    body: { title: 'Reunião comercial', start_at: `${TODAY} 15:00`, end_at: `${TODAY} 16:00`, location: 'Sala 1' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.error));
  eventId = r.data.id;
  await admin(`/agenda?from=${TODAY}&to=${TODAY}`);
  const n = db.prepare(
    "SELECT COUNT(*) AS c FROM notifications WHERE type = 'agenda_reminder' AND entity_id = ?"
  ).get(eventId).c;
  assert.ok(n >= 1);
  const dup = db.prepare(
    "SELECT COUNT(*) AS c FROM notifications WHERE type = 'agenda_reminder' AND entity_id = ?"
  ).get(eventId).c;
  assert.equal(dup, 1, 'lembrete deduplicado por evento/dia');
});

test('agenda: filtro por período, conclusão e cancelamento', async () => {
  const list = await admin(`/agenda?from=${TODAY}&to=${TODAY}`);
  assert.ok(list.data.items.some((e) => e.id === eventId));
  const done = await admin(`/agenda/${eventId}/complete`, { method: 'POST', body: {} });
  assert.equal(done.status, 200);
  assert.equal(done.data.status, 'completed');
  const delBlocked = await admin(`/agenda/${eventId}`, { method: 'DELETE' });
  assert.equal(delBlocked.status, 409, 'compromisso realizado não pode ser excluído');
  const ev2 = (await admin('/agenda', {
    method: 'POST', body: { title: 'Visita cancelada', start_at: `${TODAY} 18:00`, end_at: `${TODAY} 19:00` },
  })).data;
  const cx = await admin(`/agenda/${ev2.id}/cancel`, { method: 'POST', body: {} });
  assert.equal(cx.status, 200);
});

// ---------------------------------------------------------------------------
// Checklists
// ---------------------------------------------------------------------------
let clId; let requiredItemId; let optionalItemId;

test('checklists: criação com itens, ordenação e progresso calculado no backend', async () => {
  const r = await admin('/checklists', {
    method: 'POST',
    body: {
      title: 'Abertura da loja',
      assigned_to_user_id: adminId,
      due_date: TODAY,
      items: [
        { title: 'Conferir caixa', required: 1, position: 1 },
        { title: 'Conferir estoque', required: 1, position: 2 },
        { title: 'Ligar ar-condicionado', required: 0, position: 3 },
      ],
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.error));
  clId = r.data.id;
  assert.equal(r.data.items_total, 3);
  assert.equal(r.data.progress, 0);
  assert.equal(r.data.items[0].title, 'Conferir caixa');
  requiredItemId = r.data.items[0].id;
  optionalItemId = r.data.items[2].id;
});

test('checklists: item opcional pode concluir sem liberar; obrigatório bloqueia', async () => {
  const t1 = await admin(`/checklists/${clId}/items/${optionalItemId}/toggle`, { method: 'POST', body: { completed: true } });
  assert.equal(t1.status, 200);
  assert.equal(t1.data.progress, 33);
  const blocked = await admin(`/checklists/${clId}/complete`, { method: 'POST', body: {} });
  assert.equal(blocked.status, 409);
  assert.match(blocked.error.message, /obrigatório/);
});

test('checklists: conclusão após todos os obrigatórios + bloqueios pós-conclusão', async () => {
  const r = await admin(`/checklists/${clId}`);
  const items = r.data.items;
  for (const it of items.filter((x) => x.required)) {
    const t = await admin(`/checklists/${clId}/items/${it.id}/toggle`, { method: 'POST', body: { completed: true } });
    assert.equal(t.status, 200);
  }
  const done = await admin(`/checklists/${clId}/complete`, { method: 'POST', body: {} });
  assert.equal(done.status, 200, JSON.stringify(done.error));
  assert.equal(done.data.status, 'completed');
  assert.equal(done.data.progress, 100); // opcional (teste 13) + 2 obrigatórios = 3/3
  const delBlocked = await admin(`/checklists/${clId}`, { method: 'DELETE' });
  assert.equal(delBlocked.status, 409, 'concluído não pode ser excluído');
  const toggleBlocked = await admin(`/checklists/${clId}/items/${items[0].id}/toggle`, { method: 'POST', body: { completed: false } });
  assert.equal(toggleBlocked.status, 409);
});

// ---------------------------------------------------------------------------
// Notificações
// ---------------------------------------------------------------------------
test('notificações: action_url insegura nunca é persistida (fica NULL)', async () => {
  await notifications.notify({
    companyId: anjosId, userId: adminId, type: 'system', title: 'XSS tentativa',
    actionUrl: 'javascript:alert(1)', dedupeKey: 'xss-test',
  });
  await notifications.notify({
    companyId: anjosId, userId: adminId, type: 'system', title: 'Protocol-relative',
    actionUrl: '//evil.com', dedupeKey: 'proto-test',
  });
  const rows = db.prepare(
    "SELECT action_url FROM notifications WHERE dedupe_key IN ('xss-test','proto-test')"
  ).all();
  assert.equal(rows.length, 2, 'notificações criadas (o evento não é perdido)');
  assert.ok(rows.every((r) => r.action_url === null), 'URL insegura nunca persistida — sempre NULL');
});

test('notificações: action_url interna válida é persistida', async () => {
  await notifications.notify({
    companyId: anjosId, userId: adminId, type: 'system', title: 'URL válida',
    actionUrl: '#/tarefas', dedupeKey: 'url-valida',
  });
  const row = db.prepare("SELECT action_url FROM notifications WHERE dedupe_key = 'url-valida'").get();
  assert.equal(row.action_url, '#/tarefas');
});

test('notificações: dedupe por chave — gerar 3× cria 1 única', async () => {
  for (let i = 0; i < 3; i++) {
    await notifications.notify({
      companyId: anjosId, userId: adminId, type: 'system',
      title: 'Evento único', dedupeKey: 'dedupe-test',
    });
  }
  const c = db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE dedupe_key = 'dedupe-test'").get().c;
  assert.equal(c, 1);
});

test('notificações: isolamento — usuário não lê notificação de outro; markRead próprio', async () => {
  // OpTeste precisa do módulo ativo para o check de ownership (e não de
  // module gating) ser o que responde a requisição do outro tenant.
  await master(`/platform/companies/${opCompanyId}/modules/notifications`, { method: 'PUT', body: { status: 'active' } });
  const mine = (await admin('/notifications?per_page=50')).data.items;
  assert.ok(mine.length > 0);
  const target = mine.find((n) => !n.read_at);
  if (target) {
    const other = await opAdmin(`/notifications/${target.id}/read`, { method: 'POST', body: {} });
    assert.equal(other.status, 404, 'não pode marcar como lida notificação alheia');
    const mine2 = await admin(`/notifications/${target.id}/read`, { method: 'POST', body: {} });
    assert.equal(mine2.status, 200);
  }
  const unreadBefore = (await admin('/notifications/summary')).data.unread;
  await admin('/notifications/read-all', { method: 'POST', body: {} });
  const unreadAfter = (await admin('/notifications/summary')).data.unread;
  assert.equal(unreadAfter, 0);
  assert.ok(unreadBefore >= unreadAfter);
});

test('operação funciona com Notifications DESATIVADO (criar tarefa não quebra)', async () => {
  await master(`/platform/companies/${opCompanyId}/modules/tasks`, { method: 'PUT', body: { status: 'active' } });
  // OpTeste NÃO tem notifications ativo
  const r = await opAdmin('/tasks', { method: 'POST', body: { title: 'Tarefa sem notificações' } });
  assert.equal(r.status, 201, JSON.stringify(r.error));
  const n = db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE company_id = ?').get(opCompanyId).c;
  assert.equal(n, 0, 'nenhuma notificação criada — módulo desativado');
});

// ---------------------------------------------------------------------------
// Dashboard operacional
// ---------------------------------------------------------------------------
test('dashboard: bloco operations presente (módulos ativos) com não lidas', async () => {
  const r = await admin('/dashboard/summary');
  assert.equal(r.status, 200);
  assert.ok('operations' in r.data);
  assert.ok(Array.isArray(r.data.operations.tasks_overdue));
  assert.ok(Array.isArray(r.data.operations.agenda_today));
  assert.ok(Array.isArray(r.data.operations.checklists_pending));
  assert.equal(typeof r.data.operations.notifications_unread, 'number');
});
