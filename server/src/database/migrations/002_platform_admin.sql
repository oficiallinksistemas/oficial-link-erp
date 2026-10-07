-- ============================================================================
-- Migration 002 — Master Admin, SaaS e segurança (v1.1)
-- Aplicada uma única vez; compatível com bancos da v1 (sem perda de dados).
-- ============================================================================

-- 1. Troca de senha obrigatória: Master/admin redefine a senha e o usuário
--    precisa trocá-la no próximo acesso.
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;

-- 2. Preparação para SaaS: plano e status de assinatura por empresa
--    (sem lógica de cobrança ainda — arquitetura pronta).
ALTER TABLE companies ADD COLUMN plan TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE companies ADD COLUMN subscription_status TEXT NOT NULL DEFAULT 'active'
  CHECK (subscription_status IN ('active', 'past_due', 'canceled'));

-- 3. Configurações da plataforma (chave/valor — sem dados sensíveis)
CREATE TABLE IF NOT EXISTS platform_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO platform_settings (key, value) VALUES ('maintenance_mode', '0');

-- 4. Novas permissões de plataforma (Master Platform Admin)
INSERT OR IGNORE INTO permissions (code, module, description) VALUES
  ('platform.overview.view',   'Plataforma', 'Visão geral da plataforma'),
  ('platform.stores.view',     'Plataforma', 'Visualizar lojas de qualquer empresa'),
  ('platform.stores.manage',   'Plataforma', 'Gerenciar lojas de qualquer empresa'),
  ('platform.users.view',      'Plataforma', 'Visualizar usuários de qualquer empresa'),
  ('platform.users.manage',    'Plataforma', 'Gerenciar usuários de qualquer empresa'),
  ('platform.audit.view',      'Plataforma', 'Visualizar auditoria da plataforma'),
  ('platform.settings.view',   'Plataforma', 'Visualizar configurações da plataforma'),
  ('platform.settings.manage', 'Plataforma', 'Alterar configurações da plataforma');

-- 5. A função Master passa a ter TODAS as permissões existentes,
--    presentes e futuras registradas nesta migration.
INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT r.id, p.code FROM roles r CROSS JOIN permissions p WHERE r.slug = 'master';
