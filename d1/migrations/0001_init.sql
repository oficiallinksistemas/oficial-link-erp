CREATE TABLE accounts_payable (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id       INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  store_id         INTEGER REFERENCES stores(id),
  supplier_id      INTEGER REFERENCES suppliers(id),
  purchase_id      INTEGER REFERENCES purchases(id),
  origin_type      TEXT    NOT NULL DEFAULT 'manual' CHECK (origin_type IN ('purchase', 'manual')),
  description      TEXT    NOT NULL,
  document_number  TEXT,
  reference        TEXT,
  amount_cents     INTEGER NOT NULL CHECK (amount_cents > 0),
  issue_date       TEXT    NOT NULL,               -- AAAA-MM-DD
  due_date         TEXT    NOT NULL,               -- AAAA-MM-DD (data de negócio)
  status           TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'canceled')),
  paid_at          TEXT,
  paid_amount_cents INTEGER CHECK (paid_amount_cents IS NULL OR paid_amount_cents > 0),
  paid_by          INTEGER REFERENCES users(id),
  notes            TEXT,
  created_by       INTEGER NOT NULL REFERENCES users(id),
  updated_by       INTEGER REFERENCES users(id),
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT
);
CREATE TABLE accounts_receivable (
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
CREATE TABLE agenda_events (
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
CREATE TABLE audit_logs (
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
CREATE TABLE checklist_items (
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
CREATE TABLE checklists (
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
CREATE TABLE companies (
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
, plan TEXT NOT NULL DEFAULT 'standard', subscription_status TEXT NOT NULL DEFAULT 'active'
  CHECK (subscription_status IN ('active', 'past_due', 'canceled')));
CREATE TABLE company_assets (
  company_id  INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  mime        TEXT    NOT NULL CHECK (mime IN ('image/png', 'image/jpeg')),
  data        BLOB    NOT NULL,
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE company_modules (
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  module_slug TEXT NOT NULL REFERENCES modules(slug) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  settings    TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT,
  PRIMARY KEY (company_id, module_slug)
);
CREATE TABLE customers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  phone       TEXT,
  document    TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT
, email       TEXT, address     TEXT, number      TEXT, complement  TEXT, district    TEXT, city        TEXT, state       TEXT, zip         TEXT, notes       TEXT, status      TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'inactive')));
CREATE TABLE inventory_items (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id         INTEGER NOT NULL REFERENCES inventory_sessions(id) ON DELETE CASCADE,
  company_id         INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id         INTEGER NOT NULL REFERENCES products(id),
  system_quantity    INTEGER NOT NULL,
  counted_quantity   INTEGER,
  difference         INTEGER,
  adjustment_applied INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')), counted_at TEXT, counted_movement_id INTEGER NOT NULL DEFAULT 0,
  UNIQUE (session_id, product_id)
);
CREATE TABLE inventory_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  store_id     INTEGER NOT NULL REFERENCES stores(id),
  status       TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'canceled')),
  started_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  completed_by INTEGER REFERENCES users(id),
  created_by   INTEGER NOT NULL REFERENCES users(id),
  note         TEXT
);
CREATE TABLE modules (
  slug        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  is_official INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE notifications (
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
CREATE TABLE permissions (
  code        TEXT PRIMARY KEY,
  module      TEXT NOT NULL,
  description TEXT
);
CREATE TABLE platform_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE product_categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT,
  UNIQUE (company_id, name)
);
CREATE TABLE products (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  category_id    INTEGER REFERENCES product_categories(id) ON DELETE SET NULL,
  name           TEXT    NOT NULL,
  description    TEXT,
  sku            TEXT,
  barcode        TEXT,
  unit           TEXT    NOT NULL DEFAULT 'UN',
  price_cents    INTEGER NOT NULL CHECK (price_cents > 0),
  cost_cents     INTEGER CHECK (cost_cents IS NULL OR cost_cents > 0),
  minimum_stock  INTEGER CHECK (minimum_stock IS NULL OR minimum_stock >= 0),
  status         TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT
);
CREATE TABLE purchase_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id       INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  purchase_id      INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  product_id       INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name     TEXT    NOT NULL,
  product_sku      TEXT,
  product_unit     TEXT,
  unit_cost_cents  INTEGER NOT NULL CHECK (unit_cost_cents > 0),
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  subtotal_cents   INTEGER NOT NULL CHECK (subtotal_cents > 0),
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE purchases (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  store_id      INTEGER NOT NULL REFERENCES stores(id),
  supplier_id   INTEGER NOT NULL REFERENCES suppliers(id),
  status        TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'received', 'canceled')),
  purchase_date TEXT    NOT NULL,
  total_cents   INTEGER NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  note          TEXT,
  created_by    INTEGER NOT NULL REFERENCES users(id),
  received_at   TEXT,
  received_by   INTEGER REFERENCES users(id),
  canceled_at   TEXT,
  cancel_reason TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT
);
CREATE TABLE role_permissions (
  role_id          INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code  TEXT    NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);
