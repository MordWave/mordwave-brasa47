#!/bin/sh
# Runs one of the benchmark node scripts (seed.mjs | reset.mjs | export-fixture.mjs) against the
# BENCHMARK Postgres through its TCP proxy.
#
#   BENCH_ADMIN_PASSWORD=... sh benchmark/scripts/bench-node.sh seed.mjs --businesses 1 --confirm
#   sh benchmark/scripts/bench-node.sh reset.mjs --orders
#
# Prerequisite: the USER has opened the TCP proxy of the benchmark Postgres service.
# This wrapper never opens/closes it, never prints the URL, and the node scripts add
# their own guards (environment name, host, marker, bench-* slugs only).
set -u
if [ "${1:-}" = "--inner" ]; then
  shift
  script="$1"; shift
  [ "${RAILWAY_ENVIRONMENT_NAME:-}" = "benchmark" ] || { echo "ABORT: RAILWAY_ENVIRONMENT_NAME != benchmark"; exit 1; }
  . "$(dirname "$0")/_public-url.sh"
  [ -n "${DATABASE_PUBLIC_URL:-}" ] || { echo "ABORT: no DATABASE_PUBLIC_URL (is the benchmark TCP proxy open?)"; exit 1; }
  case "$DATABASE_PUBLIC_URL" in *.rlwy.net:*) ;; *) echo "ABORT: host is not *.rlwy.net"; exit 1 ;; esac
  case "$DATABASE_PUBLIC_URL" in *supabase*) echo "ABORT: looks like Supabase"; exit 1 ;; esac
  export BENCH_DATABASE_URL="$DATABASE_PUBLIC_URL"
  unset DATABASE_URL DATABASE_PUBLIC_URL
  exec node "benchmark/$script" "$@"
fi
cd "$(dirname "$0")/../.." || exit 1   # backend/
exec railway run -s Postgres -e benchmark -- sh benchmark/scripts/bench-node.sh --inner "$@"
