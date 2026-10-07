# Modelo de Dados — Oficial Link ERP (v3.5)

Documento refletindo o estado REAL do banco (migrations 001–026). Convenções
e estruturas de módulos futuros não constam aqui — apenas o que existe.

## Entidades centrais (plataforma)

```
companies ──┬──< stores
            ├──< users >── roles >──< role_permissions >── permissions
            ├──< audit_logs (company_id denormalizado)
            ├──< company_modules >── modules
            └──< company_assets (logo — 1:1)

sessions >── users
platform_settings (chave/valor — configuração global da plataforma)
schema_migrations (controle de versão do banco)
```

| Tabela | Chaves | Observações |
|---|---|---|
| `companies` | PK `id`; `document` único (quando informado) | `status: active\|suspended`; `settings` JSON (timezone, branding); `plan`, `subscription_status` (fundação SaaS) |
| `stores` | PK `id`; **`UNIQUE(company_id, code)`** | `status: active\|inactive` |
| `roles` | PK `id` | `company_id NULL` = função global (master, company_admin, supervisor, seller) |
| `permissions` | PK `code` | catálogo: 12 `platform.*` (10 base + 2 billing) + 42 de negócio |
| `role_permissions` | PK `(role_id, permission_code)` | RBAC; Master não depende de vínculos (autoridade global do backend) |
| `users` | PK `id`; `email` único | `company_id NULL` = Master; `must_change_password`; `store_id` opcional |
| `sessions` | `token_hash` único | só o SHA-256 do token; `revoked_at` para revogação imediata |
| `audit_logs` | índices `(company_id, created_at)`, `created_at` | trilha de auditoria (metadata JSON enxuto) |
| `platform_settings` | PK `key` | ex.: `maintenance_mode` (0/1) |
| `modules` | PK `slug` | registry oficial (18 módulos após cleanup da migration 019) |
| `company_modules` | PK `(company_id, module_slug)` | módulos ativos por empresa; desativar NUNCA apaga dados |
| `company_assets` | PK `company_id` | logo PNG/JPEG validado por magic bytes (máx 150 KB) |
| `schema_migrations` | PK `id` | uma linha por migration aplicada |

## Tabelas de negócio (módulos implementados)

| Módulo | Tabelas | Migration |
|---|---|---|
| Clientes | `customers` (com endereço completo e status) | 003, 006 |
| Vendas | `sales`, `sale_items` | 003, 008, 009 |
| Metas | `targets` (slug canônico — placeholder `goals` removido na 019) | 004 |
| Produtos | `products`, `product_categories` | 008 |
| Estoque | `stock_balances`, `stock_movements` | 009, 013 |
| Fornecedores | `suppliers` | 010 |
| Compras | `purchases`, `purchase_items` | 011 |
| Transferências | `stock_transfers`, `stock_transfer_items` | 012 |
| Inventário | `inventory_sessions`, `inventory_items` | 012, 014 |
| Contas a pagar | `accounts_payable` | 015, 016 |
| Contas a receber | `accounts_receivable` | 017 |

### Camada comercial SaaS (plataforma — v3.3)

Cobrança que a **Oficial Link faz do tenant**. Contexto DIFERENTE do
financeiro do tenant (Contas a Pagar/Receber) — tabelas próprias, acesso
somente Master (`requireMaster` + `platform.billing.view/manage`).

| Tabela | Chaves | Observações |
|---|---|---|
| `saas_billing_config` | PK `company_id` (1:1) | implantação/mensalidade em **centavos**, dia de vencimento (1–28), método padrão, notas, próximo vencimento |
| `saas_charges` | PK `id`; índices `(company_id,status)`, `(status,due_date)`, `paid_on` | tipo `implementation\|monthly\|custom`; status `OPEN\|OVERDUE\|PAID\|CANCELED` (OVERDUE classificado pelo fuso da empresa via `core/businessDate` e persistido por refresh em leitura); cancelamento auditado; nunca apagada |
| `saas_payments` | PK `id`; índices `(company_id)`, `(charge_id)`, `paid_on` | histórico imutável de pagamentos manuais (valor em centavos, data de negócio, método, quem registrou); pagamento transacional com guarda de status (`changes===1`) — idempotente |
| `saas_receipts` | PK `id`; `payment_id` UNIQUE (1:1, sem FK — integridade na transação) | comprovante BLOB validado por magic bytes (PNG/JPEG/PDF, máx 5 MB); acesso somente plataforma |

