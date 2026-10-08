-- ============================================================================
-- Migration 009 — Estoque real + Vendas multi-item (v1.8)
-- - sale_items: itens da venda com SNAPSHOT (nome/sku/unidade/preço) — histórico
--   inviolável; total é calculado pelo backend (centavos, inteiro).
-- - stock_balances: saldo por EMPRESA + LOJA + PRODUTO (único; nunca negativo).
-- - stock_movements: histórico imutável de movimentações (sem DELETE).
-- - Backfill: vendas antigas com product_id viram 1 item (quantidade 1) —
--   amount_cents e demais dados históricos NÃO são alterados.
-- ============================================================================

-- 1. Itens de venda
CREATE TABLE IF NOT EXISTS sale_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id       INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sale_id          INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id       INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name     TEXT    NOT NULL,               -- snapshot
  product_sku      TEXT,                           -- snapshot
  product_unit     TEXT,                           -- snapshot
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents > 0),
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  subtotal_cents   INTEGER NOT NULL CHECK (subtotal_cents > 0),
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS ix_sale_items_company_product ON sale_items(company_id, product_id);

-- 2. Backfill de vendas antigas (legado: product_id único, quantidade 1)
INSERT INTO sale_items (company_id, sale_id, product_id, product_name, product_sku, product_unit, unit_price_cents, quantity, subtotal_cents)
SELECT s.company_id, s.id, s.product_id, s.product_name,
       p.sku, p.unit, s.product_price_cents, 1, s.amount_cents
FROM sales s
LEFT JOIN products p ON p.id = s.product_id
WHERE s.product_id IS NOT NULL;

-- 3. Saldos de estoque (1 linha por empresa+loja+produto; não criamos linhas
--    antecipadamente — nascem na primeira movimentação da combinação)
CREATE TABLE IF NOT EXISTS stock_balances (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  store_id    INTEGER NOT NULL REFERENCES stores(id),
  product_id  INTEGER NOT NULL REFERENCES products(id),
  quantity    INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT,
  UNIQUE (company_id, store_id, product_id)
);
CREATE INDEX IF NOT EXISTS ix_stock_balances_company_store ON stock_balances(company_id, store_id);

-- 4. Movimentações (imutáveis — correções viram novas movimentações de ajuste)
CREATE TABLE IF NOT EXISTS stock_movements (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  store_id       INTEGER NOT NULL REFERENCES stores(id),
  product_id     INTEGER NOT NULL REFERENCES products(id),
  type           TEXT NOT NULL CHECK (type IN ('ENTRY', 'EXIT', 'ADJUST_IN', 'ADJUST_OUT', 'SALE', 'SALE_REVERSAL')),
  quantity       INTEGER NOT NULL CHECK (quantity > 0),  -- sempre positiva; o tipo define a direção
  balance_before INTEGER NOT NULL,
  balance_after  INTEGER NOT NULL,
  reference_type TEXT CHECK (reference_type IN ('sale', 'cancel', 'manual', 'adjust')),
  reference_id   INTEGER,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  note           TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_stock_movements_lookup ON stock_movements(company_id, store_id, product_id, created_at);
CREATE INDEX IF NOT EXISTS ix_stock_movements_company_created ON stock_movements(company_id, created_at);

-- 5. Permissões do módulo Estoque (legados; seed replica para novos)
INSERT OR IGNORE INTO permissions (code, module, description) VALUES
  ('stock.view',   'Estoque', 'Visualizar saldos e movimentações'),
  ('stock.move',   'Estoque', 'Registrar entrada e saída manual'),
  ('stock.adjust', 'Estoque', 'Ajustar saldo (inventário)');

INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT r.id, c.code FROM roles r CROSS JOIN (SELECT 'stock.view' AS code UNION ALL
    SELECT 'stock.move' UNION ALL SELECT 'stock.adjust') c
  WHERE r.slug IN ('company_admin', 'supervisor');
INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT r.id, 'stock.view' FROM roles r WHERE r.slug = 'seller';

-- O módulo 'stock' já está registrado na tabela modules (migration 003).
-- Empresas existentes: opt-in pelo Master (padrão desde a v1.3).
