# Modelo de Segurança — Oficial Link ERP (v3.5)

## Autenticação

- Senhas: **scrypt** (memory-hard, N=16384, r=8, p=1) com sal aleatório de 16 bytes;
  verificação com `timingSafeEqual`. Nunca armazenadas em texto puro; nenhum
  endpoint revela senha ou hash.
- Sessão: token opaco 256 bits em cookie **HttpOnly + SameSite=Lax** (+ Secure e
  HSTS em produção). No banco, apenas o **SHA-256 do token**.
- Sessões expiram (8 h) e são revogáveis: troca de senha, redefinição,
  desativação, suspensão de empresa, "encerrar sessões" do Master.
- **Troca de senha obrigatória** (`must_change_password`): qualquer reset exige
  nova senha no próximo acesso; o backend bloqueia todas as rotas exceto
  `me`/`logout`/`change-password` até a troca. Frontend exibe modal bloqueante.
- **Rate limiting de login por falhas**: 5 falhas / 10 min por IP+e-mail → 429
  com `Retry-After`. Logins corretos limpam o contador.
- Resposta de falha genérica ("E-mail ou senha inválidos.") — sem enumeração.

## Autorização — RBAC + autoridade global do Master

- **Usuários comuns**: RBAC granular por rota (`requirePermission`), com as
  permissões da sua função. Catálogo atual: **17 permissões** (10 de plataforma,
  1 dashboard, 2 lojas, 2 usuários, 2 empresa) — lista completa no README.
- **Master Platform Admin**: autoridade **global**, decidida no backend por
  `company_id NULL` + função `master`. Possui todas as permissões — **presentes
  e futuras** — independentemente de atribuição individual em
  `role_permissions`. Permissões criadas por módulos futuros (`sales.manage`,
  `targets.manage`, …) são automaticamente válidas para o Master, sem operação
  manual. Validado por teste com todos os vínculos do Master removidos do banco.
- Anti-escalação: ninguém altera a própria função/status; `master` jamais
  atribuível via API (nem pelo próprio Master); módulos de tenant rejeitam o
  Master e vice-versa.
- **O Master nunca vê senha de ninguém** — só redefine (com troca obrigatória)
  e encerra sessões. Ações do Master sobre tenants são autenticadas, validadas
  e auditadas (`platform.*`).

## Isolamento multi-tenant

- `company_id` obrigatório em toda tabela de negócio, sempre da **sessão**.
- Consultas escopadas; IDs de outra empresa → 404; unicidade composta por tenant.
- Suíte automatizada com ataques cruzados A↔B (leitura, escrita, reset de senha,
  forja de `company_id`) — `tests/tenancy.test.js`.

## CSRF / Origin

- SameSite=Lax + validação de **Origin** em toda escrita (POST/PUT/PATCH/DELETE).
- Sem `APP_ORIGIN` (dev/test): `Origin` deve bater com o `Host` da requisição
  (localhost funciona) — divergente → 403 `BAD_ORIGIN`.
- Com `APP_ORIGIN` (produção): aceita **apenas** a origem configurada, comparando
  a **ORIGEM COMPLETA** (protocolo + host + porta, `URL.origin` normalizada) — 
  `http://erp.oficiallink.com`, `https://erp.oficiallink.com:8443` e
  `https://outrodominio.com` são bloqueados quando a configurada é
  `https://erp.oficiallink.com`. Valor inválido impede o boot da configuração.

## IP de confiança (trust proxy)

- `req.ip` (usado em rate limit e auditoria) só confia no nível definido pela
  variável de ambiente `TRUST_PROXY` — **nunca** em valor enviado pelo cliente
  além desse limite configurado.
- Produção sem `TRUST_PROXY`: `X-Forwarded-For` é ignorado — um cliente
  exposto diretamente não consegue falsificar seu IP para o rate limit.
- Dev/test: `1` (loopback), mantendo o comportamento funcional.