### Camada operacional V1 (v3.4)

Módulos independentes e **desativáveis sem apagar dados**; vínculos com
módulos de negócio são OPCIONAIS e **sem FK** (a entidade sobrevive à
desativação de qualquer módulo e à exclusão do registro de origem).

| Tabela | Chaves | Observações |
|---|---|---|
| `tasks` | índices `(company_id,status)`, `(company_id,due_date)`, `(assigned_to_user_id,status)` | prioridade/status por CHECK; vínculos `client_id/sale_id/purchase_id/payable_id/receivable_id` **sem FK** + `link_label` snapshot; conclusão registra `completed_at/completed_by`; DELETE bloqueado para concluídas |
| `agenda_events` | índices `(company_id,start_at)`, `(company_id,status)` | `start_at/end_at` em **horário local da empresa** (`YYYY-MM-DD HH:MM`); `all_day` por CHECK; vínculos cliente/tarefa sem FK; `end_at > start_at` validado no serviço |
| `checklists` / `checklist_items` | índices por status/atribuído + `(checklist_id,position)` | itens são **linhas da execução** (nunca compartilhadas — execuções independentes); progresso calculado no backend (SUM/COUNT); conclusão exige todos os `required=1` concluídos; `ON DELETE CASCADE` só dentro da execução |
| `notifications` | **UNIQUE `(company_id,user_id,dedupe_key)`** — anti-spam | tipos controlados por CHECK; `action_url` só rota interna (validado no serviço; insegura → persistida como NULL); `read_at` nullable; infraestrutura: geradores verificam ativação do módulo antes de inserir (operação nunca quebra) |

Ranking, Dashboard e Relatórios leem das tabelas acima (sem tabelas
próprias de dados): agregações sempre filtradas por `company_id`.

## Convenções (vigentes)

1. **Toda tabela de negócio tem `company_id INTEGER NOT NULL REFERENCES companies(id)`**.
2. Índices compostos começando por `company_id` nas consultas principais.
3. Nunca aceitar `company_id` do cliente — sempre do contexto de sessão.
4. Status em vez de `DELETE` em registros operacionais (soft-delete lógico).
5. Dados históricos preservados: snapshot de nome/preço em vendas e compras;
   `stock_was_applied` gravado no fato; venda cancelada nunca é apagada.
6. Valores monetários em **centavos** (INTEGER) — sem ponto flutuante.
7. Datas de negócio seguem o timezone da empresa (`core/businessDate`) —
   nunca UTC do servidor; `effective_status` (ex.: `overdue`) é derivado,
   nunca persistido.
8. Cada mudança estrutural = nova migration `NNN_*.sql` (ver
   `docs/MIGRATIONS.md`); nunca editar migration já aplicada.

## Permissões — catálogo real (70)

**Plataforma (12, somente Master):** `platform.overview.view`,
`platform.companies.view`, `platform.companies.manage`,
`platform.stores.view`, `platform.stores.manage`, `platform.users.view`,
`platform.users.manage`, `platform.audit.view`, `platform.settings.view`,
`platform.settings.manage`, `platform.billing.view` (v3.3),
`platform.billing.manage` (v3.3).

**Operacional (16, v3.4):** `tasks.view/create/edit/delete/complete`;
`agenda.view/create/edit/delete`; `checklists.view/create/edit/delete/
complete`; `notifications.view`, `notifications.manage` (só por concessão
explícita — não vai no grant padrão do `company_admin`).

**Negócio (42):** `dashboard.view`; `stores.view/manage`; `users.view/manage`;
`company.settings.view/manage`; `sales.view/create/edit/cancel`;
`customers.view/create/edit/delete`; `targets.view/create/edit/delete`;
`ranking.view`; `products.view/create/edit/delete`; `stock.view/move/adjust`;
`suppliers.view/create/edit/delete`; `purchases.view/create/edit/receive/cancel`;
`payables.view/create/update/pay/cancel/delete`;
`receivables.view/create/update/receive/cancel/delete`; `reports.view`.

**Autoridade global do Master** (`company_id NULL` + slug `master`): todas as
permissões, presentes e futuras, decididas no backend (`requirePermission`).
O `/me` retorna `globalAdmin: true` + catálogo completo; o frontend usa a
flag apenas para renderizar o menu.
