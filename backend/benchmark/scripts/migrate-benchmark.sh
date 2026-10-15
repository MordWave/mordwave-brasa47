#!/bin/sh
# Applies the repo's TypeORM migrations to the BENCHMARK Postgres (empty DB) via its TCP proxy.
# Same mechanism used for production migrations, pointed at the benchmark environment only.
# The USER opens the proxy first. Pass --show to only list migrations (read-only).
set -u
if [ "${1:-}" = "--inner" ]; then
  mode="${2:-run}"
  [ "${RAILWAY_ENVIRONMENT_NAME:-}" = "benchmark" ] || { echo "ABORT: RAILWAY_ENVIRONMENT_NAME != benchmark"; exit 1; }
  . "$(dirname "$0")/_public-url.sh"
  [ -n "${DATABASE_PUBLIC_URL:-}" ] || { echo "ABORT: no DATABASE_PUBLIC_URL (is the benchmark TCP proxy open?)"; exit 1; }
  case "$DATABASE_PUBLIC_URL" in *.rlwy.net:*) ;; *) echo "ABORT: host is not *.rlwy.net"; exit 1 ;; esac
  case "$DATABASE_PUBLIC_URL" in *supabase*) echo "ABORT: looks like Supabase"; exit 1 ;; esac
  export DATABASE_URL="$DATABASE_PUBLIC_URL"
  unset DATABASE_PUBLIC_URL
  if [ "$mode" = "show" ]; then
    export PGOPTIONS="-c default_transaction_read_only=on"
    npm run typeorm -- migration:show
  else
    npm run migration:run
  fi
  echo "exit: $?"
  exit 0
fi
cd "$(dirname "$0")/../.." || exit 1   # backend/
mode=run; [ "${1:-}" = "--show" ] && mode=show
exec railway run -s Postgres -e benchmark -- sh benchmark/scripts/migrate-benchmark.sh --inner "$mode"
