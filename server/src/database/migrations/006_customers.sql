-- ============================================================================
-- Migration 006 — Módulo Clientes completo (v1.5)
-- Expande a estrutura mínima (usada por Sales) para um cadastro completo.
-- NENHUM dado existente é apagado; vendas históricas permanecem intactas.
-- ============================================================================

-- 1. Novos campos do cadastro (reutiliza name/phone/document/created_at/updated_at)
ALTER TABLE customers ADD COLUMN email       TEXT;
ALTER TABLE customers ADD COLUMN address     TEXT;
ALTER TABLE customers ADD COLUMN number      TEXT;
ALTER TABLE customers ADD COLUMN complement  TEXT;
ALTER TABLE customers ADD COLUMN district    TEXT;
ALTER TABLE customers ADD COLUMN city        TEXT;
ALTER TABLE customers ADD COLUMN state       TEXT;
ALTER TABLE customers ADD COLUMN zip         TEXT;
ALTER TABLE customers ADD COLUMN notes       TEXT;
ALTER TABLE customers ADD COLUMN status      TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'inactive'));

-- 2. Índices necessários (sem exageros)
-- CPF/CNPJ único POR EMPRESA (quando informado) — NULLs coexistem livremente
CREATE UNIQUE INDEX IF NOT EXISTS ux_customers_document
  ON customers(company_id, document) WHERE document IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_customers_company_name
  ON customers(company_id, name);

-- 3. Permissões do módulo Clientes (bancos legados; seed replica para novos)
INSERT OR IGNORE INTO permissions (code, module, description) VALUES
  ('customers.view',   'Clientes', 'Visualizar clientes'),
  ('customers.create', 'Clientes', 'Cadastrar cliente'),
  ('customers.edit',   'Clientes', 'Editar cliente'),
  ('customers.delete', 'Clientes', 'Excluir cliente');

INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT r.id, c.code FROM roles r CROSS JOIN (SELECT 'customers.view' AS code UNION ALL
    SELECT 'customers.create' UNION ALL SELECT 'customers.edit' UNION ALL SELECT 'customers.delete') c
  WHERE r.slug = 'company_admin';
INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT r.id, c.code FROM roles r CROSS JOIN (SELECT 'customers.view' AS code UNION ALL
    SELECT 'customers.create' UNION ALL SELECT 'customers.edit') c
  WHERE r.slug = 'supervisor';
INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT r.id, c.code FROM roles r CROSS JOIN (SELECT 'customers.view' AS code UNION ALL
    SELECT 'customers.create') c
  WHERE r.slug = 'seller';

-- O módulo 'customers' já está registrado na tabela modules (migration 003).
-- Empresas existentes: opt-in pelo Master em Plataforma > Empresas (padrão
-- desde a v1.3). Após ativar, o cadastro completo fica disponível sem perda
-- de nenhum dado — inclusive os clientes já usados em vendas.
