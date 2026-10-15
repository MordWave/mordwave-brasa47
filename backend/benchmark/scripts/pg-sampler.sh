#!/bin/sh
# Samples Postgres every INTERVAL seconds (default 5) for DURATION seconds into
# benchmark/.out/pg-<RUN_ID>.csv. READ-ONLY session. Needs the benchmark TCP proxy (opened by the user)
# and psql >= 17 (libpq keg: PSQL=$(brew --prefix libpq)/bin/psql).
#
#   RUN_ID=l1-a DURATION=1200 sh benchmark/scripts/pg-sampler.sh
set -u
if [ "${1:-}" = "--inner" ]; then
  [ "${RAILWAY_ENVIRONMENT_NAME:-}" = "benchmark" ] || { echo "ABORT: RAILWAY_ENVIRONMENT_NAME != benchmark"; exit 1; }
  . "$(dirname "$0")/_public-url.sh"
  [ -n "${DATABASE_PUBLIC_URL:-}" ] || { echo "ABORT: no DATABASE_PUBLIC_URL (is the benchmark TCP proxy open?)"; exit 1; }
  case "$DATABASE_PUBLIC_URL" in *.rlwy.net:*) ;; *) echo "ABORT: host is not *.rlwy.net"; exit 1 ;; esac
  PSQL="${PSQL:-psql}"
  export PGOPTIONS="-c default_transaction_read_only=on"
  out="benchmark/.out/pg-${RUN_ID:-run}.csv"
  mkdir -p benchmark/.out
  echo "ts,total,active,idle,idle_in_tx,waiting_lock,max_conn,xact_commit,xact_rollback,blks_hit,blks_read,deadlocks,db_mb" > "$out"
  end=$(( $(date +%s) + ${DURATION:-600} ))
  while [ "$(date +%s)" -lt "$end" ] && [ ! -f "benchmark/.out/${RUN_ID:-run}.stop" ]; do
    "$PSQL" "$DATABASE_PUBLIC_URL" -X -At -F, -f benchmark/sql/pg-sample.sql >> "$out" 2>/dev/null || echo "sample failed" >&2
    sleep "${INTERVAL:-5}"
  done
  echo "wrote $out ($(wc -l < "$out") lines)"
  exit 0
fi
cd "$(dirname "$0")/../.." || exit 1   # backend/
exec railway run -s Postgres -e benchmark -- sh benchmark/scripts/pg-sampler.sh --inner
