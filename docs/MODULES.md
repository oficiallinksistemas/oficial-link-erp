# Arquitetura modular — Oficial Link ERP (v3.5)

Conceito central: **UM ÚNICO CÓDIGO DO ERP + CONFIGURAÇÕES DIFERENTES PARA CADA
EMPRESA**. Não existem versões por cliente — existem módulos oficiais, ativação
por empresa, permissões por função e configurações por tenant.

```
PLATAFORMA
  → MÓDULOS OFICIAIS        (tabela modules — registry)
  → EMPRESA                 (companies)
  → MÓDULOS ATIVOS          (tabela company_modules)
  → PERMISSÕES              (permissions + role_permissions)
  → USUÁRIOS                (users)
```

Separação de conceitos (não misturar):
- **Plano/assinatura** (SaaS futuro): o que a empresa PODERÁ ativar.
- **company_modules**: o que está ATIVO agora.
- **Permissões**: o que o USUÁRIO pode fazer nos módulos ativos.

## Como funciona na prática (V1.2 — módulo Vendas)

| Camada | Onde | O quê |
|---|---|---|
| Registry | `migrations/003_modules_sales.sql` (tabela `modules`) | módulos oficiais da plataforma |
| Ativação | `company_modules` (company_id + module_slug + status) | liga/desliga por empresa — nunca apaga dados |
| Proteção backend | `core/modules.js` → `requireModule('sales')` | 403 `MODULE_INACTIVE` se inativo (Master nunca bloqueado) |
| Permissões | `sales.view/create/edit/cancel` | por rota, via `requirePermission` |
| Escopo tenant | `tenantId(req)` da sessão | company_id nunca vem do cliente |
| Gestão | Plataforma do Master: `GET /api/platform/modules`, `GET/PUT /api/platform/companies/:id/modules(/:slug)` | ativa/desativa, auditado (`platform.module.update`) |
| Menu | `GET /api/modules` (tenant) + `session.moduleActive()` | UX apenas — segurança real no backend |
| Tela | `web/assets/js/pages/sales.js` | usa componentes reutilizáveis do `ui.js` |

## Como adicionar um NOVO módulo (padrão documentado)

1. **Migration** `NNN_<modulo>.sql`:
   - `INSERT OR IGNORE INTO modules (slug, name, …)` no registry;
   - permissões `modulo.view` / `modulo.manage` (convenção: `.view` consulta,
     ações granulares para escrita) + vínculos por função (`role_permissions`,
     com `INSERT SELECT` para bancos legados);
   - tabelas do domínio **sempre com `company_id NOT NULL REFERENCES
     companies(id)`** + índices compostos começando por `company_id`;
   - `INSERT OR IGNORE INTO company_modules … SELECT id, '<slug>' FROM companies`
     apenas se o módulo deve nascer ativo para empresas existentes.
   - No `seed.js`: incluir as permissões no catálogo `PERMISSIONS` e nos
     `ROLE_PERMISSIONS` (bancos novos rodam o seed depois das migrations, com
     as funções ainda inexistentes — o seed é a fonte da verdade nesse caso).
2. **Backend** `server/src/modules/<modulo>/routes.js` (+ `service.js` se
   tiver regras): guardas na ordem — tenant only → `requirePermission` →
   escopo `tenantId(req)` em toda consulta.
3. **Mount** em `src/app.js`:
   `app.use('/api/<modulo>', authenticate, requireModule('<slug>'), <rotas>);`
4. **Frontend**: `web/assets/js/pages/<modulo>.js` + 1 entrada no array
   `routes` de `app.js` com `module: '<slug>'`, `perm: '<modulo>.view'` e
   `tenantOnly: true`. O menu passa a respeitar módulo + permissão + tenant.
5. **Permissões do Master**: automáticas pela autoridade global do backend —
   nenhuma operação manual.
6. **Testes**: novo `tests/<modulo>.test.js` cobrindo ativação/desativação,
   CRUD, validações, permissões por função e isolamento A↔B.

## Módulos implementados vs. preparados (estado real)

| Módulo | Estado |
|---|---|
| Dashboard | Implementado (v1) |
| Vendas | **Implementado (v1.2)** — CRUD completo, cancelamento terminal, clientes mínimos, cards no dashboard |
| Metas | **Implementado (v1.3, corrigido v1.3.1)** — metas por vendedor (função `seller`) / loja, período livre, desempenho embutido na listagem (sem N+1), anti-duplicidade por escopo+período |
| Ranking | **Implementado (v1.4, corrigido v1.4.1)** — vendedores e lojas, agregado de `sales`+`targets` (meta só se cobrir integralmente o período), períodos hoje/semana/mês/personalizado, sem tabela própria |
| Clientes | **Implementado (v1.5, consolidado v1.6)** — cadastro completo, CPF/CNPJ único por empresa, histórico de vendas derivado de Sales, desativação preservando histórico, exclusão só sem vendas |
| Produtos | **Implementado (v1.7, consolidado)** — CRUD completo, detalhe, categorias com gestão completa (criar/renomear/status/excluir protegida), SKU/barcode únicos por empresa, unidade com domínio fechado, preço em centavos, estoque mínimo cadastral (fundação para Estoque), snapshot nas vendas, module gating reforçado (sem bypass pelo Sales) |
| Contas a pagar | **Implementado (v2.0)** — títulos manuais e de compras (uma compra = um título, idempotente), pagamento transacional anti-duplicidade, OVERDUE derivado, resumo por natureza, relatório integrado, exclusão restrita |
| Estoque, Comissões, Solicitações, Tarefas, Contas a receber, Fornecedores (módulo próprio além do cadastro), Documentos, Notificações | Apenas registrados no `modules` (registry) — **não há telas nem APIs de negócio** |

CUSTOM RESOURCES (construção de recursos personalizados por empresa) é um
conceito futuro — a arquitetura não o impede, mas nada foi implementado.
