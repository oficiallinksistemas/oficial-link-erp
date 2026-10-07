# Arquitetura — Oficial Link ERP (v3.5)

## Visão geral

Monólito modular em camadas — deliberadamente simples: leve em hardware modesto,
fácil de manter por anos, pronto para crescer como SaaS. Um único processo Node.js
serve a API e o frontend estático (sem build, sem framework de UI).

```
Navegador (SPA em JS puro, módulos ES sob demanda)
        │  fetch /api/* (cookie HttpOnly + validação de Origin)
        ▼
Express ──► headers de segurança ──► rate limit ──► CSRF/Origin
        │                                        │
        ▼                                        ▼
  autenticação (sessão→SHA-256→banco) ──► autorização (RBAC / Master)
        │                                        │
        ▼                                        ▼
  escopo tenant (company_id da SESSÃO) ──► módulos (rotas → serviço)
        │                                        │
        ▼                                        ▼
  static/web                                 SQLite (migrations versionadas)
```

## Backend

| Camada | Responsabilidade |
|---|---|
| `app.js` / `index.js` | App Express **exportado** (testável) / entrypoint que escuta porta |
| `core/` | Transversal: scrypt/tokens, validação, erros, rate limit (contador simples + **por falha**), CSRF/Origin, auditoria |
| `database/` | `db.js` (conexão), `migrations.js` (runner versionado), `connection.js` (db+migrations), `migrations/NNN_*.sql`, `seed.js` idempotente |
| `middlewares/auth.js` | Sessão, carregamento de usuário/função/permissões/empresa, guardas (`requirePermission`, `requireMaster`), **troca de senha obrigatória**, **modo de manutenção** |
| `modules/*` | Um diretório por domínio; autorização declarada por rota |
| `tests/` | Suíte `node:test` real — cada arquivo sobe o app em porta efêmera com banco temporário |

### Decisões e porquês

- **SQLite (better-sqlite3)**: zero infra, ACID, ótimo para o MVP; migração futura
  para PostgreSQL fica localizada na camada `database/`.
- **Sessões opacas em banco**: revogação imediata (troca de senha, desativação,
  suspensão de empresa, revogar sessões do Master) e só o SHA-256 do token fica
  armazenado.
- **Apenas 2 dependências**: superfície de ataque pequena, install rápido.
- **app exportado separado do listener**: possibilita a suíte de testes real
  (porta 0, banco temporário via `DB_FILE`).
- **Migrations versionadas**: evolução sem destruir dados; legados da v1 são
  detectados e preservados (ver `docs/MIGRATIONS.md`).
- **Rate limit de login por FALHAS**: brute force é contado por tentativa
  malsucedida; usuário legítimo nunca é bloqueado por logar corretamente.

## Multi-tenancy (crítico) — inalterado e reforçado

1. Todo usuário não-Master tem `company_id`.
2. O `company_id` do contexto **sempre** vem da sessão (`req.auth.user.companyId`).
   Nenhuma rota aceita `company_id` do cliente (teste cobre forja desse campo).
3. Toda consulta/escrita filtra por esse `company_id`; registro de outra empresa
   simplesmente "não existe" (404).
4. Unicidade composta (`UNIQUE(company_id, code)`), então códigos iguais em
   empresas diferentes coexistem sem vazamento.
5. Master (`company_id IS NULL` + slug `master`) acessa somente `/api/platform/*`;
   módulos de tenant rejeitam Master explicitamente; a função `master` jamais pode
   ser atribuída por ninguém (nem pelo próprio Master pela API — testado).
6. Suspender empresa = revogar todas as sessões do tenant na mesma requisição.
7. **Modo de manutenção** (configuração de plataforma em banco) bloqueia tenants
   (login e sessões) sem nunca bloquear o Master.

## Hierarquia e autoridade

```
Oficial Link Sistemas → Master Platform Admin → Empresas → Lojas → Usuários → Funções/Permissões
```

- O Master é reconhecido **somente no backend** (sessão com `company_id NULL` +
  função `master`) e possui **autoridade global**: `requirePermission` concede
  ao Master qualquer permissão, presente ou futura, sem depender de
  `role_permissions` (testado com todos os vínculos removidos). O frontend
  apenas renderiza o que a sessão permite — nunca decide "sou Master".
- Ações do Master sobre tenants são autenticadas, validadas e auditadas
  (`platform.*`) — inclusive CRUD de lojas/usuários de qualquer empresa.
- **O Master nunca vê senha**: reset define nova senha temporária e força troca
  (`must_change_password`); o backend bloqueia qualquer outra rota até a troca.

## Frontend

- Sem build, sem framework; roteador com **import dinâmico** (páginas sob demanda).
- XSS: tudo passa por `esc()`; ícones são SVG discretos (nunca emojis).
- Nova página = 1 entrada no array `routes` de `app.js` + 1 arquivo em `pages/`.
- Área Plataforma (só renderiza para quem tem permissão): visão geral, empresas
  (com detalhe de lojas+usuários), lojas, usuários, auditoria, configurações.
- Modal bloqueante de **troca de senha obrigatória** quando o backend sinaliza
  `mustChangePassword`.

## Extensibilidade

- Permissões: catálogo em `database/seed.js`; nova permissão = 1 linha + uso em
  `requirePermission('nova.perm')` (e migration `INSERT OR IGNORE` para legados).
- Novas funções: inserir em `roles`/`role_permissions` (a coluna `company_id`
  das funções já permite funções personalizadas por empresa no futuro).
- Módulos futuros: migration + diretório em `modules/` + rota + página (padrão
  documentado em `docs/DATA_MODEL.md`).

## Limitações conscientes do MVP

- Rate limiting em memória (uma instância) — trocar por Redis com múltiplas instâncias.
- SQLite atende dezenas de usuários; para centenas+, PostgreSQL.
- Backup é local (arquivo em `data/backups/`); backup remoto fica para a etapa
  de infraestrutura de produção.
