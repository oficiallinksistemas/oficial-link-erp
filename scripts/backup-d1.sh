#!/usr/bin/env bash
# ==============================================================================
# BACKUP / RESTORE — Cloudflare D1 (Oficial Link ERP)
#
# BACKUP (executar via cron/agendamento em máquina confiável, ex.: GitHub
# Actions ou cron local com wrangler autenticado):
#   ./scripts/backup-d1.sh            -> ./backups/d1-YYYY-MM-DD_HHMMSS.sql
#   DESTINO=R2  ./scripts/backup-d1.sh -> além do arquivo local, sobe para o
#                                         bucket R2 "oficial-link-backups"
#   RETENCAO_DIAS=30 (padrão) apaga dumps locais mais antigos.
#
# RESTORE (procedimento real, TESTAR em banco NOVO antes de qualquer
# necessidade real — passo "exercitar o restore" do go-live):
#   1) wrangler d1 create oficial-link-erp-restore   (anotar o database_id)
#   2) Editar wrangler.toml apontando database_id para o banco de restore
#      (ou usar --env restore com configuração duplicada)
#   3) node node_modules/wrangler/bin/wrangler.js d1 execute \
#        oficial-link-erp-restore --remote --file=backups/d1-XXXX.sql
#   4) Verificar contagens: users, companies, sales, stock_balances
#   5) Se for restore definitivo: trocar database_id no wrangler.toml de
#      produção e redeploy (`wrangler deploy`).
#
# R2: o upload usa `wrangler r2 object put` (sem dependências externas).
# Criar o bucket uma vez: wrangler r2 bucket create oficial-link-backups
# ==============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
WR="node node_modules/wrangler/bin/wrangler.js"
TS=$(date +%Y-%m-%d_%H%M%S)
OUT="backups/d1-${TS}.sql"
mkdir -p backups

echo "[backup] exportando D1 -> ${OUT}"
$WR d1 export oficial-link-erp --remote --output="$OUT"

if [ "${DESTINO:-}" = "R2" ]; then
  echo "[backup] enviando para R2 (oficial-link-backups)"
  $WR r2 object put "oficial-link-backups/d1/${OUT}" --file="$OUT"
fi

RET=${RETENCAO_DIAS:-30}
find backups -name 'd1-*.sql' -mtime +$RET -delete
echo "[backup] concluído: ${OUT} (retenção local ${RET}d)"
