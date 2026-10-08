-- ============================================================================
-- Migration 026 — Camada Operacional V1: Notificações (v3.4)
-- Central interna com DEDUPLICAÇÃO obrigatória: a chave única
-- (company_id, user_id, dedupe_key) garante que um mesmo evento nunca
-- gere notificações repetidas (ex.: tarefa atrasada há 10 dias não gera
-- notificação nova a cada leitura). INSERT OR IGNORE torna a geração
-- idempotente. Notificações são INFRAESTRUTURA: geradores em outros
-- módulos verificam a ativação do módulo antes de inserir — uma operação
-- nunca quebra porque Notifications está desligado.
-- ============================================================================

CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL REFERENCES companies(id),
  user_id     INTEGER NOT NULL REFERENCES users(id),
  type        TEXT NOT NULL CHECK (type IN
              ('task_assigned','task_due','task_overdue',
               'agenda_created','agenda_reminder',
               'checklist_assigned','checklist_due','checklist_overdue',
               'financial_overdue','target_reached','system')),
  title       TEXT NOT NULL,
  message     TEXT,
  priority    TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  entity_type TEXT,
  entity_id   INTEGER,
  action_url  TEXT,
  dedupe_key  TEXT NOT NULL,
  read_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Anti-spam: um mesmo evento por usuário, uma única vez.
CREATE UNIQUE INDEX IF NOT EXISTS ux_notifications_dedupe
  ON notifications (company_id, user_id, dedupe_key);
CREATE INDEX IF NOT EXISTS ix_notifications_user_unread ON notifications (user_id, read_at);
CREATE INDEX IF NOT EXISTS ix_notifications_user_recent ON notifications (user_id, id DESC);
CREATE INDEX IF NOT EXISTS ix_notifications_company      ON notifications (company_id);

INSERT OR IGNORE INTO permissions (code, module, description) VALUES
  ('notifications.view',   'Notificações', 'Visualizar notificações'),
  ('notifications.manage', 'Notificações', 'Gerenciar notificações da empresa');

-- Admin vê suas notificações; 'manage' (broadcast/administração) fica só
-- para quem for concedida explicitamente — não vai no grant padrão.
INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT r.id, 'notifications.view' FROM roles r
  WHERE r.slug = 'company_admin' AND r.company_id IS NULL;
