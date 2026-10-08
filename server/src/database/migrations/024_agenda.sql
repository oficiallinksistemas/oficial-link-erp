-- ============================================================================
-- Migration 024 — Camada Operacional V1: Agenda (v3.4)
-- start_at/end_at guardam horário LOCAL da empresa ('YYYY-MM-DD HH:MM').
-- Como todos os usuários de um tenant compartilham o mesmo fuso, horários
-- locais são consistentes entre si e tornam a filtragem por dia trivial e
-- correta (fronteira de dia = businessToday, nunca UTC). Instantes de
-- histórico (created_at etc.) continuam UTC, como no restante do ERP.
-- ============================================================================

CREATE TABLE IF NOT EXISTS agenda_events (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id           INTEGER NOT NULL REFERENCES companies(id),
  store_id             INTEGER REFERENCES stores(id),
  title                TEXT NOT NULL,
  description          TEXT,
  start_at             TEXT NOT NULL,        -- 'YYYY-MM-DD HH:MM' horário local da empresa
  end_at               TEXT,                 -- idem; deve ser > start_at quando não all_day
  all_day              INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0,1)),
  responsible_user_id  INTEGER REFERENCES users(id),
  client_id            INTEGER,              -- sem FK: vínculo opcional
  task_id              INTEGER,              -- sem FK: integração agenda↔tarefas opcional
  status               TEXT NOT NULL DEFAULT 'scheduled'
                       CHECK (status IN ('scheduled','completed','canceled')),
  location             TEXT,
  created_by_user_id   INTEGER NOT NULL REFERENCES users(id),
  completed_at         TEXT,
  canceled_at          TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS ix_agenda_company_start ON agenda_events (company_id, start_at);
CREATE INDEX IF NOT EXISTS ix_agenda_company_status ON agenda_events (company_id, status);
CREATE INDEX IF NOT EXISTS ix_agenda_responsible   ON agenda_events (responsible_user_id, status);

INSERT OR IGNORE INTO permissions (code, module, description) VALUES
  ('agenda.view',   'Agenda', 'Visualizar agenda'),
  ('agenda.create', 'Agenda', 'Criar compromisso'),
  ('agenda.edit',   'Agenda', 'Editar compromisso'),
  ('agenda.delete', 'Agenda', 'Cancelar/excluir compromisso');

INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
  SELECT r.id, c.code FROM roles r CROSS JOIN (SELECT 'agenda.view' AS code UNION ALL
    SELECT 'agenda.create' UNION ALL SELECT 'agenda.edit' UNION ALL SELECT 'agenda.delete') c
  WHERE r.slug = 'company_admin' AND r.company_id IS NULL;
