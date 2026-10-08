-- ============================================================================
-- Migration 022 — Pagamentos e comprovantes SaaS (v3.3)
-- Histórico imutável de pagamentos registrados manualmente pelo Master.
-- Responde: quanto a empresa pagou, quando, por qual método e quem registrou.
-- Comprovante é BLOB validado por magic bytes (PNG/JPEG/PDF) — mesmo
-- princípio do branding (sem confiar no MIME do navegador, sem SVG
-- executável). Acesso somente a plataforma (Master/autorizados).
--
-- Ordem de criação: saas_receipts primeiro (payment_id é UNIQUE sem FK —
-- a integridade 1:1 é garantida pelo UNIQUE + pela transação de registro),
-- depois saas_payments referenciando saas_receipts(id). Evita a referência
-- circular payments↔receipts, que falharia com PRAGMA foreign_keys=ON.
-- ============================================================================

CREATE TABLE IF NOT EXISTS saas_receipts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id  INTEGER NOT NULL UNIQUE,      -- 1:1 com saas_payments (integridade na transação)
  company_id  INTEGER NOT NULL REFERENCES companies(id),
  mime        TEXT NOT NULL,                -- image/png | image/jpeg | application/pdf
  size        INTEGER NOT NULL,
  data        BLOB NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS saas_payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  charge_id     INTEGER NOT NULL REFERENCES saas_charges(id),
  company_id    INTEGER NOT NULL REFERENCES companies(id),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
  paid_on       TEXT NOT NULL,              -- AAAA-MM-DD (data de negócio informada no registro)
  method        TEXT NOT NULL CHECK (method IN ('pix','transferencia','boleto','dinheiro','cartao','outro')),
  notes         TEXT,
  receipt_id    INTEGER REFERENCES saas_receipts(id),
  created_by    INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS ix_saas_payments_company ON saas_payments (company_id);
CREATE INDEX IF NOT EXISTS ix_saas_payments_charge  ON saas_payments (charge_id);
CREATE INDEX IF NOT EXISTS ix_saas_payments_paid_on ON saas_payments (paid_on);
CREATE INDEX IF NOT EXISTS ix_saas_receipts_company ON saas_receipts (company_id);
