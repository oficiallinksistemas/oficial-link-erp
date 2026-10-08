-- ============================================================================
-- Migration 020 — Configuração comercial SaaS por empresa (v3.3)
-- PLANO ≠ MÓDULO ≠ PERMISSÃO ≠ STATUS DA EMPRESA ≠ STATUS DA ASSINATURA.
-- Esta tabela guarda APENAS os dados comerciais da cobrança que a Oficial
-- Link faz do tenant. companies.plan/subscription_status (migration 002)
-- continuam sendo as fontes do plano e do status da assinatura — aqui não
-- se mistura nada disso com RBAC ou company_modules.
-- Valores monetários SEMPRE em centavos inteiros (INTEGER, sem float).
-- ============================================================================

CREATE TABLE IF NOT EXISTS saas_billing_config (
  company_id              INTEGER PRIMARY KEY REFERENCES companies(id),
  implementation_fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (implementation_fee_cents >= 0),
  monthly_fee_cents       INTEGER NOT NULL DEFAULT 0 CHECK (monthly_fee_cents >= 0),
  billing_due_day         INTEGER NOT NULL DEFAULT 10 CHECK (billing_due_day BETWEEN 1 AND 28),
  payment_method          TEXT NOT NULL DEFAULT 'pix'
                          CHECK (payment_method IN ('pix','transferencia','boleto','dinheiro','cartao','outro')),
  billing_notes           TEXT,
  next_due_date           TEXT,             -- AAAA-MM-DD da próxima cobrança prevista (informacional)
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Dia de vencimento usado em filtros ("vencendo em breve") do dashboard.
CREATE INDEX IF NOT EXISTS ix_saas_config_due_day ON saas_billing_config (billing_due_day);

-- Permissões da camada comercial da plataforma. Master tem autoridade global
-- (não depende de role_permissions); as permissões existem para futuros
-- operadores da plataforma que NÃO sejam Master. Usuários tenant jamais as
-- recebem — são permissões de plataforma, não de negócio.
INSERT OR IGNORE INTO permissions (code, module, description) VALUES
  ('platform.billing.view',   'Plataforma', 'Visualizar cobranças SaaS das empresas'),
  ('platform.billing.manage', 'Plataforma', 'Gerenciar cobranças SaaS das empresas');
