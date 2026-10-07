CREATE TABLE IF NOT EXISTS schema_migrations (
    id         TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
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
, plan TEXT NOT NULL DEFAULT 'standard', subscription_status TEXT NOT NULL DEFAULT 'active'
  CHECK (subscription_status IN ('active', 'past_due', 'canceled')));
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
CREATE TABLE IF NOT EXISTS roles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER REFERENCES companies(id) ON DELETE CASCADE,  -- NULL = global
  slug        TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  description TEXT,
  is_system   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
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
, must_change_password INTEGER NOT NULL DEFAULT 0);
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
CREATE TABLE IF NOT EXISTS platform_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS modules (
  slug        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  is_official INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS company_modules (
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  module_slug TEXT NOT NULL REFERENCES modules(slug) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  settings    TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT,
  PRIMARY KEY (company_id, module_slug)
);
CREATE TABLE IF NOT EXISTS customers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  phone       TEXT,
  document    TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT
, email       TEXT, address     TEXT, number      TEXT, complement  TEXT, district    TEXT, city        TEXT, state       TEXT, zip         TEXT, notes       TEXT, status      TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'inactive')));
CREATE TABLE IF NOT EXISTS sales (
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
CREATE TABLE IF NOT EXISTS targets (
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
CREATE TABLE IF NOT EXISTS product_categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT,
  UNIQUE (company_id, name)
);
CREATE TABLE IF NOT EXISTS products (
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
CREATE TABLE IF NOT EXISTS sale_items (
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
CREATE TABLE IF NOT EXISTS stock_balances (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  store_id    INTEGER NOT NULL REFERENCES stores(id),
  product_id  INTEGER NOT NULL REFERENCES products(id),
  quantity    INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT,
  UNIQUE (company_id, store_id, product_id)
);
CREATE TABLE IF NOT EXISTS suppliers (
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
CREATE TABLE IF NOT EXISTS purchases (
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
CREATE TABLE IF NOT EXISTS purchase_items (
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
CREATE TABLE IF NOT EXISTS stock_transfers (
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
CREATE TABLE IF NOT EXISTS stock_transfer_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  transfer_id   INTEGER NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  product_id    INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name  TEXT    NOT NULL,
  product_sku   TEXT,
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS inventory_sessions (
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
CREATE TABLE IF NOT EXISTS inventory_items (
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
CREATE TABLE IF NOT EXISTS "stock_movements" (
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
CREATE TABLE IF NOT EXISTS accounts_payable (
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
CREATE TABLE IF NOT EXISTS accounts_receivable (
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
CREATE TABLE IF NOT EXISTS company_assets (
  company_id  INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  mime        TEXT    NOT NULL CHECK (mime IN ('image/png', 'image/jpeg')),
  data        BLOB    NOT NULL,
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
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
CREATE UNIQUE INDEX IF NOT EXISTS ux_companies_document ON companies(document) WHERE document IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_stores_company ON stores(company_id);
CREATE INDEX IF NOT EXISTS ix_users_company ON users(company_id);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS ix_audit_company ON audit_logs(company_id, created_at);
CREATE INDEX IF NOT EXISTS ix_audit_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS ix_company_modules_company ON company_modules(company_id);
CREATE INDEX IF NOT EXISTS ix_customers_company ON customers(company_id, name);
CREATE INDEX IF NOT EXISTS ix_sales_company_date    ON sales(company_id, sold_at);
CREATE INDEX IF NOT EXISTS ix_sales_company_store   ON sales(company_id, store_id, sold_at);
CREATE INDEX IF NOT EXISTS ix_sales_company_seller  ON sales(company_id, seller_id, sold_at);
CREATE INDEX IF NOT EXISTS ix_sales_company_status  ON sales(company_id, status, sold_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_targets_seller_period
  ON targets(company_id, user_id, start_date, end_date) WHERE type = 'seller';
CREATE UNIQUE INDEX IF NOT EXISTS ux_targets_store_period
  ON targets(company_id, store_id, start_date, end_date) WHERE type = 'store';
CREATE INDEX IF NOT EXISTS ix_targets_company_period ON targets(company_id, start_date, end_date);
CREATE UNIQUE INDEX IF NOT EXISTS ux_customers_document
  ON customers(company_id, document) WHERE document IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_customers_company_name
  ON customers(company_id, name);
CREATE INDEX IF NOT EXISTS ix_sales_company_customer
  ON sales(company_id, customer_id);
CREATE INDEX IF NOT EXISTS ix_product_categories_company ON product_categories(company_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS ux_products_sku
  ON products(company_id, sku) WHERE sku IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_products_barcode
  ON products(company_id, barcode) WHERE barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_products_company_name ON products(company_id, name);
CREATE INDEX IF NOT EXISTS ix_products_company_category ON products(company_id, category_id);
CREATE INDEX IF NOT EXISTS ix_sales_company_product ON sales(company_id, product_id);
CREATE INDEX IF NOT EXISTS ix_sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS ix_sale_items_company_product ON sale_items(company_id, product_id);
CREATE INDEX IF NOT EXISTS ix_stock_balances_company_store ON stock_balances(company_id, store_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_suppliers_document
  ON suppliers(company_id, document) WHERE document IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_suppliers_company_name ON suppliers(company_id, name);
CREATE INDEX IF NOT EXISTS ix_purchases_company_date ON purchases(company_id, purchase_date);
CREATE INDEX IF NOT EXISTS ix_purchases_company_store ON purchases(company_id, store_id, purchase_date);
CREATE INDEX IF NOT EXISTS ix_purchase_items_purchase ON purchase_items(purchase_id);
CREATE INDEX IF NOT EXISTS ix_purchase_items_company_product ON purchase_items(company_id, product_id);
CREATE INDEX IF NOT EXISTS ix_stock_transfers_company ON stock_transfers(company_id, created_at);
CREATE INDEX IF NOT EXISTS ix_stock_transfer_items_transfer ON stock_transfer_items(transfer_id);
CREATE INDEX IF NOT EXISTS ix_inventory_sessions_company ON inventory_sessions(company_id, store_id);
CREATE INDEX IF NOT EXISTS ix_inventory_items_session ON inventory_items(session_id);
CREATE INDEX IF NOT EXISTS ix_stock_movements_lookup ON stock_movements(company_id, store_id, product_id, created_at);
CREATE INDEX IF NOT EXISTS ix_stock_movements_company_created ON stock_movements(company_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_accounts_payable_purchase
  ON accounts_payable(company_id, purchase_id) WHERE purchase_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_payables_company_status ON accounts_payable(company_id, status);
CREATE INDEX IF NOT EXISTS ix_payables_company_due    ON accounts_payable(company_id, due_date);
CREATE INDEX IF NOT EXISTS ix_payables_company_supplier ON accounts_payable(company_id, supplier_id);
CREATE INDEX IF NOT EXISTS ix_payables_company_store  ON accounts_payable(company_id, store_id);
CREATE INDEX IF NOT EXISTS ix_payables_company_purchase ON accounts_payable(company_id, purchase_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_accounts_receivable_sale
  ON accounts_receivable(company_id, sale_id) WHERE sale_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_receivables_company_status  ON accounts_receivable(company_id, status);
CREATE INDEX IF NOT EXISTS ix_receivables_company_due     ON accounts_receivable(company_id, due_date);
CREATE INDEX IF NOT EXISTS ix_receivables_company_issue   ON accounts_receivable(company_id, issue_date);
CREATE INDEX IF NOT EXISTS ix_receivables_company_customer ON accounts_receivable(company_id, customer_id);
CREATE INDEX IF NOT EXISTS ix_receivables_company_store   ON accounts_receivable(company_id, store_id);
CREATE INDEX IF NOT EXISTS ix_receivables_received_at     ON accounts_receivable(company_id, received_at);
CREATE INDEX IF NOT EXISTS ix_saas_config_due_day ON saas_billing_config (billing_due_day);
CREATE INDEX IF NOT EXISTS ix_saas_charges_company_status ON saas_charges (company_id, status);
CREATE INDEX IF NOT EXISTS ix_saas_charges_status_due    ON saas_charges (status, due_date);
CREATE INDEX IF NOT EXISTS ix_saas_charges_company_due   ON saas_charges (company_id, due_date);
CREATE INDEX IF NOT EXISTS ix_saas_charges_paid_on       ON saas_charges (paid_on) WHERE paid_on IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_saas_payments_company ON saas_payments (company_id);
CREATE INDEX IF NOT EXISTS ix_saas_payments_charge  ON saas_payments (charge_id);
CREATE INDEX IF NOT EXISTS ix_saas_payments_paid_on ON saas_payments (paid_on);
CREATE INDEX IF NOT EXISTS ix_saas_receipts_company ON saas_receipts (company_id);
CREATE INDEX IF NOT EXISTS ix_tasks_company_status  ON tasks (company_id, status);
CREATE INDEX IF NOT EXISTS ix_tasks_company_due     ON tasks (company_id, due_date);
CREATE INDEX IF NOT EXISTS ix_tasks_assignee_status ON tasks (assigned_to_user_id, status);
CREATE INDEX IF NOT EXISTS ix_tasks_company_store   ON tasks (company_id, store_id);
CREATE INDEX IF NOT EXISTS ix_agenda_company_start ON agenda_events (company_id, start_at);
CREATE INDEX IF NOT EXISTS ix_agenda_company_status ON agenda_events (company_id, status);
CREATE INDEX IF NOT EXISTS ix_agenda_responsible   ON agenda_events (responsible_user_id, status);
CREATE INDEX IF NOT EXISTS ix_checklists_company_status ON checklists (company_id, status);
CREATE INDEX IF NOT EXISTS ix_checklists_assignee      ON checklists (assigned_to_user_id, status);
CREATE INDEX IF NOT EXISTS ix_checklist_items_order    ON checklist_items (checklist_id, position);
CREATE INDEX IF NOT EXISTS ix_checklist_items_open     ON checklist_items (checklist_id, completed);
CREATE UNIQUE INDEX IF NOT EXISTS ux_notifications_dedupe
  ON notifications (company_id, user_id, dedupe_key);
CREATE INDEX IF NOT EXISTS ix_notifications_user_unread ON notifications (user_id, read_at);
CREATE INDEX IF NOT EXISTS ix_notifications_user_recent ON notifications (user_id, id DESC);
CREATE INDEX IF NOT EXISTS ix_notifications_company      ON notifications (company_id);