## Senhas iniciais do seed

- Todos os usuários criados pelo seed nascem com `must_change_password=1`: a
  senha inicial serve apenas para o 1º acesso; o backend bloqueia qualquer
  rota exceto `me`/`logout`/`change-password` até a troca.
- Regra aplicada **somente no seed** — bancos já inicializados não são
  alterados. Senha inicial nunca aparece em resposta nem em auditoria.
- **Produção**: `SEED_MASTER_PASSWORD` e `SEED_ANJOS_PASSWORD` são obrigatórias
  para a instalação inicial — se faltarem com o banco vazio, o seed aborta a
  inicialização (erro claro no log). Nenhum padrão conhecido é usado em
  produção; dev/test mantêm os valores padrão.

## Transporte, headers e payload

- CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`;
  `X-Powered-By` removido; HSTS em produção.
- Body JSON ≤ 256 KB; parse/limite com respostas controladas; erros sem stack
  trace (testado).

## Auditoria

Registra: logins (sucesso/falha/bloqueio/manutenção), logout, troca e
redefinição de senha, CRUD de usuários/lojas (empresa e plataforma), sessões
revogadas, alterações de empresa, suspensão/reativação, configurações da
plataforma (inclusive modo de manutenção). Evento carrega usuário, empresa,
entidade, ID, IP, user-agent, timestamp. **Nunca** senha, hash ou token — com
teste de garantia.

## Dados, backup e dependências

- Segredos 100% via variáveis de ambiente; nenhuma credencial no repositório.
- Apenas 2 dependências npm (express + better-sqlite3).
- Backup: `npm run backup` — online backup API (cópia consistente com o sistema
  em execução), rotação dos 10 mais recentes em `data/backups/`, com instruções
  de restore.

## Auditoria futura

Camadas separadas, validação centralizada, autorização declarativa, suíte
executável (258 testes: auth, segurança, multi-tenancy, IDOR, hardening de
integrações, SaaS comercial, camada operacional, homologação de fluxo
comercial/compras, Master e autoridade global).

## Camada operacional V1 (v3.4)

- Notificações são INFRAESTRUTURA: `notify()` verifica a ativação do módulo
  e não insere quando desligado — a operação que originou o evento nunca
  quebra por causa de notificações (testado).
- Anti-spam por construção: UNIQUE `(company_id, user_id, dedupe_key)` +
  INSERT OR IGNORE — um evento repetido gera 1 notificação (testado).
- `action_url` só aceita rotas internas (`#/...` ou `/...`); `javascript:`,
  protocol-relative e URLs externas são descartadas (persistidas como
  NULL — o evento não se perde).
- company_id dos 4 módulos SEMPRE da sessão (`req.auth.user.companyId`);
  vínculos opcionais sem FK preservam a entidade independente de módulos
  desativados ou registros excluídos.

## Camada comercial SaaS (v3.3)

- Financeiro SaaS é de **plataforma**: `router.use(requireMaster)` herda
  `company_id NULL`; usuário tenant recebe 403 mesmo com permissões de
  admin do próprio tenant. Permissões finas `platform.billing.view/manage`.
- Comprovante de pagamento validado por **magic bytes** (PNG/JPEG/PDF),
  nunca SVG/HTML; servido com `X-Content-Type-Options: nosniff`,
  `Content-Disposition: inline` e cache privado.
- Registro de pagamento é **transacional e idempotente**: guarda de status
  no UPDATE (`changes===1`) — dupla submissão/concorrência retorna 409 e
  nunca cria segundo histórico.
- Valores monetários em **centavos inteiros** em toda a camada.
- OVERDUE classificado pelo fuso da empresa (`core/businessDate`) — nunca
  `date('now')`/UTC silencioso. Próximos passos antes de produção: HTTPS obrigatório, troca das senhas
de seed, agendamento de backups, pentest no ambiente real.
