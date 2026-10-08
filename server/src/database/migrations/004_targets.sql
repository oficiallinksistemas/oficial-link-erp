-- ============================================================================
-- Migration 004 — Módulo Metas (v1.3)
-- Metas por vendedor ou por loja, com período livre e valor em CENTAVOS.
-- Realizado é calculado sobre o módulo Vendas existente (nada é duplicado).
-- ============================================================================

-- Registry: módulo oficial Metas
INSERT OR IGNORE INTO modules (slug, name, description) VALUES
  ('targets', 'Metas', 'Metas comerciais por vendedor ou loja');

CREATE TABLE IF NOT EXISTS targets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type         TEXT    NOT NULL CHECK (type IN ('seller', 'store')),
  user_id      INTEGER REFERENCES users(id),    -- quando type = 'seller'
  store_id     INTEGER REFERENCES stores(id),   -- quando type = 'store'
  start_date   TEXT    NOT NULL,                -- 'YYYY-MM-DD'
  end_date     TEXT    NOT NULL,                -- 'YYYY-MM-DD'
  target_cents INTEGER NOT NULL CHECK (target_cents > 0),
  notes        TEXT,
  created_by   INTEGER NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT,
  CHECK (
    (type = 'seller' AND user_id IS NOT NULL AND store_id IS NULL) OR
    (type = 'store'  AND store_id IS NOT NULL AND user_id IS NULL)
  )
);

-- Sem metas idênticas: mesmo escopo + período exato (409 no backend)
CREATE UNIQUE INDEX IF NOT EXISTS ux_targets_seller_period
  ON targets(company_id, user_id, start_date, end_date) WHERE type = 'seller';
CREATE UNIQUE INDEX IF NOT EXISTS ux_targets_store_period
  ON targets(company_id, store_id, start_date, end_date) WHERE type = 'store';
-- Consultas principais (sempre filtram por company + período)
CREATE INDEX IF NOT EXISTS ix_targets_company_period ON targets(company_id, start_date, end_date);

-- Permissões do módulo Metas (convenção: targets.<ação>)
INSERT OR IGNORE INTO permissions (code, module, description) VALUES
  ('targets.view',   'Metas', 'Visualizar metas e desempenho'),
  ('targets.create', 'Metas', 'Cadastrar meta'),
  ('targets.edit',   'Metas', 'Editar meta'),
  ('targets.delete', 'Metas', 'Excluir meta');

-- Vínculos por função para bancos LEGADOS (Master não precisa — autoridade
-- global do backend; bancos novos recebem os mesmos vínculos via seed.js)
INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT r.id, c.code FROM roles r CROSS JOIN (SELECT 'targets.view' AS code UNION ALL
    SELECT 'targets.create' UNION ALL SELECT 'targets.edit' UNION ALL SELECT 'targets.delete') c
  WHERE r.slug = 'company_admin';
INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT r.id, c.code FROM roles r CROSS JOIN (SELECT 'targets.view' AS code UNION ALL
    SELECT 'targets.create' UNION ALL SELECT 'targets.edit') c
  WHERE r.slug = 'supervisor';
INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT r.id, c.code FROM roles r CROSS JOIN (SELECT 'targets.view' AS code) c
  WHERE r.slug = 'seller';
