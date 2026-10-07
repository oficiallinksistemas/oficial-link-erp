#!/usr/bin/env bash
# ==============================================================================
# SMOKE TEST — Oficial Link ERP no Cloudflare (D1 local + Wrangler dev)
# Executar em uma máquina real (o runtime workerd não roda em sandboxes
# sem suporte a unix sockets — em máquina normal funciona direto).
#
# Uso:
#   npm install
#   node node_modules/wrangler/bin/wrangler.js d1 execute oficial-link-erp \
#     --local --file=d1/snapshot.sql
#   node node_modules/wrangler/bin/wrangler.js dev --port 8787 &
#   sleep 5 && ./scripts/smoke-d1.sh
# ==============================================================================
set -euo pipefail
BASE="${BASE:-http://localhost:8787}"
PASS=0; FAIL=0

check() { # nome, condicao
  if eval "$2"; then echo "PASS  $1"; PASS=$((PASS+1));
  else echo "FAIL  $1"; FAIL=$((FAIL+1)); fi
}

echo "== 1. Health =="
H=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/health")
check "GET /api/health -> 200" "[ '$H' = 200 ]"

echo "== 2. Login Master (valida scrypt no workerd) =="
LOGIN=$(curl -s -c /tmp/smoke-cookies.txt -H 'Content-Type: application/json' \
  -d '{"email":"master@oficiallink.com.br","password":"Master@2026"}' \
  "$BASE/api/auth/login")
check "login master retorna session" "echo '$LOGIN' | grep -q session_token"

echo "== 3. Módulos do tenant (valida adapter D1 ponta a ponta) =="
M=$(curl -s -b /tmp/smoke-cookies.txt "$BASE/api/modules")
check "/api/modules retorna array" "echo '$M' | grep -q '\\['"

echo "== 4. Isolamento multi-tenant (IDOR A x B não executado aqui — requer 2 empresas seedadas; coberto pelos 258 testes clássicos)"

echo ""
echo "RESULTADO: $PASS passaram, $FAIL falharam"
exit $FAIL
