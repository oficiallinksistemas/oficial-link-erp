-- ============================================================================
-- Migration 010 — Hardening V1.8 + Fornecedores (v1.9)
-- 1) sales.stock_was_applied: o cancelamento estorna SOMENTE se a venda
--    realmente baixou estoque (decidido NA CRIAÇÃO), independente do estado
--    atual do módulo — nunca estorno fantasma nem estorno ausente.
--    Backfill: vendas que possuem movimento SALE apontando para elas.
-- 2) suppliers: cadastro por empresa (mesmo padrão de customers).
-- ============================================================================

ALTER TABLE sales ADD COLUMN stock_was_applied INTEGER NOT NULL DEFAULT 0;

UPDATE sales SET stock_was_applied = 1
WHERE EXISTS (
  SELECT 1 FROM stock_movements m
  WHERE m.reference_type = 'sale' AND m.reference_id = sales.id
);

CREATE TABLE IF NOT EXISTS suppliers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  document    TEXT,
  phone       TEXT,
  email       TEXT,
  address     TEXT,
  city        TEXT,
  state       TEXT,
  zip         TEXT,
  notes       TEXT,
  status      TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_suppliers_document
  ON suppliers(company_id, document) WHERE document IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_suppliers_company_name ON suppliers(company_id, name);

INSERT OR IGNORE INTO permissions (code, module, description) VALUES
  ('suppliers.view',   'Fornecedores', 'Visualizar fornecedores'),
  ('suppliers.create', 'Fornecedores', 'Cadastrar fornecedor'),
  ('suppliers.edit',   'Fornecedores', 'Editar fornecedor'),
  ('suppliers.delete', 'Fornecedores', 'Excluir fornecedor');

INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT r.id, c.code FROM roles r CROSS JOIN (SELECT 'suppliers.view' AS code UNION ALL
    SELECT 'suppliers.create' UNION ALL SELECT 'suppliers.edit' UNION ALL SELECT 'suppliers.delete') c
  WHERE r.slug IN ('company_admin', 'supervisor');
INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT r.id, 'suppliers.view' FROM roles r WHERE r.slug = 'seller';

-- O módulo 'suppliers' já está registrado na tabela modules (migration 003).
