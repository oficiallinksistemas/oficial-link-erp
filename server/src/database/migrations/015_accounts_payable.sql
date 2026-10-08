-- ============================================================================
-- Migration 015 — Contas a Pagar (v2.0)
-- Título financeiro a pagar: originado de compra (referência + unicidade) ou
-- lançamento manual. Valores em CENTAVOS. OVERDUE é DERIVADO
-- (status='open' AND due_date < hoje) — nunca persistido, sem inconsistência.
-- Pagamento é condicional e transacional (sem duplicidade sob concorrência).
-- ============================================================================

CREATE TABLE IF NOT EXISTS accounts_payable (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id       INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  store_id         INTEGER REFERENCES stores(id),
  supplier_id      INTEGER REFERENCES suppliers(id),
  purchase_id      INTEGER REFERENCES purchases(id),
  origin_type      TEXT    NOT NULL DEFAULT 'manual' CHECK (origin_type IN ('purchase', 'manual')),
  description      TEXT    NOT NULL,
  document_number  TEXT,
  reference        TEXT,
  amount_cents     INTEGER NOT NULL CHECK (amount_cents > 0),
  issue_date       TEXT    NOT NULL,               -- AAAA-MM-DD
  due_date         TEXT    NOT NULL,               -- AAAA-MM-DD (data de negócio)
  status           TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'canceled')),
  paid_at          TEXT,
  paid_amount_cents INTEGER CHECK (paid_amount_cents IS NULL OR paid_amount_cents > 0),
  paid_by          INTEGER REFERENCES users(id),
  notes            TEXT,
  created_by       INTEGER NOT NULL REFERENCES users(id),
  updated_by       INTEGER REFERENCES users(id),
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT
);

-- Uma compra gera NO MÁXIMO um título (idempotência por constraint)
CREATE UNIQUE INDEX IF NOT EXISTS ux_accounts_payable_purchase
  ON accounts_payable(company_id, purchase_id) WHERE purchase_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_payables_company_status ON accounts_payable(company_id, status);
CREATE INDEX IF NOT EXISTS ix_payables_company_due    ON accounts_payable(company_id, due_date);
CREATE INDEX IF NOT EXISTS ix_payables_company_supplier ON accounts_payable(company_id, supplier_id);
CREATE INDEX IF NOT EXISTS ix_payables_company_store  ON accounts_payable(company_id, store_id);
CREATE INDEX IF NOT EXISTS ix_payables_company_purchase ON accounts_payable(company_id, purchase_id);

-- Permissões (bancos legados; seed replica para novos)
INSERT OR IGNORE INTO permissions (code, module, description) VALUES
  ('payables.view',   'Contas a pagar', 'Visualizar contas a pagar'),
  ('payables.create', 'Contas a pagar', 'Lançar título a pagar'),
  ('payables.update', 'Contas a pagar', 'Editar título em aberto'),
  ('payables.pay',    'Contas a pagar', 'Pagar título'),
  ('payables.cancel', 'Contas a pagar', 'Cancelar título em aberto');

INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT r.id, c.code FROM roles r CROSS JOIN (SELECT 'payables.view' AS code UNION ALL
    SELECT 'payables.create' UNION ALL SELECT 'payables.update' UNION ALL
    SELECT 'payables.pay' UNION ALL SELECT 'payables.cancel') c
  WHERE r.slug IN ('company_admin', 'supervisor');

-- O módulo 'payables' JÁ está registrado na tabela modules (migration 003).
