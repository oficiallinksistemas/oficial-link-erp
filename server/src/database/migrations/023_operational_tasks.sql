-- ============================================================================
-- Migration 023 — Camada Operacional V1: registry + Tarefas (v3.4)
-- Vínculos com clientes/vendas/compras/financeiro são OPCIONAIS e SEM FK
-- (integração opcional por design): a tarefa sobrevive à desativação de
-- qualquer módulo relacionado e à exclusão do registro de origem. O snapshot
-- link_label preserva o contexto histórico.
-- ============================================================================

INSERT OR IGNORE INTO modules (slug, name, description) VALUES
  ('tasks',         'Tarefas',      'Gestão de tarefas e atividades da equipe'),
  ('agenda',        'Agenda',       'Compromissos, reuniões e visitas'),
  ('checklists',    'Checklists',   'Checklists e rotinas operacionais'),
  ('notifications', 'Notificações', 'Central interna de notificações');

CREATE TABLE IF NOT EXISTS tasks (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id           INTEGER NOT NULL REFERENCES companies(id),
  store_id             INTEGER REFERENCES stores(id),
  title                TEXT NOT NULL,
  description          TEXT,
  assigned_to_user_id  INTEGER REFERENCES users(id),
  created_by_user_id   INTEGER NOT NULL REFERENCES users(id),
  client_id            INTEGER,              -- sem FK: vínculo opcional
  sale_id              INTEGER,              -- sem FK: vínculo opcional
  purchase_id          INTEGER,              -- sem FK: vínculo opcional
  payable_id           INTEGER,              -- sem FK: vínculo opcional
  receivable_id        INTEGER,              -- sem FK: vínculo opcional
  link_label           TEXT,                 -- snapshot mínimo p/ histórico
  priority             TEXT NOT NULL DEFAULT 'medium'
                       CHECK (priority IN ('low','medium','high','urgent')),
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','in_progress','completed','canceled')),
  due_date             TEXT,                 -- AAAA-MM-DD (data de negócio)
  completed_at         TEXT,
  completed_by_user_id INTEGER REFERENCES users(id),
  canceled_at          TEXT,
  canceled_by_user_id  INTEGER,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS ix_tasks_company_status  ON tasks (company_id, status);
CREATE INDEX IF NOT EXISTS ix_tasks_company_due     ON tasks (company_id, due_date);
CREATE INDEX IF NOT EXISTS ix_tasks_assignee_status ON tasks (assigned_to_user_id, status);
CREATE INDEX IF NOT EXISTS ix_tasks_company_store   ON tasks (company_id, store_id);

-- Permissões (catálogo). company_admin recebe na V1; supervisor/seller NÃO
-- recebem automaticamente (podem ser concedidas via gestão de funções).
INSERT OR IGNORE INTO permissions (code, module, description) VALUES
  ('tasks.view',      'Tarefas', 'Visualizar tarefas'),
  ('tasks.create',    'Tarefas', 'Criar tarefa'),
  ('tasks.edit',      'Tarefas', 'Editar tarefa'),
  ('tasks.delete',    'Tarefas', 'Excluir tarefa'),
  ('tasks.complete',  'Tarefas', 'Concluir/reabrir tarefa');

INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT r.id, c.code FROM roles r CROSS JOIN (SELECT 'tasks.view' AS code UNION ALL
    SELECT 'tasks.create' UNION ALL SELECT 'tasks.edit' UNION ALL
    SELECT 'tasks.delete' UNION ALL SELECT 'tasks.complete') c
  WHERE r.slug = 'company_admin' AND r.company_id IS NULL;
