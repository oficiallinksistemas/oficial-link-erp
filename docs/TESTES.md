# Testes automatizados — Oficial Link ERP

Suíte **real e executável** (Node.js Test Runner). Cada arquivo sobe o servidor
em porta efêmera com banco SQLite temporário e exclusivo (helpers define
`DB_FILE` antes de qualquer require do `src/`).

## Como executar

```bash
cd server
npm test          # node --test tests/
```

## Resultado da última execução (v3.1 — personalização por empresa)

Contagem REAL (verificada no código, teste a teste — código = runner):

| Arquivo | Testes |
|---|---|
| auth.test.js | 11 |
| branding.test.js | 7 |
| consolidation.test.js | 9 |
| consolidation2.test.js | 5 |
| customers.test.js | 13 |
| master-global.test.js | 5 |
| master.test.js | 11 |
| payables.test.js | 14 |
| products.test.js | 13 |
| ranking.test.js | 10 |
| receivablePayload.test.js | 4 |
| receivables.test.js | 17 |
| sales.test.js | 11 |
| security-config.test.js | 11 |
| security.test.js | 12 |
| stock.test.js | 14 |
| targets.test.js | 12 |
| tenancy.test.js | 9 |
| v19.test.js | 15 |
| **TOTAL REAL** | **203** |

- **203 executados · 203 aprovados · 0 reprovados**
- 7 testes novos (branding.test.js, v3.1): CRUD de identidade + persistência +
  exposição no /me; validação de cores/nome/injeção; logo (PNG/JPEG por magic
  bytes, substituição, inválido, oversize, remoção); defaults/restauração;
  RBAC (vendedor/supervisor não editam, ambos veem a identidade); isolamento
  multi-tenant (B não lê nem altera; sessão é autoridade) e auditoria (falha
  não gera evento de sucesso).
- 17 em receivables.test.js (consolidação V3.0 incluída): integridade de
  amount/loja/cliente derivados da venda, imutabilidade do título SALE,
  proteção da venda com título, gating (módulo OFF mantém consistência de
  registro existente), auditoria real e fuso no relatório.

## Manutenção

- `require('./helpers')` SEMPRE antes de qualquer require do `src/`.
- Testes de helper frontend (receivablePayload) importam o ESM puro via
  caminho relativo `../../web/...` — o web/ precisa existir ao lado de server/.
