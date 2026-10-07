-- ============================================================================
-- Migration 001 — schema inicial (v1)
-- Multi-tenant: todo dado operacional carrega company_id e é isolado por ele.
-- ============================================================================

-- EMPRESAS (tenants). O Master da Oficial Link NÃO é empresa: usuários
-- master possuem company_id NULL e acesso apenas aos módulos de plataforma.
CREATE TABLE IF NOT EXISTS companies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  trade_name  TEXT,
  document    TEXT,                       -- CNPJ (sem validação fiscal no MVP)
  email       TEXT,
  phone       TEXT,
  status      TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  settings    TEXT    NOT NULL DEFAULT '{}',  -- configurações próprias (JSON)
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_companies_document ON companies(document) WHERE document IS NOT NULL;

-- LOJAS (unidades de uma empresa)
CREATE TABLE IF NOT EXISTS stores (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  code        TEXT    NOT NULL,           -- código interno, único por empresa
  city        TEXT,
  state       TEXT,                       -- UF
  status      TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT,
  UNIQUE (company_id, code)
);
CREATE INDEX IF NOT EXISTS ix_stores_company ON stores(company_id);

-- FUNÇÕES (roles). company_id NULL = função global do sistema.
CREATE TABLE IF NOT EXISTS roles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER REFERENCES companies(id) ON DELETE CASCADE,  -- NULL = global
  slug        TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  description TEXT,
  is_system   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- PERMISSÕES e vínculo função ↔ permissão
CREATE TABLE IF NOT EXISTS permissions (
  code        TEXT PRIMARY KEY,
  module      TEXT NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id          INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code  TEXT    NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);

-- USUÁRIOS. Master tem company_id NULL.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id    INTEGER REFERENCES companies(id) ON DELETE CASCADE,  -- NULL = Master
  store_id      INTEGER REFERENCES stores(id) ON DELETE SET NULL,
  role_id       INTEGER NOT NULL REFERENCES roles(id),
  name          TEXT    NOT NULL,
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  last_login_at TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS ix_users_company ON users(company_id);

-- SESSÕES. Guarda-se apenas o SHA-256 do token (revogação imediata possível).
CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT    NOT NULL UNIQUE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip          TEXT,
  user_agent  TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT    NOT NULL,
  revoked_at  TEXT
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);

-- AUDITORIA. company_id denormalizado para consultas por tenant.
CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER,                    -- NULL = ação de plataforma (Master)
  user_id     INTEGER,
  action      TEXT NOT NULL,
  entity      TEXT,
  entity_id   INTEGER,
  metadata    TEXT,                       -- JSON enxuto, sem dados sensíveis
  ip          TEXT,
  user_agent  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_audit_company ON audit_logs(company_id, created_at);
CREATE INDEX IF NOT EXISTS ix_audit_created ON audit_logs(created_at);
