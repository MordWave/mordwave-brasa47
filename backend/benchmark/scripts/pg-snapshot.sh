#!/bin/sh
# READ-ONLY Postgres snapshot (sql/pg-observability.sql) of the BENCHMARK database via its TCP proxy.
#   RUN_ID=l1-a LABEL=before PSQL=... sh benchmark/scripts/pg-snapshot.sh   -> benchmark/.out/<RUN_ID>-pg-<LABEL>.txt
set -u
if [ "${1:-}" = "--inner" ]; then
  [ "${RAILWAY_ENVIRONMENT_NAME:-}" = "benchmark" ] || { echo "ABORT: RAILWAY_ENVIRONMENT_NAME != benchmark"; exit 1; }
  . "$(dirname "$0")/_public-url.sh"
  [ -n "${DATABASE_PUBLIC_URL:-}" ] || { echo "ABORT: no proxy URL"; exit 1; }
  case "$DATABASE_PUBLIC_URL" in *.rlwy.net:*) ;; *) echo "ABORT: host is not *.rlwy.net"; exit 1 ;; esac
  export PGOPTIONS="-c default_transaction_read_only=on"
  out="benchmark/.out/${RUN_ID:-run}-pg-${LABEL:-snap}.txt"
  { date -u +%FT%TZ; "${PSQL:-psql}" "$DATABASE_PUBLIC_URL" -X -A -F ' | ' -f benchmark/sql/pg-observability.sql; } > "$out" 2>&1
  echo "wrote $out"
  exit 0
fi
cd "$(dirname "$0")/../.." || exit 1   # backend/
exec railway run -s Postgres -e benchmark -- sh benchmark/scripts/pg-snapshot.sh --inner
