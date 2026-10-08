-- ============================================================================
-- Migration 003 — Arquitetura modular + Módulo Vendas (v1.2)
-- Aplicada uma única vez; compatível com bancos existentes (sem perda de
-- dados). Desativar um módulo NUNCA apaga tabelas/dados — só impede o uso.
-- ============================================================================

-- 1. Registro oficial de módulos da plataforma
CREATE TABLE IF NOT EXISTS modules (
  slug        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  is_official INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO modules (slug, name, description) VALUES
  ('dashboard',     'Dashboard',        'Painel inicial do ERP'),
  ('sales',         'Vendas',           'Registro e gestão de vendas'),
  ('customers',     'Clientes',         'Cadastro de clientes (estrutura preparada)'),
  ('products',      'Produtos',         'Catálogo de produtos (preparado)'),
  ('stock',         'Estoque',          'Controle de estoque (preparado)'),
  ('goals',         'Metas',            'Metas individuais, de loja e equipe (preparado)'),
  ('ranking',       'Ranking',          'Ranking de vendedores (preparado)'),
  ('commissions',   'Comissões',        'Cálculo de comissões (preparado)'),
  ('requests',      'Solicitações',     'Solicitações internas (preparado)'),
  ('tasks',         'Tarefas',          'Tarefas e pendências (preparado)'),
  ('payables',      'Contas a pagar',   '(preparado)'),
  ('receivables',   'Contas a receber', '(preparado)'),
  ('suppliers',     'Fornecedores',     '(preparado)'),
  ('documents',     'Documentos',       '(preparado)'),
  ('reports',       'Relatórios',       '(preparado)'),
  ('notifications', 'Notificações',     '(preparado)');

-- 2. Módulos ativos por empresa (tenant)
CREATE TABLE IF NOT EXISTS company_modules (
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  module_slug TEXT NOT NULL REFERENCES modules(slug) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  settings    TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT,
  PRIMARY KEY (company_id, module_slug)
);
CREATE INDEX IF NOT EXISTS ix_company_modules_company ON company_modules(company_id);

-- 3. Ativa módulos essenciais para empresas EXISTENTES (bancos legados):
--    preserva o comportamento atual (dashboard) e libera Vendas para a Anjos.
INSERT OR IGNORE INTO company_modules (company_id, module_slug)
  SELECT id, 'dashboard' FROM companies;
INSERT OR IGNORE INTO company_modules (company_id, module_slug)
  SELECT id, 'sales' FROM companies;

-- 4. Permissões do módulo Vendas (convenção: sales.<ação>)
INSERT OR IGNORE INTO permissions (code, module, description) VALUES
  ('sales.view',   'Vendas', 'Visualizar vendas'),
  ('sales.create', 'Vendas', 'Registrar venda'),
  ('sales.edit',   'Vendas', 'Editar venda'),
  ('sales.cancel', 'Vendas', 'Cancelar venda');

-- Vínculos por função (Master não precisa — autoridade global do backend)
INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT r.id, c.code FROM roles r CROSS JOIN (SELECT 'sales.view' AS code UNION ALL
    SELECT 'sales.create' UNION ALL SELECT 'sales.edit' UNION ALL SELECT 'sales.cancel') c
  WHERE r.slug = 'company_admin';
INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT r.id, c.code FROM roles r CROSS JOIN (SELECT 'sales.view' AS code UNION ALL
    SELECT 'sales.create' UNION ALL SELECT 'sales.edit') c
  WHERE r.slug = 'supervisor';
INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT r.id, c.code FROM roles r CROSS JOIN (SELECT 'sales.view' AS code UNION ALL
    SELECT 'sales.create') c
  WHERE r.slug = 'seller';

-- 5. Clientes (estrutura mínima preparada para o futuro módulo Clientes)
CREATE TABLE IF NOT EXISTS customers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  phone       TEXT,
  document    TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT
);
CREATE INDEX IF NOT EXISTS ix_customers_company ON customers(company_id, name);

-- 6. Vendas (valores em CENTAVOS — inteiro, sem ponto flutuante)
CREATE TABLE IF NOT EXISTS sales (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  store_id      INTEGER NOT NULL REFERENCES stores(id),
  seller_id     INTEGER NOT NULL REFERENCES users(id),
  customer_id   INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  customer_name TEXT    NOT NULL,              -- snapshot (venda preserva o nome)
  amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
  sold_at       TEXT    NOT NULL,              -- 'YYYY-MM-DD HH:MM' (fuso da empresa)
  note          TEXT,
  status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'canceled')),
  created_by    INTEGER NOT NULL REFERENCES users(id),
  canceled_at   TEXT,
  canceled_by   INTEGER REFERENCES users(id),
  cancel_reason TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT
);
-- Índices compostos pelo tenant — todas as consultas filtram por company_id
CREATE INDEX IF NOT EXISTS ix_sales_company_date    ON sales(company_id, sold_at);
CREATE INDEX IF NOT EXISTS ix_sales_company_store   ON sales(company_id, store_id, sold_at);
CREATE INDEX IF NOT EXISTS ix_sales_company_seller  ON sales(company_id, seller_id, sold_at);
CREATE INDEX IF NOT EXISTS ix_sales_company_status  ON sales(company_id, status, sold_at);
