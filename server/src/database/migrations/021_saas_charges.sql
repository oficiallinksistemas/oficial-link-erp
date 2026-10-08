-- ============================================================================
-- Migration 021 — Cobranças SaaS da plataforma (v3.3)
-- Cobrança que a OFICIAL LINK faz da empresa cliente. Contexto diferente de
-- accounts_payable/accounts_receivable (que são financeiro do tenant) —
-- por isso tabela própria. Nunca apagar cobrança paga: histórico permanece.
-- OVERDUE é classificado pela data de negócio de cada empresa
-- (core/businessDate) e persistido por refresh em tempo de leitura.
-- ============================================================================

CREATE TABLE IF NOT EXISTS saas_charges (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id      INTEGER NOT NULL REFERENCES companies(id),
  type            TEXT NOT NULL CHECK (type IN ('implementation','monthly','custom')),
  reference       TEXT,                     -- competência/descrição curta (ex.: '2026-10', 'Implantação')
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  due_date        TEXT NOT NULL,            -- AAAA-MM-DD (data de negócio)
  status          TEXT NOT NULL DEFAULT 'OPEN'
                  CHECK (status IN ('OPEN','OVERDUE','PAID','CANCELED')),
  paid_at         TEXT,                     -- datetime completo do pagamento
  paid_on         TEXT,                     -- AAAA-MM-DD (data de negócio, para agregação mensal)
  payment_method  TEXT CHECK (payment_method IS NULL OR payment_method IN
                  ('pix','transferencia','boleto','dinheiro','cartao','outro')),
  payment_notes   TEXT,
  canceled_at     TEXT,
  canceled_by     INTEGER REFERENCES users(id),
  cancel_notes    TEXT,
  created_by      INTEGER NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS ix_saas_charges_company_status ON saas_charges (company_id, status);
CREATE INDEX IF NOT EXISTS ix_saas_charges_status_due    ON saas_charges (status, due_date);
CREATE INDEX IF NOT EXISTS ix_saas_charges_company_due   ON saas_charges (company_id, due_date);
-- Pagamentos mensais agregados por competência de pagamento (dashboard).
CREATE INDEX IF NOT EXISTS ix_saas_charges_paid_on       ON saas_charges (paid_on) WHERE paid_on IS NOT NULL;
