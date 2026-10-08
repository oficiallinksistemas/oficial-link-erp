'use strict';

/**
 * Seed inicial — executado automaticamente na primeira subida e idempotente.
 *
 * Cria:
 *  - catálogo de permissões
 *  - funções: Master, Administrador, Supervisor, Vendedor
 *  - vínculos função ↔ permissão
 *  - usuário Master (Oficial Link, sem empresa)
 *  - empresa "Anjos" com lojas Balsas e Imperatriz e usuários de exemplo
 */

const db = require('./db');
const config = require('../config');
const { hashPassword } = require('../core/security');

const PERMISSIONS = [
  // Plataforma (somente Master) — nível superior: MASTER PLATFORM ADMIN
  { code: 'platform.overview.view', module: 'Plataforma', description: 'Visão geral da plataforma' },
  { code: 'platform.companies.view', module: 'Plataforma', description: 'Visualizar empresas cadastradas' },
  { code: 'platform.companies.manage', module: 'Plataforma', description: 'Cadastrar, editar e suspender empresas' },
  { code: 'platform.stores.view', module: 'Plataforma', description: 'Visualizar lojas de qualquer empresa' },
  { code: 'platform.stores.manage', module: 'Plataforma', description: 'Gerenciar lojas de qualquer empresa' },
  { code: 'platform.users.view', module: 'Plataforma', description: 'Visualizar usuários de qualquer empresa' },
  { code: 'platform.users.manage', module: 'Plataforma', description: 'Gerenciar usuários de qualquer empresa' },
  { code: 'platform.audit.view', module: 'Plataforma', description: 'Visualizar auditoria da plataforma' },
  { code: 'platform.settings.view', module: 'Plataforma', description: 'Visualizar configurações da plataforma' },
  { code: 'platform.settings.manage', module: 'Plataforma', description: 'Alterar configurações da plataforma' },
  // Dashboard
  { code: 'dashboard.view', module: 'Dashboard', description: 'Visualizar o painel inicial' },
  // Lojas
  { code: 'stores.view', module: 'Lojas', description: 'Visualizar lojas' },
  { code: 'stores.manage', module: 'Lojas', description: 'Cadastrar e editar lojas' },
  // Usuários
  { code: 'users.view', module: 'Usuários', description: 'Visualizar usuários' },
  { code: 'users.manage', module: 'Usuários', description: 'Cadastrar, editar e redefinir senhas' },
  // Empresa
  { code: 'company.settings.view', module: 'Empresa', description: 'Visualizar dados da empresa' },
  { code: 'company.settings.manage', module: 'Empresa', description: 'Editar dados e configurações da empresa' },
  // Vendas (módulo comercial — v1.2)
  { code: 'sales.view', module: 'Vendas', description: 'Visualizar vendas' },
  { code: 'sales.create', module: 'Vendas', description: 'Registrar venda' },
  { code: 'sales.edit', module: 'Vendas', description: 'Editar venda' },
  { code: 'sales.cancel', module: 'Vendas', description: 'Cancelar venda' },
  // Metas (v1.3)
  { code: 'targets.view', module: 'Metas', description: 'Visualizar metas e desempenho' },
  { code: 'targets.create', module: 'Metas', description: 'Cadastrar meta' },
  { code: 'targets.edit', module: 'Metas', description: 'Editar meta' },
  { code: 'targets.delete', module: 'Metas', description: 'Excluir meta' },
  // Ranking (v1.4)
  { code: 'ranking.view', module: 'Ranking', description: 'Visualizar ranking de vendedores e lojas' },
  // Clientes (v1.5)
  { code: 'customers.view', module: 'Clientes', description: 'Visualizar clientes' },
  { code: 'customers.create', module: 'Clientes', description: 'Cadastrar cliente' },
  { code: 'customers.edit', module: 'Clientes', description: 'Editar cliente' },
  { code: 'customers.delete', module: 'Clientes', description: 'Excluir cliente' },
  // Produtos (v1.7)
  { code: 'products.view', module: 'Produtos', description: 'Visualizar produtos' },
  { code: 'products.create', module: 'Produtos', description: 'Cadastrar produto' },
  { code: 'products.edit', module: 'Produtos', description: 'Editar produto' },
  { code: 'products.delete', module: 'Produtos', description: 'Excluir produto' },
  // Estoque (v1.8)
  { code: 'stock.view', module: 'Estoque', description: 'Visualizar saldos e movimentações' },
  { code: 'stock.move', module: 'Estoque', description: 'Registrar entrada e saída manual' },
  { code: 'stock.adjust', module: 'Estoque', description: 'Ajustar saldo (inventário)' },
  // Fornecedores (v1.9)
  { code: 'suppliers.view', module: 'Fornecedores', description: 'Visualizar fornecedores' },
  { code: 'suppliers.create', module: 'Fornecedores', description: 'Cadastrar fornecedor' },
  { code: 'suppliers.edit', module: 'Fornecedores', description: 'Editar fornecedor' },
  { code: 'suppliers.delete', module: 'Fornecedores', description: 'Excluir fornecedor' },
  // Compras (v1.9)
  { code: 'purchases.view', module: 'Compras', description: 'Visualizar compras' },
  { code: 'purchases.create', module: 'Compras', description: 'Cadastrar compra (rascunho)' },
  { code: 'purchases.edit', module: 'Compras', description: 'Editar compra em rascunho' },
  { code: 'purchases.receive', module: 'Compras', description: 'Receber compra (entrada no estoque)' },
  { code: 'purchases.cancel', module: 'Compras', description: 'Cancelar compra' },
  // Relatórios (v1.9)
  { code: 'reports.view', module: 'Relatórios', description: 'Visualizar relatórios operacionais' },
  // Contas a pagar (v2.0)
  { code: 'payables.view', module: 'Contas a pagar', description: 'Visualizar contas a pagar' },
  { code: 'payables.create', module: 'Contas a pagar', description: 'Lançar título a pagar' },
  { code: 'payables.update', module: 'Contas a pagar', description: 'Editar título em aberto' },
  { code: 'payables.pay', module: 'Contas a pagar', description: 'Pagar título' },
  { code: 'payables.cancel', module: 'Contas a pagar', description: 'Cancelar título em aberto' },
  { code: 'payables.delete', module: 'Contas a pagar', description: 'Excluir título manual em aberto' },
  // Contas a receber (v3.0)
  { code: 'receivables.view', module: 'Contas a receber', description: 'Visualizar contas a receber' },
  { code: 'receivables.create', module: 'Contas a receber', description: 'Lançar título a receber' },
  { code: 'receivables.update', module: 'Contas a receber', description: 'Editar título em aberto' },
  { code: 'receivables.receive', module: 'Contas a receber', description: 'Receber título' },
  { code: 'receivables.cancel', module: 'Contas a receber', description: 'Cancelar título em aberto' },
  { code: 'receivables.delete', module: 'Contas a receber', description: 'Excluir título manual em aberto' },
  // Camada operacional V1 (v3.4). O seed cria as ROLES — em banco novo as
  // migrations 023–026 rodam ANTES das roles existirem, então o grant delas
  // casa 0 linhas; aqui o company_admin passa a nascer com essas permissões.
  // Em bancos EXISTENTES (produção) o grant das migrations é quem aplica.
  // notifications.manage fica de fora: só por concessão explícita.
  { code: 'tasks.view', module: 'Tarefas', description: 'Visualizar tarefas' },
  { code: 'tasks.create', module: 'Tarefas', description: 'Criar tarefa' },
  { code: 'tasks.edit', module: 'Tarefas', description: 'Editar tarefa' },
  { code: 'tasks.delete', module: 'Tarefas', description: 'Excluir tarefa' },
  { code: 'tasks.complete', module: 'Tarefas', description: 'Concluir/reabrir tarefa' },
  { code: 'agenda.view', module: 'Agenda', description: 'Visualizar agenda' },
  { code: 'agenda.create', module: 'Agenda', description: 'Criar compromisso' },
  { code: 'agenda.edit', module: 'Agenda', description: 'Editar compromisso' },
  { code: 'agenda.delete', module: 'Agenda', description: 'Cancelar/excluir compromisso' },
  { code: 'checklists.view', module: 'Checklists', description: 'Visualizar checklists' },
  { code: 'checklists.create', module: 'Checklists', description: 'Criar checklist' },
  { code: 'checklists.edit', module: 'Checklists', description: 'Editar checklist' },
  { code: 'checklists.delete', module: 'Checklists', description: 'Excluir/cancelar checklist' },
  { code: 'checklists.complete', module: 'Checklists', description: 'Executar/concluir itens e checklist' },
  { code: 'notifications.view', module: 'Notificações', description: 'Visualizar notificações' },
];

