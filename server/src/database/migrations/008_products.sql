-- ============================================================================
-- Migration 008 — Módulo Produtos completo + fundação para Estoque (v1.7)
-- Padrão: catálogo pertence à EMPRESA (não à loja); disponibilidade por loja
-- será responsabilidade do futuro módulo Estoque. Nenhum dado existente é
-- alterado ou apagado; vendas históricas preservadas (snapshot no momento da
-- venda, jamais recalculado pelo preço atual do produto).
-- ============================================================================

-- 1. Categorias (entidade interna do módulo Produtos — sem módulo separado)
CREATE TABLE IF NOT EXISTS product_categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT,
  UNIQUE (company_id, name)
);
CREATE INDEX IF NOT EXISTS ix_product_categories_company ON product_categories(company_id, status);

-- 2. Produtos (preço/custo em CENTAVOS — mesmo padrão de Sales; unidade com
--    domínio fechado; estoque mínimo como dado cadastral para o futuro
--    módulo Estoque — NENHUM "estoque atual" é inventado nesta versão)
CREATE TABLE IF NOT EXISTS products (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  category_id    INTEGER REFERENCES product_categories(id) ON DELETE SET NULL,
  name           TEXT    NOT NULL,
  description    TEXT,
  sku            TEXT,
  barcode        TEXT,
  unit           TEXT    NOT NULL DEFAULT 'UN',
  price_cents    INTEGER NOT NULL CHECK (price_cents > 0),
  cost_cents     INTEGER CHECK (cost_cents IS NULL OR cost_cents > 0),
  minimum_stock  INTEGER CHECK (minimum_stock IS NULL OR minimum_stock >= 0),
  status         TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT
);

-- SKU e código de barras únicos POR EMPRESA quando preenchidos
CREATE UNIQUE INDEX IF NOT EXISTS ux_products_sku
  ON products(company_id, sku) WHERE sku IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_products_barcode
  ON products(company_id, barcode) WHERE barcode IS NOT NULL;
-- Listagem/busca/filtros
CREATE INDEX IF NOT EXISTS ix_products_company_name ON products(company_id, name);
CREATE INDEX IF NOT EXISTS ix_products_company_category ON products(company_id, category_id);

-- 3. Integração mínima e segura com Sales (OPCIONAL — venda sem produto segue
--    permitida; nome/preço são SNAPSHOT no momento da venda: venda histórica
--    NUNCA muda quando o produto é renomeado/reprecificado/desativado)
ALTER TABLE sales ADD COLUMN product_id INTEGER REFERENCES products(id) ON DELETE SET NULL;
ALTER TABLE sales ADD COLUMN product_name TEXT;
ALTER TABLE sales ADD COLUMN product_price_cents INTEGER;
CREATE INDEX IF NOT EXISTS ix_sales_company_product ON sales(company_id, product_id);

-- 4. Permissões do módulo Produtos (bancos legados; seed replica para novos)
INSERT OR IGNORE INTO permissions (code, module, description) VALUES
  ('products.view',   'Produtos', 'Visualizar produtos'),
  ('products.create', 'Produtos', 'Cadastrar produto'),
  ('products.edit',   'Produtos', 'Editar produto'),
  ('products.delete', 'Produtos', 'Excluir produto');

INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT r.id, c.code FROM roles r CROSS JOIN (SELECT 'products.view' AS code UNION ALL
    SELECT 'products.create' UNION ALL SELECT 'products.edit' UNION ALL SELECT 'products.delete') c
  WHERE r.slug = 'company_admin';
INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT r.id, c.code FROM roles r CROSS JOIN (SELECT 'products.view' AS code UNION ALL
    SELECT 'products.create' UNION ALL SELECT 'products.edit') c
  WHERE r.slug = 'supervisor';
INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT r.id, 'products.view' FROM roles r WHERE r.slug = 'seller';

-- O módulo 'products' já está registrado na tabela modules (migration 003).
-- Empresas existentes: opt-in pelo Master (padrão desde a v1.3).
