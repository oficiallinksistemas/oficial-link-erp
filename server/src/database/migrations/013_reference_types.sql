-- ============================================================================
-- Migration 013 — Ampliar reference_type de stock_movements (v1.9)
-- SQLite não permite ALTER de CHECK: recriação segura com cópia de dados.
-- ============================================================================

CREATE TABLE IF NOT EXISTS stock_movements_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  store_id       INTEGER NOT NULL REFERENCES stores(id),
  product_id     INTEGER NOT NULL REFERENCES products(id),
  type           TEXT NOT NULL CHECK (type IN ('ENTRY', 'EXIT', 'ADJUST_IN', 'ADJUST_OUT', 'SALE', 'SALE_REVERSAL')),
  quantity       INTEGER NOT NULL CHECK (quantity > 0),
  balance_before INTEGER NOT NULL,
  balance_after  INTEGER NOT NULL,
  reference_type TEXT CHECK (reference_type IN ('sale', 'cancel', 'manual', 'adjust', 'purchase', 'transfer')),
  reference_id   INTEGER,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  note           TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO stock_movements_new
  SELECT id, company_id, store_id, product_id, type, quantity, balance_before, balance_after,
         reference_type, reference_id, user_id, note, created_at
  FROM stock_movements;

DROP TABLE stock_movements;
ALTER TABLE stock_movements_new RENAME TO stock_movements;

CREATE INDEX IF NOT EXISTS ix_stock_movements_lookup ON stock_movements(company_id, store_id, product_id, created_at);
CREATE INDEX IF NOT EXISTS ix_stock_movements_company_created ON stock_movements(company_id, created_at);
