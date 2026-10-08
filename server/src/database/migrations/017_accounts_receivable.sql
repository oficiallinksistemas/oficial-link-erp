-- ============================================================================
-- Migration 017 — Contas a Receber (v3.0)
-- Título financeiro a receber: originado de venda (referência + unicidade) ou
-- lançamento manual. Valores em CENTAVOS. OVERDUE derivado (open + due_date <
-- hoje empresarial). Recebimento condicional e transacional. Nenhum default
-- empresarial em UTC.
-- ============================================================================

CREATE TABLE IF NOT EXISTS accounts_receivable (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id           INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  store_id             INTEGER REFERENCES stores(id),
  customer_id          INTEGER REFERENCES customers(id),
  sale_id              INTEGER REFERENCES sales(id),
  origin               TEXT    NOT NULL DEFAULT 'manual' CHECK (origin IN ('sale', 'manual')),
  description          TEXT    NOT NULL,
  issue_date           TEXT    NOT NULL,               -- AAAA-MM-DD (data de negócio)
  due_date             TEXT    NOT NULL,               -- AAAA-MM-DD
  amount_cents         INTEGER NOT NULL CHECK (amount_cents > 0),
  status               TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'canceled')),
  received_amount_cents INTEGER CHECK (received_amount_cents IS NULL OR received_amount_cents > 0),
  received_at          TEXT,
  received_by          INTEGER REFERENCES users(id),
  canceled_at          TEXT,
  notes                TEXT,
  created_by           INTEGER NOT NULL REFERENCES users(id),
  updated_by           INTEGER REFERENCES users(id),
  created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT
);

-- Uma venda gera NO MÁXIMO um título (idempotência por constraint, não por if)
CREATE UNIQUE INDEX IF NOT EXISTS ux_accounts_receivable_sale
  ON accounts_receivable(company_id, sale_id) WHERE sale_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_receivables_company_status  ON accounts_receivable(company_id, status);
CREATE INDEX IF NOT EXISTS ix_receivables_company_due     ON accounts_receivable(company_id, due_date);
CREATE INDEX IF NOT EXISTS ix_receivables_company_issue   ON accounts_receivable(company_id, issue_date);
CREATE INDEX IF NOT EXISTS ix_receivables_company_customer ON accounts_receivable(company_id, customer_id);
CREATE INDEX IF NOT EXISTS ix_receivables_company_store   ON accounts_receivable(company_id, store_id);
CREATE INDEX IF NOT EXISTS ix_receivables_received_at     ON accounts_receivable(company_id, received_at);

-- Permissões (bancos legados; seed replica para novos)
INSERT OR IGNORE INTO permissions (code, module, description) VALUES
  ('receivables.view',    'Contas a receber', 'Visualizar contas a receber'),
  ('receivables.create',  'Contas a receber', 'Lançar título a receber'),
  ('receivables.update',  'Contas a receber', 'Editar título em aberto'),
  ('receivables.receive', 'Contas a receber', 'Receber título'),
  ('receivables.cancel',  'Contas a receber', 'Cancelar título em aberto'),
  ('receivables.delete',  'Contas a receber', 'Excluir título manual em aberto');

INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT r.id, c.code FROM roles r CROSS JOIN (SELECT 'receivables.view' AS code UNION ALL
    SELECT 'receivables.create' UNION ALL SELECT 'receivables.update' UNION ALL
    SELECT 'receivables.receive' UNION ALL SELECT 'receivables.cancel') c
  WHERE r.slug IN ('company_admin', 'supervisor');
INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT r.id, 'receivables.delete' FROM roles r WHERE r.slug = 'company_admin';

-- O módulo 'receivables' JÁ está registrado na tabela modules (migration 003).