CREATE TABLE roles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER REFERENCES companies(id) ON DELETE CASCADE,  -- NULL = global
  slug        TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  description TEXT,
  is_system   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE saas_billing_config (
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
CREATE TABLE saas_charges (
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
CREATE TABLE saas_payments (
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
CREATE TABLE saas_receipts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id  INTEGER NOT NULL UNIQUE,      -- 1:1 com saas_payments (integridade na transação)
  company_id  INTEGER NOT NULL REFERENCES companies(id),
  mime        TEXT NOT NULL,                -- image/png | image/jpeg | application/pdf
  size        INTEGER NOT NULL,
  data        BLOB NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE sale_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id       INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sale_id          INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id       INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name     TEXT    NOT NULL,               -- snapshot
  product_sku      TEXT,                           -- snapshot
  product_unit     TEXT,                           -- snapshot
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents > 0),
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  subtotal_cents   INTEGER NOT NULL CHECK (subtotal_cents > 0),
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE sales (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  store_id      INTEGER NOT NULL REFERENCES stores(id),
  seller_id     INTEGER NOT NULL REFERENCES users(id),
  customer_id   INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  customer_name TEXT    NOT NULL,              -- snapshot (venda preserva o nome)
  amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
  sold_at       TEXT    NOT NULL,              -- 'YYYY-MM-DD HH:MM' (fuso da empresa)
  note          TEXT,
  status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'canceled')),
  created_by    INTEGER NOT NULL REFERENCES users(id),
  canceled_at   TEXT,
  canceled_by   INTEGER REFERENCES users(id),
  cancel_reason TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT
, product_id INTEGER REFERENCES products(id) ON DELETE SET NULL, product_name TEXT, product_price_cents INTEGER, stock_was_applied INTEGER NOT NULL DEFAULT 0);
CREATE TABLE schema_migrations (
    id         TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
CREATE TABLE sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT    NOT NULL UNIQUE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip          TEXT,
  user_agent  TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT    NOT NULL,
  revoked_at  TEXT
);
CREATE TABLE stock_balances (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  store_id    INTEGER NOT NULL REFERENCES stores(id),
  product_id  INTEGER NOT NULL REFERENCES products(id),
  quantity    INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT,
  UNIQUE (company_id, store_id, product_id)
);
CREATE TABLE "stock_movements" (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  store_id       INTEGER NOT NULL REFERENCES stores(id),
  product_id     INTEGER NOT NULL REFERENCES products(id),
  type           TEXT NOT NULL CHECK (type IN ('ENTRY', 'EXIT', 'ADJUST_IN', 'ADJUST_OUT', 'SALE', 'SALE_REVERSAL')),
  quantity       INTEGER NOT NULL CHECK (quantity > 0),
  balance_before INTEGER NOT NULL,
  balance_after  INTEGER NOT NULL,
  reference_type TEXT CHECK (reference_type IN ('sale', 'cancel', 'manual', 'adjust', 'purchase', 'transfer')),
  reference_id   INTEGER,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  note           TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE stock_transfer_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  transfer_id   INTEGER NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  product_id    INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name  TEXT    NOT NULL,
  product_sku   TEXT,
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE stock_transfers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  from_store_id INTEGER NOT NULL REFERENCES stores(id),
  to_store_id   INTEGER NOT NULL REFERENCES stores(id),
  status        TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'canceled')),
  note          TEXT,
  created_by    INTEGER NOT NULL REFERENCES users(id),
  completed_at  TEXT,
  completed_by  INTEGER REFERENCES users(id),
  canceled_at   TEXT,
  cancel_reason TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT
);
CREATE TABLE stores (
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
CREATE TABLE suppliers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  document    TEXT,
  phone       TEXT,
  email       TEXT,
  address     TEXT,
  city        TEXT,
  state       TEXT,
  zip         TEXT,
  notes       TEXT,
  status      TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT
);
CREATE TABLE targets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type         TEXT    NOT NULL CHECK (type IN ('seller', 'store')),
  user_id      INTEGER REFERENCES users(id),    -- quando type = 'seller'
  store_id     INTEGER REFERENCES stores(id),   -- quando type = 'store'
  start_date   TEXT    NOT NULL,                -- 'YYYY-MM-DD'
  end_date     TEXT    NOT NULL,                -- 'YYYY-MM-DD'
  target_cents INTEGER NOT NULL CHECK (target_cents > 0),
  notes        TEXT,
  created_by   INTEGER NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT,
  CHECK (
    (type = 'seller' AND user_id IS NOT NULL AND store_id IS NULL) OR
    (type = 'store'  AND store_id IS NOT NULL AND user_id IS NULL)
  )
);
CREATE TABLE tasks (
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
CREATE TABLE users (
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
, must_change_password INTEGER NOT NULL DEFAULT 0);
INSERT INTO "companies" ("id","name","trade_name","document","email","phone","status","settings","created_at","updated_at","plan","subscription_status") VALUES (1,'Anjos','Anjos',NULL,'contato@anjos.com.br',NULL,'active','{"timezone":"America/Fortaleza","currency":"BRL"}','2026-10-07 15:46:07',NULL,'standard','active');
INSERT INTO "company_modules" ("company_id","module_slug","status","settings","created_at","updated_at") VALUES (1,'dashboard','active','{}','2026-10-07 15:46:07',NULL);
INSERT INTO "company_modules" ("company_id","module_slug","status","settings","created_at","updated_at") VALUES (1,'sales','active','{}','2026-10-07 15:46:07',NULL);
INSERT INTO "company_modules" ("company_id","module_slug","status","settings","created_at","updated_at") VALUES (1,'targets','active','{}','2026-10-07 15:46:07',NULL);
INSERT INTO "company_modules" ("company_id","module_slug","status","settings","created_at","updated_at") VALUES (1,'ranking','active','{}','2026-10-07 15:46:07',NULL);
INSERT INTO "company_modules" ("company_id","module_slug","status","settings","created_at","updated_at") VALUES (1,'customers','active','{}','2026-10-07 15:46:07',NULL);
INSERT INTO "company_modules" ("company_id","module_slug","status","settings","created_at","updated_at") VALUES (1,'products','active','{}','2026-10-07 15:46:07',NULL);
INSERT INTO "company_modules" ("company_id","module_slug","status","settings","created_at","updated_at") VALUES (1,'stock','active','{}','2026-10-07 15:46:07',NULL);
INSERT INTO "company_modules" ("company_id","module_slug","status","settings","created_at","updated_at") VALUES (1,'suppliers','active','{}','2026-10-07 15:46:07',NULL);
INSERT INTO "company_modules" ("company_id","module_slug","status","settings","created_at","updated_at") VALUES (1,'purchases','active','{}','2026-10-07 15:46:07',NULL);
INSERT INTO "company_modules" ("company_id","module_slug","status","settings","created_at","updated_at") VALUES (1,'reports','active','{}','2026-10-07 15:46:07',NULL);
INSERT INTO "company_modules" ("company_id","module_slug","status","settings","created_at","updated_at") VALUES (1,'payables','active','{}','2026-10-07 15:46:07',NULL);
INSERT INTO "company_modules" ("company_id","module_slug","status","settings","created_at","updated_at") VALUES (1,'receivables','active','{}','2026-10-07 15:46:07',NULL);
INSERT INTO "company_modules" ("company_id","module_slug","status","settings","created_at","updated_at") VALUES (1,'tasks','active','{}','2026-10-07 15:46:07',NULL);
INSERT INTO "company_modules" ("company_id","module_slug","status","settings","created_at","updated_at") VALUES (1,'agenda','active','{}','2026-10-07 15:46:07',NULL);
INSERT INTO "company_modules" ("company_id","module_slug","status","settings","created_at","updated_at") VALUES (1,'checklists','active','{}','2026-10-07 15:46:07',NULL);
INSERT INTO "company_modules" ("company_id","module_slug","status","settings","created_at","updated_at") VALUES (1,'notifications','active','{}','2026-10-07 15:46:07',NULL);
INSERT INTO "modules" ("slug","name","description","is_official","created_at") VALUES ('dashboard','Dashboard','Painel inicial do ERP',1,'2026-10-07 15:46:07');
INSERT INTO "modules" ("slug","name","description","is_official","created_at") VALUES ('sales','Vendas','Registro e gestão de vendas',1,'2026-10-07 15:46:07');
INSERT INTO "modules" ("slug","name","description","is_official","created_at") VALUES ('customers','Clientes','Cadastro de clientes (estrutura preparada)',1,'2026-10-07 15:46:07');
INSERT INTO "modules" ("slug","name","description","is_official","created_at") VALUES ('products','Produtos','Catálogo de produtos (preparado)',1,'2026-10-07 15:46:07');
INSERT INTO "modules" ("slug","name","description","is_official","created_at") VALUES ('stock','Estoque','Controle de estoque (preparado)',1,'2026-10-07 15:46:07');
INSERT INTO "modules" ("slug","name","description","is_official","created_at") VALUES ('ranking','Ranking','Ranking de vendedores (preparado)',1,'2026-10-07 15:46:07');
INSERT INTO "modules" ("slug","name","description","is_official","created_at") VALUES ('commissions','Comissões','Cálculo de comissões (preparado)',1,'2026-10-07 15:46:07');
INSERT INTO "modules" ("slug","name","description","is_official","created_at") VALUES ('requests','Solicitações','Solicitações internas (preparado)',1,'2026-10-07 15:46:07');
INSERT INTO "modules" ("slug","name","description","is_official","created_at") VALUES ('tasks','Tarefas','Tarefas e pendências (preparado)',1,'2026-10-07 15:46:07');
INSERT INTO "modules" ("slug","name","description","is_official","created_at") VALUES ('payables','Contas a pagar','(preparado)',1,'2026-10-07 15:46:07');
INSERT INTO "modules" ("slug","name","description","is_official","created_at") VALUES ('receivables','Contas a receber','(preparado)',1,'2026-10-07 15:46:07');
INSERT INTO "modules" ("slug","name","description","is_official","created_at") VALUES ('suppliers','Fornecedores','(preparado)',1,'2026-10-07 15:46:07');
INSERT INTO "modules" ("slug","name","description","is_official","created_at") VALUES ('documents','Documentos','(preparado)',1,'2026-10-07 15:46:07');
INSERT INTO "modules" ("slug","name","description","is_official","created_at") VALUES ('reports','Relatórios','(preparado)',1,'2026-10-07 15:46:07');
INSERT INTO "modules" ("slug","name","description","is_official","created_at") VALUES ('notifications','Notificações','(preparado)',1,'2026-10-07 15:46:07');
INSERT INTO "modules" ("slug","name","description","is_official","created_at") VALUES ('targets','Metas','Metas comerciais por vendedor ou loja',1,'2026-10-07 15:46:07');
INSERT INTO "modules" ("slug","name","description","is_official","created_at") VALUES ('purchases','Compras','Entrada de mercadoria com fornecedor',1,'2026-10-07 15:46:07');
INSERT INTO "modules" ("slug","name","description","is_official","created_at") VALUES ('agenda','Agenda','Compromissos, reuniões e visitas',1,'2026-10-07 15:46:07');
INSERT INTO "modules" ("slug","name","description","is_official","created_at") VALUES ('checklists','Checklists','Checklists e rotinas operacionais',1,'2026-10-07 15:46:07');
INSERT INTO "permissions" ("code","module","description") VALUES ('platform.overview.view','Plataforma','Visão geral da plataforma');
INSERT INTO "permissions" ("code","module","description") VALUES ('platform.stores.view','Plataforma','Visualizar lojas de qualquer empresa');
INSERT INTO "permissions" ("code","module","description") VALUES ('platform.stores.manage','Plataforma','Gerenciar lojas de qualquer empresa');
INSERT INTO "permissions" ("code","module","description") VALUES ('platform.users.view','Plataforma','Visualizar usuários de qualquer empresa');
INSERT INTO "permissions" ("code","module","description") VALUES ('platform.users.manage','Plataforma','Gerenciar usuários de qualquer empresa');
INSERT INTO "permissions" ("code","module","description") VALUES ('platform.audit.view','Plataforma','Visualizar auditoria da plataforma');
INSERT INTO "permissions" ("code","module","description") VALUES ('platform.settings.view','Plataforma','Visualizar configurações da plataforma');
INSERT INTO "permissions" ("code","module","description") VALUES ('platform.settings.manage','Plataforma','Alterar configurações da plataforma');
INSERT INTO "permissions" ("code","module","description") VALUES ('sales.view','Vendas','Visualizar vendas');
INSERT INTO "permissions" ("code","module","description") VALUES ('sales.create','Vendas','Registrar venda');
INSERT INTO "permissions" ("code","module","description") VALUES ('sales.edit','Vendas','Editar venda');
INSERT INTO "permissions" ("code","module","description") VALUES ('sales.cancel','Vendas','Cancelar venda');
INSERT INTO "permissions" ("code","module","description") VALUES ('targets.view','Metas','Visualizar metas e desempenho');
INSERT INTO "permissions" ("code","module","description") VALUES ('targets.create','Metas','Cadastrar meta');
INSERT INTO "permissions" ("code","module","description") VALUES ('targets.edit','Metas','Editar meta');
INSERT INTO "permissions" ("code","module","description") VALUES ('targets.delete','Metas','Excluir meta');
INSERT INTO "permissions" ("code","module","description") VALUES ('ranking.view','Ranking','Visualizar ranking de vendedores e lojas');
INSERT INTO "permissions" ("code","module","description") VALUES ('customers.view','Clientes','Visualizar clientes');
INSERT INTO "permissions" ("code","module","description") VALUES ('customers.create','Clientes','Cadastrar cliente');
INSERT INTO "permissions" ("code","module","description") VALUES ('customers.edit','Clientes','Editar cliente');
INSERT INTO "permissions" ("code","module","description") VALUES ('customers.delete','Clientes','Excluir cliente');
INSERT INTO "permissions" ("code","module","description") VALUES ('products.view','Produtos','Visualizar produtos');
INSERT INTO "permissions" ("code","module","description") VALUES ('products.create','Produtos','Cadastrar produto');
INSERT INTO "permissions" ("code","module","description") VALUES ('products.edit','Produtos','Editar produto');
INSERT INTO "permissions" ("code","module","description") VALUES ('products.delete','Produtos','Excluir produto');
INSERT INTO "permissions" ("code","module","description") VALUES ('stock.view','Estoque','Visualizar saldos e movimentações');
INSERT INTO "permissions" ("code","module","description") VALUES ('stock.move','Estoque','Registrar entrada e saída manual');
INSERT INTO "permissions" ("code","module","description") VALUES ('stock.adjust','Estoque','Ajustar saldo (inventário)');
INSERT INTO "permissions" ("code","module","description") VALUES ('suppliers.view','Fornecedores','Visualizar fornecedores');
INSERT INTO "permissions" ("code","module","description") VALUES ('suppliers.create','Fornecedores','Cadastrar fornecedor');
INSERT INTO "permissions" ("code","module","description") VALUES ('suppliers.edit','Fornecedores','Editar fornecedor');
INSERT INTO "permissions" ("code","module","description") VALUES ('suppliers.delete','Fornecedores','Excluir fornecedor');
INSERT INTO "permissions" ("code","module","description") VALUES ('purchases.view','Compras','Visualizar compras');
INSERT INTO "permissions" ("code","module","description") VALUES ('purchases.create','Compras','Cadastrar compra (rascunho)');
INSERT INTO "permissions" ("code","module","description") VALUES ('purchases.edit','Compras','Editar compra em rascunho');
INSERT INTO "permissions" ("code","module","description") VALUES ('purchases.receive','Compras','Receber compra (entrada no estoque)');
INSERT INTO "permissions" ("code","module","description") VALUES ('purchases.cancel','Compras','Cancelar compra');
INSERT INTO "permissions" ("code","module","description") VALUES ('reports.view','Relatórios','Visualizar relatórios operacionais');
INSERT INTO "permissions" ("code","module","description") VALUES ('payables.view','Contas a pagar','Visualizar contas a pagar');
INSERT INTO "permissions" ("code","module","description") VALUES ('payables.create','Contas a pagar','Lançar título a pagar');
INSERT INTO "permissions" ("code","module","description") VALUES ('payables.update','Contas a pagar','Editar título em aberto');
INSERT INTO "permissions" ("code","module","description") VALUES ('payables.pay','Contas a pagar','Pagar título');
INSERT INTO "permissions" ("code","module","description") VALUES ('payables.cancel','Contas a pagar','Cancelar título em aberto');
INSERT INTO "permissions" ("code","module","description") VALUES ('payables.delete','Contas a pagar','Excluir título manual em aberto');
INSERT INTO "permissions" ("code","module","description") VALUES ('receivables.view','Contas a receber','Visualizar contas a receber');
INSERT INTO "permissions" ("code","module","description") VALUES ('receivables.create','Contas a receber','Lançar título a receber');
INSERT INTO "permissions" ("code","module","description") VALUES ('receivables.update','Contas a receber','Editar título em aberto');
INSERT INTO "permissions" ("code","module","description") VALUES ('receivables.receive','Contas a receber','Receber título');
INSERT INTO "permissions" ("code","module","description") VALUES ('receivables.cancel','Contas a receber','Cancelar título em aberto');
INSERT INTO "permissions" ("code","module","description") VALUES ('receivables.delete','Contas a receber','Excluir título manual em aberto');
INSERT INTO "permissions" ("code","module","description") VALUES ('platform.billing.view','Plataforma','Visualizar cobranças SaaS das empresas');
INSERT INTO "permissions" ("code","module","description") VALUES ('platform.billing.manage','Plataforma','Gerenciar cobranças SaaS das empresas');
INSERT INTO "permissions" ("code","module","description") VALUES ('tasks.view','Tarefas','Visualizar tarefas');
INSERT INTO "permissions" ("code","module","description") VALUES ('tasks.create','Tarefas','Criar tarefa');
INSERT INTO "permissions" ("code","module","description") VALUES ('tasks.edit','Tarefas','Editar tarefa');
INSERT INTO "permissions" ("code","module","description") VALUES ('tasks.delete','Tarefas','Excluir tarefa');
INSERT INTO "permissions" ("code","module","description") VALUES ('tasks.complete','Tarefas','Concluir/reabrir tarefa');
INSERT INTO "permissions" ("code","module","description") VALUES ('agenda.view','Agenda','Visualizar agenda');
INSERT INTO "permissions" ("code","module","description") VALUES ('agenda.create','Agenda','Criar compromisso');
INSERT INTO "permissions" ("code","module","description") VALUES ('agenda.edit','Agenda','Editar compromisso');
INSERT INTO "permissions" ("code","module","description") VALUES ('agenda.delete','Agenda','Cancelar/excluir compromisso');
INSERT INTO "permissions" ("code","module","description") VALUES ('checklists.view','Checklists','Visualizar checklists');
INSERT INTO "permissions" ("code","module","description") VALUES ('checklists.create','Checklists','Criar checklist');
INSERT INTO "permissions" ("code","module","description") VALUES ('checklists.edit','Checklists','Editar checklist');
INSERT INTO "permissions" ("code","module","description") VALUES ('checklists.delete','Checklists','Excluir/cancelar checklist');
INSERT INTO "permissions" ("code","module","description") VALUES ('checklists.complete','Checklists','Executar/concluir itens e checklist');
INSERT INTO "permissions" ("code","module","description") VALUES ('notifications.view','Notificações','Visualizar notificações');
INSERT INTO "permissions" ("code","module","description") VALUES ('notifications.manage','Notificações','Gerenciar notificações da empresa');
INSERT INTO "permissions" ("code","module","description") VALUES ('platform.companies.view','Plataforma','Visualizar empresas cadastradas');
INSERT INTO "permissions" ("code","module","description") VALUES ('platform.companies.manage','Plataforma','Cadastrar, editar e suspender empresas');
INSERT INTO "permissions" ("code","module","description") VALUES ('dashboard.view','Dashboard','Visualizar o painel inicial');
INSERT INTO "permissions" ("code","module","description") VALUES ('stores.view','Lojas','Visualizar lojas');
INSERT INTO "permissions" ("code","module","description") VALUES ('stores.manage','Lojas','Cadastrar e editar lojas');
INSERT INTO "permissions" ("code","module","description") VALUES ('users.view','Usuários','Visualizar usuários');
INSERT INTO "permissions" ("code","module","description") VALUES ('users.manage','Usuários','Cadastrar, editar e redefinir senhas');
INSERT INTO "permissions" ("code","module","description") VALUES ('company.settings.view','Empresa','Visualizar dados da empresa');
INSERT INTO "permissions" ("code","module","description") VALUES ('company.settings.manage','Empresa','Editar dados e configurações da empresa');
INSERT INTO "platform_settings" ("key","value","updated_at") VALUES ('maintenance_mode','0','2026-10-07 15:46:07');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'platform.overview.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'platform.companies.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'platform.companies.manage');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'platform.stores.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'platform.stores.manage');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'platform.users.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'platform.users.manage');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'platform.audit.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'platform.settings.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'platform.settings.manage');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'dashboard.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'stores.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'stores.manage');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'users.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'users.manage');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'company.settings.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'company.settings.manage');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'sales.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'sales.create');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'sales.edit');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'sales.cancel');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'targets.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'targets.create');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'targets.edit');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'targets.delete');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'ranking.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'customers.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'customers.create');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'customers.edit');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'customers.delete');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'products.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'products.create');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'products.edit');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'products.delete');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'stock.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'stock.move');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'stock.adjust');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'suppliers.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'suppliers.create');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'suppliers.edit');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'suppliers.delete');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'purchases.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'purchases.create');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'purchases.edit');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'purchases.receive');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'purchases.cancel');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'reports.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'payables.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'payables.create');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'payables.update');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'payables.pay');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'payables.cancel');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'payables.delete');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'receivables.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'receivables.create');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'receivables.update');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'receivables.receive');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'receivables.cancel');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'receivables.delete');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'tasks.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'tasks.create');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'tasks.edit');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'tasks.delete');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'tasks.complete');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'agenda.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'agenda.create');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'agenda.edit');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'agenda.delete');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'checklists.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'checklists.create');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'checklists.edit');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'checklists.delete');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'checklists.complete');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (1,'notifications.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'dashboard.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'stores.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'stores.manage');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'users.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'users.manage');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'company.settings.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'company.settings.manage');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'sales.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'sales.create');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'sales.edit');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'sales.cancel');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'targets.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'targets.create');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'targets.edit');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'targets.delete');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'ranking.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'customers.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'customers.create');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'customers.edit');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'customers.delete');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'products.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'products.create');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'products.edit');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'products.delete');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'stock.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'stock.move');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'stock.adjust');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'suppliers.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'suppliers.create');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'suppliers.edit');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'suppliers.delete');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'purchases.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'purchases.create');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'purchases.edit');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'purchases.receive');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'purchases.cancel');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'reports.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'payables.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'payables.create');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'payables.update');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'payables.pay');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'payables.cancel');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'payables.delete');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'receivables.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'receivables.create');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'receivables.update');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'receivables.receive');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'receivables.cancel');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'receivables.delete');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'tasks.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'tasks.create');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'tasks.edit');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'tasks.delete');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'tasks.complete');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'agenda.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'agenda.create');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'agenda.edit');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'agenda.delete');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'checklists.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'checklists.create');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'checklists.edit');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'checklists.delete');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'checklists.complete');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (2,'notifications.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'dashboard.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'stores.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'users.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'company.settings.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'sales.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'sales.create');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'sales.edit');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'targets.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'targets.create');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'targets.edit');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'ranking.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'customers.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'customers.create');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'customers.edit');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'products.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'products.create');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'products.edit');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'stock.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'stock.move');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'stock.adjust');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'suppliers.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'suppliers.create');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'suppliers.edit');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'purchases.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'purchases.create');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'purchases.edit');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'purchases.receive');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'reports.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'payables.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'payables.create');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'payables.update');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'payables.pay');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'payables.cancel');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'receivables.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'receivables.create');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'receivables.update');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'receivables.receive');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (3,'receivables.cancel');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (4,'dashboard.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (4,'sales.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (4,'sales.create');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (4,'targets.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (4,'ranking.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (4,'customers.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (4,'customers.create');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (4,'products.view');
INSERT INTO "role_permissions" ("role_id","permission_code") VALUES (4,'stock.view');
INSERT INTO "roles" ("id","company_id","slug","name","description","is_system","created_at") VALUES (1,NULL,'master','Master','Controle global da plataforma — Oficial Link Sistemas',1,'2026-10-07 15:46:07');
INSERT INTO "roles" ("id","company_id","slug","name","description","is_system","created_at") VALUES (2,NULL,'company_admin','Administrador','Acesso completo dentro da própria empresa',1,'2026-10-07 15:46:07');
INSERT INTO "roles" ("id","company_id","slug","name","description","is_system","created_at") VALUES (3,NULL,'supervisor','Supervisor','Acompanhamento de equipe e lojas, sem alterações críticas',1,'2026-10-07 15:46:07');
INSERT INTO "roles" ("id","company_id","slug","name","description","is_system","created_at") VALUES (4,NULL,'seller','Vendedor','Acesso operacional básico',1,'2026-10-07 15:46:07');
INSERT INTO "schema_migrations" ("id","applied_at") VALUES ('001_initial','2026-10-07 15:46:07');
INSERT INTO "schema_migrations" ("id","applied_at") VALUES ('002_platform_admin','2026-10-07 15:46:07');
INSERT INTO "schema_migrations" ("id","applied_at") VALUES ('003_modules_sales','2026-10-07 15:46:07');
INSERT INTO "schema_migrations" ("id","applied_at") VALUES ('004_targets','2026-10-07 15:46:07');
INSERT INTO "schema_migrations" ("id","applied_at") VALUES ('005_ranking','2026-10-07 15:46:07');
INSERT INTO "schema_migrations" ("id","applied_at") VALUES ('006_customers','2026-10-07 15:46:07');
INSERT INTO "schema_migrations" ("id","applied_at") VALUES ('007_indexes','2026-10-07 15:46:07');
INSERT INTO "schema_migrations" ("id","applied_at") VALUES ('008_products','2026-10-07 15:46:07');
INSERT INTO "schema_migrations" ("id","applied_at") VALUES ('009_stock_sale_items','2026-10-07 15:46:07');
INSERT INTO "schema_migrations" ("id","applied_at") VALUES ('010_hardening_suppliers','2026-10-07 15:46:07');
INSERT INTO "schema_migrations" ("id","applied_at") VALUES ('011_purchases','2026-10-07 15:46:07');
INSERT INTO "schema_migrations" ("id","applied_at") VALUES ('012_transfers_inventory_reports','2026-10-07 15:46:07');
INSERT INTO "schema_migrations" ("id","applied_at") VALUES ('013_reference_types','2026-10-07 15:46:07');
INSERT INTO "schema_migrations" ("id","applied_at") VALUES ('014_inventory_counted_at','2026-10-07 15:46:07');
INSERT INTO "schema_migrations" ("id","applied_at") VALUES ('015_accounts_payable','2026-10-07 15:46:07');
INSERT INTO "schema_migrations" ("id","applied_at") VALUES ('016_payables_consolidation','2026-10-07 15:46:07');
INSERT INTO "schema_migrations" ("id","applied_at") VALUES ('017_accounts_receivable','2026-10-07 15:46:07');
INSERT INTO "schema_migrations" ("id","applied_at") VALUES ('018_company_branding','2026-10-07 15:46:07');
INSERT INTO "schema_migrations" ("id","applied_at") VALUES ('019_module_registry_cleanup','2026-10-07 15:46:07');
INSERT INTO "schema_migrations" ("id","applied_at") VALUES ('020_saas_billing_config','2026-10-07 15:46:07');
INSERT INTO "schema_migrations" ("id","applied_at") VALUES ('021_saas_charges','2026-10-07 15:46:07');
INSERT INTO "schema_migrations" ("id","applied_at") VALUES ('022_saas_payments','2026-10-07 15:46:07');
INSERT INTO "schema_migrations" ("id","applied_at") VALUES ('023_operational_tasks','2026-10-07 15:46:07');
INSERT INTO "schema_migrations" ("id","applied_at") VALUES ('024_agenda','2026-10-07 15:46:07');
INSERT INTO "schema_migrations" ("id","applied_at") VALUES ('025_checklists','2026-10-07 15:46:07');
INSERT INTO "schema_migrations" ("id","applied_at") VALUES ('026_notifications','2026-10-07 15:46:07');
INSERT INTO "stores" ("id","company_id","name","code","city","state","status","created_at","updated_at") VALUES (1,1,'Anjos Balsas','BALSAS','Balsas','MA','active','2026-10-07 15:46:07',NULL);
INSERT INTO "stores" ("id","company_id","name","code","city","state","status","created_at","updated_at") VALUES (2,1,'Anjos Imperatriz','IMPERATRIZ','Imperatriz','MA','active','2026-10-07 15:46:07',NULL);
INSERT INTO "users" ("id","company_id","store_id","role_id","name","email","password_hash","status","last_login_at","created_at","updated_at","must_change_password") VALUES (1,NULL,NULL,1,'Master Oficial Link','master@oficiallink.com.br','scrypt$16384$1fe200e200e1d9571bc1ad0c08acf56a$74228e30aec1b504f7d4c187f100fe15bb0e7708e8910483c0a27fc7f9908cc26992c35465dffbc6f5b4325a4cbf65d3183cc93cad200fa42486a70615374be4','active',NULL,'2026-10-07 15:46:07',NULL,1);
INSERT INTO "users" ("id","company_id","store_id","role_id","name","email","password_hash","status","last_login_at","created_at","updated_at","must_change_password") VALUES (2,1,NULL,2,'Administrador Anjos','admin@anjos.com.br','scrypt$16384$fb6920a7dc73bb082e01b648811e1477$2e03f4f5988232be2b8c341e38e19c438d3abc7714e276dd39681e1203e9f7a9e0e69b4529b4d613bd1ea61c43eb1982859a5c15dac68e28c8c303a922508537','active',NULL,'2026-10-07 15:46:07',NULL,1);
INSERT INTO "users" ("id","company_id","store_id","role_id","name","email","password_hash","status","last_login_at","created_at","updated_at","must_change_password") VALUES (3,1,NULL,3,'Supervisor Anjos','supervisor@anjos.com.br','scrypt$16384$905559f186c34c3276c802f333ceb20c$7083a986485d301a14ba3106486e63087a098bc10eb1e3bbe1a7824c5058dfb23c88c6da6998e3cfa6b6d9ee255763ed429730f87208c6ab8fc55deb75850d35','active',NULL,'2026-10-07 15:46:07',NULL,1);
INSERT INTO "users" ("id","company_id","store_id","role_id","name","email","password_hash","status","last_login_at","created_at","updated_at","must_change_password") VALUES (4,1,1,4,'Vendedor Anjos','vendedor@anjos.com.br','scrypt$16384$8e79ca203addeef8e7ea1d324469b02c$fbbb0215633cd7be1f547215953171f7334f76c1fa8ed86c3e4053df07fa1c16e53cb979826dc08a02452f18dacacf83df6df1627ceed42ce978daca6bc65c5e','active',NULL,'2026-10-07 15:46:07',NULL,1);