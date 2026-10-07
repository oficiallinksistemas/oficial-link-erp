# Migrations — Oficial Link ERP

Sistema de migrations versionado para o SQLite. Cada migration é aplicada
**uma única vez** e registrada na tabela de controle — o banco evolui sem
perder dados.

## Como funciona

```
server/src/database/
├── db.js                     # conexão pura (sem migrations)
├── migrations.js             # runner: aplica o que ainda não foi aplicado
├── connection.js             # db.js + migrations (use este no código)
└── migrations/
    ├── 001_initial.sql       # schema base da v1
    └── 002_platform_admin.sql# v1.1: Master Admin, SaaS, segurança
```

- Controle de versão: tabela `schema_migrations (id TEXT PK, applied_at)`.
- O runner (`migrations.js`) lista os arquivos `.sql` em ordem e aplica os
  que não constam na tabela de controle, dentro de uma transação.
- **Bancos legados da v1** (tabelas existem, mas não há `schema_migrations`):
  a `001_initial` é apenas **registrada** (não reaplicada) e as novas
  migrations seguem a partir daí. Comportamento verificado por teste manual:
  banco v1 com dados evoluiu para v1.1 preservando 100% dos registros.

## Como criar uma nova migration

1. Crie `server/src/database/migrations/003_sua_feature.sql`.
2. Use apenas instruções seguras e repetíveis no contexto:
   - `CREATE TABLE IF NOT EXISTS …` para tabelas novas;
   - `ALTER TABLE … ADD COLUMN …` (com `DEFAULT`) para colunas;
   - `INSERT OR IGNORE …` para catálogos (permissões, configurações);
   - tabelas de negócio sempre com `company_id NOT NULL REFERENCES companies(id)`.
3. Nunca use `DROP`/`DELETE` destrutivos em migrations de evolução.
4. Suba o servidor — a migration é aplicada automaticamente no boot.

Exemplo mínimo:

```sql
-- 003_sales.sql
CREATE TABLE IF NOT EXISTS sales (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  store_id   INTEGER REFERENCES stores(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  amount     INTEGER NOT NULL DEFAULT 0,
  sold_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_sales_company ON sales(company_id, sold_at);
```

## Histórico

| Migration | Descrição |
|---|---|
| `001_initial` | Fundação v1: companies, stores, roles, permissions, role_permissions, users, sessions, audit_logs |
| `002_platform_admin` | v1.1: `users.must_change_password`; `companies.plan` e `subscription_status`; tabela `platform_settings`; permissões de plataforma (overview/stores/users/audit/settings) com vínculo automático à função Master |