const ROLE_PERMISSIONS = {
  // Master: autoridade global no backend, independente desta lista
  master: PERMISSIONS.map((p) => p.code),
  company_admin: PERMISSIONS.filter((p) => !p.code.startsWith('platform.')).map((p) => p.code),
  supervisor: ['dashboard.view', 'stores.view', 'users.view', 'company.settings.view',
    'sales.view', 'sales.create', 'sales.edit',
    'targets.view', 'targets.create', 'targets.edit', 'ranking.view',
    'customers.view', 'customers.create', 'customers.edit',
    'products.view', 'products.create', 'products.edit',
    'stock.view', 'stock.move', 'stock.adjust',
    'suppliers.view', 'suppliers.create', 'suppliers.edit',
    'purchases.view', 'purchases.create', 'purchases.edit', 'purchases.receive',
    'reports.view',
    'payables.view', 'payables.create', 'payables.update', 'payables.pay', 'payables.cancel',
    'receivables.view', 'receivables.create', 'receivables.update', 'receivables.receive', 'receivables.cancel'],
  seller: ['dashboard.view', 'sales.view', 'sales.create', 'targets.view', 'ranking.view',
    'customers.view', 'customers.create', 'products.view', 'stock.view'],
};

function seedIfEmpty() {
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount > 0) return false; // banco já inicializado — nunca alterar

  // Produção: instalação inicial exige credenciais configuradas explicitamente.
  // Nenhuma senha padrão conhecida pode ser usada automaticamente em produção.
  if (config.isProd) {
    const missing = [];
    if (!config.seedPasswords.master) missing.push('SEED_MASTER_PASSWORD');
    if (!config.seedPasswords.anjos) missing.push('SEED_ANJOS_PASSWORD');
    if (missing.length) {
      const msg = `[seed] PRODUÇÃO: ${missing.join(' e ')} (obrigatórias para a instalação inicial). ` +
        'Defina-as em server/.env e reinicie. Inicialização abortada — instalação insegura bloqueada.';
      console.error(msg);
      throw new Error(msg);
    }
  }

  const seedAll = db.transaction(() => {
    // ---- Permissões -------------------------------------------------------
    const insPermission = db.prepare(
      'INSERT OR IGNORE INTO permissions (code, module, description) VALUES (?, ?, ?)'
    );
    for (const p of PERMISSIONS) insPermission.run(p.code, p.module, p.description);

    // ---- Funções ----------------------------------------------------------
    const insRole = db.prepare(
      `INSERT INTO roles (company_id, slug, name, description, is_system)
       VALUES (NULL, ?, ?, ?, 1)`
    );
    const roleIds = {};
    roleIds.master = insRole.run(
      'master',
      'Master',
      'Controle global da plataforma — Oficial Link Sistemas'
    ).lastInsertRowid;
    roleIds.company_admin = insRole.run(
      'company_admin',
      'Administrador',
      'Acesso completo dentro da própria empresa'
    ).lastInsertRowid;
    roleIds.supervisor = insRole.run(
      'supervisor',
      'Supervisor',
      'Acompanhamento de equipe e lojas, sem alterações críticas'
    ).lastInsertRowid;
    roleIds.seller = insRole.run(
      'seller',
      'Vendedor',
      'Acesso operacional básico'
    ).lastInsertRowid;

    // ---- Vínculos função ↔ permissão --------------------------------------
    const insRolePerm = db.prepare(
      'INSERT OR IGNORE INTO role_permissions (role_id, permission_code) VALUES (?, ?)'
    );
    for (const [slug, codes] of Object.entries(ROLE_PERMISSIONS)) {
      for (const code of codes) insRolePerm.run(roleIds[slug], code);
    }

    // ---- Master (Oficial Link) --------------------------------------------
    // Senhas iniciais servem APENAS para o primeiro acesso: must_change_password=1
    // obriga a troca antes de liberar qualquer módulo (fluxo já existente).
    const insUser = db.prepare(
      `INSERT INTO users (company_id, store_id, role_id, name, email, password_hash, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    );
    insUser.run(
      null,
      null,
      roleIds.master,
      'Master Oficial Link',
      'master@oficiallink.com.br',
      hashPassword(config.seedPasswords.master)
    );

    // ---- Empresa Anjos -----------------------------------------------------
    const companyId = db
      .prepare(
        `INSERT INTO companies (name, trade_name, document, email, settings)
         VALUES ('Anjos', 'Anjos', NULL, 'contato@anjos.com.br', ?)`
      )
      .run(JSON.stringify({ timezone: 'America/Fortaleza', currency: 'BRL' })).lastInsertRowid;

    // Módulos oficiais ativos para a empresa piloto (dashboard + vendas)
    const insCompanyModule = db.prepare(
      'INSERT OR IGNORE INTO company_modules (company_id, module_slug) VALUES (?, ?)'
    );
    insCompanyModule.run(companyId, 'dashboard');
    insCompanyModule.run(companyId, 'sales');
    insCompanyModule.run(companyId, 'targets');
    insCompanyModule.run(companyId, 'ranking');
    insCompanyModule.run(companyId, 'customers');
    insCompanyModule.run(companyId, 'products');
    insCompanyModule.run(companyId, 'stock');
    insCompanyModule.run(companyId, 'suppliers');
    insCompanyModule.run(companyId, 'purchases');
    insCompanyModule.run(companyId, 'reports');
    insCompanyModule.run(companyId, 'payables');
    insCompanyModule.run(companyId, 'receivables');
    // Homologação (Bloco 3): a empresa piloto já nasce com a camada
    // operacional ativa — onboarding completo sem depender do Master.
    insCompanyModule.run(companyId, 'tasks');
    insCompanyModule.run(companyId, 'agenda');
    insCompanyModule.run(companyId, 'checklists');
    insCompanyModule.run(companyId, 'notifications');

    const insStore = db.prepare(
      `INSERT INTO stores (company_id, name, code, city, state)
       VALUES (?, ?, ?, ?, ?)`
    );
    const storeBalsas = insStore.run(companyId, 'Anjos Balsas', 'BALSAS', 'Balsas', 'MA').lastInsertRowid;
    const storeImperatriz = insStore.run(companyId, 'Anjos Imperatriz', 'IMPERATRIZ', 'Imperatriz', 'MA').lastInsertRowid;

    // ---- Usuários Anjos ----------------------------------------------------
    insUser.run(
      companyId,
      null,
      roleIds.company_admin,
      'Administrador Anjos',
      'admin@anjos.com.br',
      hashPassword(config.seedPasswords.anjos)
    );
    insUser.run(
      companyId,
      null,
      roleIds.supervisor,
      'Supervisor Anjos',
      'supervisor@anjos.com.br',
      hashPassword(config.seedPasswords.anjos)
    );
    insUser.run(
      companyId,
      storeBalsas,
      roleIds.seller,
      'Vendedor Anjos',
      'vendedor@anjos.com.br',
      hashPassword(config.seedPasswords.anjos)
    );

    return { companyId, storeBalsas, storeImperatriz };
  });

  const ids = seedAll();
  console.log('[seed] Banco inicializado com dados de exemplo.');
  console.log('[seed] Empresa: Anjos (id %d) | Lojas: Balsas (id %d), Imperatriz (id %d)',
    ids.companyId, ids.storeBalsas, ids.storeImperatriz);
  console.log('[seed] Acessos iniciais:');
  console.log('         master@oficiallink.com.br  (senha do .env, padrão Master@2026)');
  console.log('         admin@anjos.com.br         (senha do .env, padrão Anjos@2026)');
  console.log('         supervisor@anjos.com.br    (senha do .env, padrão Anjos@2026)');
  console.log('         vendedor@anjos.com.br      (senha do .env, padrão Anjos@2026)');
  return true;
}

if (require.main === module) {
  const created = seedIfEmpty();
  console.log(created ? '[seed] Concluído.' : '[seed] Banco já possui dados — nada a fazer.');
}

module.exports = { seedIfEmpty, PERMISSIONS };
