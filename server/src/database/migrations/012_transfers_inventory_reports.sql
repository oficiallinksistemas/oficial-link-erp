-- ============================================================================
-- Migration 012 — Transferências entre lojas + Inventário + Reports (v1.9)
-- Transferência: saída na origem + entrada no destino (reference_type
-- 'transfer') na MESMA transação. Inventário: contagem física → ajustes
-- (ADJUST_IN/OUT) na finalização. Reports: registro do módulo + permissão.
-- ============================================================================

-- 1. Transferências (entidades do módulo Estoque — sem módulo separado)
CREATE TABLE IF NOT EXISTS stock_transfers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  from_store_id INTEGER NOT NULL REFERENCES stores(id),
  to_store_id   INTEGER NOT NULL REFERENCES stores(id),
  status        TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'canceled')),
  note          TEXT,
  created_by    INTEGER NOT NULL REFERENCES users(id),
  completed_at  TEXT,
  completed_by  INTEGER REFERENCES users(id),
  canceled_at   TEXT,
  cancel_reason TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS ix_stock_transfers_company ON stock_transfers(company_id, created_at);

CREATE TABLE IF NOT EXISTS stock_transfer_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  transfer_id   INTEGER NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  product_id    INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name  TEXT    NOT NULL,
  product_sku   TEXT,
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_stock_transfer_items_transfer ON stock_transfer_items(transfer_id);

-- 2. Inventário (contagem física por loja)
CREATE TABLE IF NOT EXISTS inventory_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  store_id     INTEGER NOT NULL REFERENCES stores(id),
  status       TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'canceled')),
  started_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  completed_by INTEGER REFERENCES users(id),
  created_by   INTEGER NOT NULL REFERENCES users(id),
  note         TEXT
);
CREATE INDEX IF NOT EXISTS ix_inventory_sessions_company ON inventory_sessions(company_id, store_id);

CREATE TABLE IF NOT EXISTS inventory_items (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id         INTEGER NOT NULL REFERENCES inventory_sessions(id) ON DELETE CASCADE,
  company_id         INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id         INTEGER NOT NULL REFERENCES products(id),
  system_quantity    INTEGER NOT NULL,
  counted_quantity   INTEGER,
  difference         INTEGER,
  adjustment_applied INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (session_id, product_id)
);
CREATE INDEX IF NOT EXISTS ix_inventory_items_session ON inventory_items(session_id);

-- 3. Reports — registro do módulo (não existia) + permissão
INSERT OR IGNORE INTO modules (slug, name, description) VALUES
  ('reports', 'Relatórios', 'Relatórios operacionais do ERP');

INSERT OR IGNORE INTO permissions (code, module, description) VALUES
  ('reports.view', 'Relatórios', 'Visualizar relatórios operacionais');

INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT r.id, 'reports.view' FROM roles r WHERE r.slug IN ('company_admin', 'supervisor');

-- Permissões de transferência/inventário ficam no módulo Estoque (stock.*)
