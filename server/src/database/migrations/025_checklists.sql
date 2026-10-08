-- ============================================================================
-- Migration 025 — Camada Operacional V1: Checklists (v3.4)
-- Execuções são LINHAS (não JSON): cada execução tem seus próprios itens,
-- nunca compartilhados com outras execuções nem com futuros modelos —
-- alterar um modelo/item depois NÃO modifica execuções antigas (histórico).
-- template_name guarda a origem para a evolução futura de modelos.
-- ============================================================================

CREATE TABLE IF NOT EXISTS checklists (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id           INTEGER NOT NULL REFERENCES companies(id),
  store_id             INTEGER REFERENCES stores(id),
  title                TEXT NOT NULL,
  description          TEXT,
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','in_progress','completed','canceled')),
  assigned_to_user_id  INTEGER REFERENCES users(id),
  due_date             TEXT,                 -- AAAA-MM-DD (data de negócio)
  template_name        TEXT,                 -- origem (modelo); evolução futura
  completed_at         TEXT,
  completed_by_user_id INTEGER REFERENCES users(id),
  canceled_at          TEXT,
  canceled_by_user_id  INTEGER,
  created_by_user_id   INTEGER NOT NULL REFERENCES users(id),
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS checklist_items (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  checklist_id         INTEGER NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
  title                TEXT NOT NULL,
  description          TEXT,
  position             INTEGER NOT NULL DEFAULT 0,
  required             INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0,1)),
  completed            INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0,1)),
  completed_at         TEXT,
  completed_by_user_id INTEGER REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS ix_checklists_company_status ON checklists (company_id, status);
CREATE INDEX IF NOT EXISTS ix_checklists_assignee      ON checklists (assigned_to_user_id, status);
CREATE INDEX IF NOT EXISTS ix_checklist_items_order    ON checklist_items (checklist_id, position);
CREATE INDEX IF NOT EXISTS ix_checklist_items_open     ON checklist_items (checklist_id, completed);

INSERT OR IGNORE INTO permissions (code, module, description) VALUES
  ('checklists.view',     'Checklists', 'Visualizar checklists'),
  ('checklists.create',   'Checklists', 'Criar checklist'),
  ('checklists.edit',     'Checklists', 'Editar checklist'),
  ('checklists.delete',   'Checklists', 'Excluir/cancelar checklist'),
  ('checklists.complete', 'Checklists', 'Executar/concluir itens e checklist');

INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT r.id, c.code FROM roles r CROSS JOIN (SELECT 'checklists.view' AS code UNION ALL
    SELECT 'checklists.create' UNION ALL SELECT 'checklists.edit' UNION ALL
    SELECT 'checklists.delete' UNION ALL SELECT 'checklists.complete') c
  WHERE r.slug = 'company_admin' AND r.company_id IS NULL;
