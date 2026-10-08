-- ============================================================================
-- Migration 011 — Compras (v1.9): FORNECEDOR → COMPRA → ITENS → ESTOQUE.
-- Compra recebida gera ENTRY por item (reference_type='purchase'), tudo na
-- mesma transação. Snapshot de custo/nome/sku/unidade — histórico inviolável.
-- Registra o módulo 'purchases' no registry (não existia na migration 003).
-- ============================================================================

INSERT OR IGNORE INTO modules (slug, name, description) VALUES
  ('purchases', 'Compras', 'Entrada de mercadoria com fornecedor');

CREATE TABLE IF NOT EXISTS purchases (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  store_id      INTEGER NOT NULL REFERENCES stores(id),
  supplier_id   INTEGER NOT NULL REFERENCES suppliers(id),
  status        TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'received', 'canceled')),
  purchase_date TEXT    NOT NULL,
  total_cents   INTEGER NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  note          TEXT,
  created_by    INTEGER NOT NULL REFERENCES users(id),
  received_at   TEXT,
  received_by   INTEGER REFERENCES users(id),
  canceled_at   TEXT,
  cancel_reason TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS ix_purchases_company_date ON purchases(company_id, purchase_date);
CREATE INDEX IF NOT EXISTS ix_purchases_company_store ON purchases(company_id, store_id, purchase_date);

CREATE TABLE IF NOT EXISTS purchase_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id       INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  purchase_id      INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  product_id       INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name     TEXT    NOT NULL,
  product_sku      TEXT,
  product_unit     TEXT,
  unit_cost_cents  INTEGER NOT NULL CHECK (unit_cost_cents > 0),
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  subtotal_cents   INTEGER NOT NULL CHECK (subtotal_cents > 0),
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_purchase_items_purchase ON purchase_items(purchase_id);
CREATE INDEX IF NOT EXISTS ix_purchase_items_company_product ON purchase_items(company_id, product_id);

INSERT OR IGNORE INTO permissions (code, module, description) VALUES
  ('purchases.view',    'Compras', 'Visualizar compras'),
  ('purchases.create',  'Compras', 'Cadastrar compra (rascunho)'),
  ('purchases.edit',    'Compras', 'Editar compra em rascunho'),
  ('purchases.receive', 'Compras', 'Receber compra (entrada no estoque)'),
  ('purchases.cancel',  'Compras', 'Cancelar compra');

INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT r.id, c.code FROM roles r CROSS JOIN (SELECT 'purchases.view' AS code UNION ALL
    SELECT 'purchases.create' UNION ALL SELECT 'purchases.edit' UNION ALL
    SELECT 'purchases.receive' UNION ALL SELECT 'purchases.cancel') c
  WHERE r.slug = 'company_admin';
INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT r.id, c.code FROM roles r CROSS JOIN (SELECT 'purchases.view' AS code UNION ALL
    SELECT 'purchases.create' UNION ALL SELECT 'purchases.edit' UNION ALL SELECT 'purchases.receive') c
  WHERE r.slug = 'supervisor';
