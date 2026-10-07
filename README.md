# Oficial Link ERP

Sistema de gestão empresarial **multiempresa (SaaS multi-tenant)** da
**Oficial Link Sistemas** — [www.oficiallink.com](https://www.oficiallink.com).

**Versão atual: v3.5.0** — release candidate para a primeira empresa real:
V3.4.0 (Bloco 2 — camada operacional) homologada de ponta a ponta (Bloco
3): fluxo completo Master→empresa→operação auditado no código real,
onboarding da empresa piloto com camada operacional ativa no seed,
isolamento A×B validado por IDOR deliberado, fluxo comercial e de compras
conferidos com consistência de estoque/financeiro, desativação de módulos
(403 → dados preservados → reativação) e virada de dia por timezone
empresarial. **258 testes, última execução 258/258.**

V3.3.0 — V3.2.0 (Bloco 0: logo otimizada, favicon com
reset no logout, menu mobile com overlay, timezone unificado, registry de
módulos limpo, docs sincronizadas) + **Bloco 1 — SaaS Comercial V1**:
camada de cobrança da plataforma (Financeiro SaaS, Master-only) com
configuração comercial por empresa (implantação/mensalidade/vencimento),
cobranças (implantação, mensalidade, avulsas) com status
OPEN/OVERDUE/PAID/CANCELED, registro **manual** de pagamentos transacional
e idempotente (duplo pagamento → 409), comprovantes validados por magic
bytes (PNG/JPEG/PDF), histórico imutável, dashboard comercial (MRR
previsto, recebido no mês, em aberto, em atraso, implantações pendentes,
listas "Atenção") e visão de inadimplência — **separada do financeiro do
tenant** (Contas a Pagar/Receber) e sem gateway automático (preparado para
Pix/QR/webhook no futuro). **258 testes automatizados, última execução
258/258.**

Empresa piloto de validação: **Anjos** (lojas *Anjos Balsas* e *Anjos
Imperatriz*). A arquitetura é SaaS desde a fundação: novas empresas entram
sem mudança de código.

---

## Requisitos

- **Node.js 18 ou superior** (recomendado 20 LTS)
- npm

## Como executar

```bash
# 1. Instalar dependências (apenas 2: express + better-sqlite3)
npm run install:server

# 2. (Opcional) Configurar ambiente
cp server/.env.example server/.env

# 3. Iniciar
npm start          # produção
npm run dev        # desenvolvimento (reinício automático)
```

Acesse **http://localhost:3000** — o frontend é servido pelo próprio
servidor (sem build, sem etapa extra). Na primeira execução o banco
(`data/erp.db`) é criado com schema versionado (migrations 001–026) e dados
iniciais.

## Outros comandos

```bash
npm --prefix server test        # suíte automatizada (258 testes, bancos temporários)
npm --prefix server run backup  # backup local seguro do SQLite (data/backups/)
```

## Acessos iniciais — senha de primeiro acesso

**Todos os usuários do seed nascem com troca de senha obrigatória**
(`must_change_password=1`): a senha abaixo serve **apenas para o 1º login** —
imediatamente após entrar, o sistema exige criar uma nova senha antes de
liberar qualquer módulo. A senha inicial nunca aparece em resposta nem em
auditoria, e nunca é armazenada em texto claro.

| E-mail | Função | Senha do 1º acesso |
|---|---|---|
| `master@oficiallink.com.br` | Master Platform Admin (Oficial Link) | `Master@2026` |
| `admin@anjos.com.br` | Administrador (Anjos) | `Anjos@2026` |
| `supervisor@anjos.com.br` | Supervisor (Anjos) | `Anjos@2026` |
| `vendedor@anjos.com.br` | Vendedor (Anjos Balsas) | `Anjos@2026` |

Configuráveis via `SEED_MASTER_PASSWORD` / `SEED_ANJOS_PASSWORD` em `server/.env`.
Bancos já inicializados **não** são alterados (o seed só roda com banco vazio).

**Em produção (`NODE_ENV=production`) as duas são OBRIGATÓRIAS na instalação
inicial**: sem elas, o seed **aborta a inicialização** com erro claro — nenhuma
senha padrão conhecida é usada automaticamente em produção. Em desenvolvimento/
teste, os valores da tabela acima continuam sendo os padrões.

## Hierarquia do sistema

```
OFICIAL LINK SISTEMAS
└── MASTER PLATFORM ADMIN  (autoridade global — ver regra abaixo)
    └── EMPRESAS CLIENTES  (tenants: Anjos, futuras...)
        └── LOJAS          (unidades: Anjos Balsas, Anjos Imperatriz...)
            └── USUÁRIOS   (Administrador / Supervisor / Vendedor)
                └── FUNÇÕES → PERMISSÕES (RBAC granular, decidido no backend)
```

## Regra de autoridade do Master (decidida no BACKEND)

O Master (`company_id NULL` + função `master`) possui **autoridade global**:
todas as permissões — **presentes e futuras** — sem depender de atribuição
individual em `role_permissions`. Novas permissões de módulos futuros são
automaticamente concedidas ao Master. Usuários comuns seguem o RBAC normal.
O frontend reflete a regra apenas para exibir o menu (`globalAdmin`); a
decisão final é sempre do servidor (`requirePermission` em
`server/src/middlewares/auth.js`). Testado inclusive com todos os vínculos do
Master removidos do banco.

O Master **nunca visualiza senha** de ninguém: apenas redefine (com troca
obrigatória) e encerra sessões.

## Módulos implementados (22 no registry)

Dashboard · Vendas · Clientes · Metas (slug `targets`) · Ranking · Produtos ·
Estoque · Fornecedores · Compras · Transferências · Inventário ·
Contas a Pagar · Contas a Receber · Relatórios — além da gestão base
(Lojas, Usuários, Minha empresa), da plataforma Master (Visão geral,
Empresas, Lojas, Usuários, Auditoria, Configurações) e da **camada
operacional** (Tarefas, Agenda, Checklists, Notificações — menu
"Operação").

A ativação é **por empresa** (`company_modules`): o menu do tenant só exibe
módulos ativos, `requireModule` bloqueia as APIs de módulos inativos (403),
e **desativar nunca apaga dados** — integrações históricas continuam
consistentes (ex.: cancelar venda estorna o estoque se a baixa foi aplicada
na criação, mesmo com o módulo Estoque hoje inativo).

## O que a base entrega

**Segurança/base:** autenticação com sessões revogáveis (cookie HttpOnly +
SameSite), senhas scrypt, troca de senha obrigatória, rate limiting por IP
(global + por falha no login), isolamento multi-tenant absoluto
(`company_id` da sessão — IDOR testado), RBAC por rota, Master Platform
Admin completo, auditoria, CSRF/Origin (allowlist por `APP_ORIGIN`),
headers de segurança (CSP/HSTS condicional), backup local com rotação.

**Comercial:** vendas com itens (snapshot de preço), clientes, produtos
(SKU/código de barras únicos), estoque por loja (movimentos + saldos),
fornecedores, compras (recebimento atômico → estoque → título a pagar),
transferências, inventário (contagem/ajuste idempotente), metas por
vendedor/loja, ranking, contas a pagar e receber (OVERDUE derivado pelo
timezone da empresa), relatórios.

**Integrações transacionais:** venda baixa estoque e gera recebível na mesma
transação; cancelamento estorna pelo fato gravado (`stock_was_applied`) e
cancela o título OPEN; venda com título recebido não pode ser cancelada
(mensagem explícita, sem simulação); compra recebida gera no máximo um
título a pagar (UNIQUE idempotente).

**Personalização por empresa (v3.1+):** nome de exibição, cores
(principal/secundária/destaque — hex validado), logo (PNG/JPEG por magic
bytes, máx 150 KB, BLOB no banco) e **favicon dinâmico** gerado da
identidade (SVG com cor da marca + inicial, fallback para o favicon padrão).
Atualizações de branding preservam todas as demais chaves de
`companies.settings` (testado). VIEW ≠ MANAGE: usuário somente leitura vê o
branding mas não edita. No logout/expiração, a identidade volta ao padrão
Oficial Link (não vaza entre empresas no mesmo navegador).

**Datas de negócio:** "hoje" segue o timezone do cadastro da empresa
(`core/businessDate`, default `America/Fortaleza`) — nunca UTC do servidor;
timezone inválido é erro explícito, nunca fallback silencioso. Fonte única
usada por Contas a Pagar e Contas a Receber.

**Frontend leve sem build:** SPA em módulos ES sob demanda (import
dinâmico — só baixa a página que abre), design system navy/ciano em CSS
puro (tokens em `:root`), ícones SVG, responsivo (sidebar vira gaveta com
overlay em ≤860px, formulários em coluna única, tabelas com rolagem
horizontal), zero frameworks e zero fontes externas.

**Suíte de testes automatizados reais — 258 testes, última execução 258/258.**

## Estrutura

```
oficial-link-erp/
├── server/
│   ├── src/
│   │   ├── app.js / index.js     # app exportado (testável) / entrypoint
│   │   ├── config/               # ambiente + loader de .env próprio
│   │   ├── core/                 # scrypt/tokens, validação, erros,
│   │   │                         # rate limit, CSRF/Origin, auditoria,
│   │   │                         # businessDate (fuso empresarial), módulos
│   │   ├── database/             # db.js, migrations.js, connection.js,
│   │   │                         # migrations/001…026, seed.js
│   │   ├── middlewares/          # sessão, RBAC (+ autoridade global Master),
│   │   │                         # escopo tenant, troca de senha, manutenção
│   │   └── modules/              # 19 módulos: auth, users, stores, company,
│   │                             # roles, dashboard, platform, sales,
│   │                             # customers, targets, ranking, products,
│   │                             # stock, suppliers, purchases, payables,
│   │                             # receivables, reports
│   ├── scripts/backup.js         # backup local (npm run backup)
│   └── tests/                    # 25 arquivos de teste + helpers (258 testes)
├── web/                          # frontend estático sem build
│   └── assets/{css,js,img}       # design system, 26 páginas sob demanda,
│                                 #   logo otimizada (18,7 KB), favicon
├── data/                         # erp.db + backups/ (criados automaticamente)
└── docs/                         # arquitetura, segurança, dados, migrations,
                                  #   módulos, testes
```

## Configuração (server/.env)

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta do servidor |
| `NODE_ENV` | `development` | `production` ativa cookies Secure + HSTS |
| `SECURE_COOKIES` | `0` | Cookies apenas via HTTPS (forçado em production) |
| `SESSION_TTL_HOURS` | `8` | Duração da sessão |
| `DB_FILE` | `data/erp.db` | Sempre resolvido a partir da **raiz do projeto**, nunca relativo ao cwd |
| `TRUST_PROXY` | não definido | Proxy confiável para `req.ip` (rate limit/auditoria). **Somente do ambiente — nunca do cliente.** Não definido + production → `X-Forwarded-For` ignorado; use `TRUST_PROXY=1` atrás de proxy reverso |
| `APP_ORIGIN` | não definido | Origem pública do ERP (ex.: `https://erp.oficiallink.com`). Definida → CSRF aceita **apenas** essa origem (protocolo + host + porta). Não defina em dev/test |
| `SEED_*_PASSWORD` | ver exemplo | Senhas do 1º acesso do seed — todos nascem com troca obrigatória |

## Roadmap (próximos blocos)

**Bloco 1 — SaaS comercial V1:** mensalidade, taxa de implantação,
vencimento, status financeiro, registro manual de pagamento + comprovante,
histórico, painel financeiro do Master, inadimplência, fundação para Pix
automático futuro.

**Bloco 2 — Operacional V1:** notificações internas, tarefas, solicitações,
comissões V1, descontos V1 (limite por função), recursos personalizados
(NO-CODE-LITE controlado).

**Futuro (arquitetura preparada, não bloqueia a V1):** PDV, fiscal
(NF-e/NFC-e), desktop/offline, WhatsApp, gateway Pix automático, IA.

Novo módulo = migration `NNN_*.sql` (tabelas com `company_id`) + diretório
em `server/src/modules/` + página em `web/assets/js/pages/` + rota em
`app.js` + permissões via `INSERT OR IGNORE` na migration (o Master passa a
tê-las automaticamente).

## Documentação

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — arquitetura, multi-tenancy, decisões
- [`docs/SECURITY.md`](docs/SECURITY.md) — modelo de segurança completo
- [`docs/MIGRATIONS.md`](docs/MIGRATIONS.md) — sistema de migrations
- [`docs/MODULES.md`](docs/MODULES.md) — arquitetura modular
- [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) — modelo de dados REAL (tabelas, permissões, convenções)
- [`docs/TESTES.md`](docs/TESTES.md) — suíte automatizada (como rodar + cobertura)

---

© Oficial Link Sistemas — produto SaaS proprietário.
