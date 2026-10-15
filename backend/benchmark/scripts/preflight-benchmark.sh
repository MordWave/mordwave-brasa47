#!/bin/sh
# READ-ONLY identity + emptiness check of the benchmark Postgres, via its TCP proxy.
# Prints no credentials (host, port, database, counts only).
set -u
if [ "${1:-}" = "--inner" ]; then
  [ "${RAILWAY_ENVIRONMENT_NAME:-}" = "benchmark" ] || { echo "ABORT: RAILWAY_ENVIRONMENT_NAME != benchmark"; exit 1; }
  . "$(dirname "$0")/_public-url.sh"
  [ -n "${DATABASE_PUBLIC_URL:-}" ] || { echo "ABORT: no proxy URL (is the benchmark TCP proxy open?)"; exit 1; }
  case "$DATABASE_PUBLIC_URL" in *.rlwy.net:*) ;; *) echo "ABORT: host is not *.rlwy.net"; exit 1 ;; esac
  case "$DATABASE_PUBLIC_URL" in *supabase*) echo "ABORT: looks like Supabase"; exit 1 ;; esac
  echo "environment=$RAILWAY_ENVIRONMENT_NAME service=${RAILWAY_SERVICE_NAME:-?} proxy_host=${RAILWAY_TCP_PROXY_DOMAIN%.} proxy_port=${RAILWAY_TCP_PROXY_PORT}"
  export PGOPTIONS="-c default_transaction_read_only=on"
  "${PSQL:-psql}" "$DATABASE_PUBLIC_URL" -X -At -F' | ' <<'SQL'
select 'database', current_database();
select 'server_version', current_setting('server_version');
select 'read_only_session', current_setting('default_transaction_read_only');
select 'max_connections', current_setting('max_connections');
select 'tables_in_public', count(*) from information_schema.tables where table_schema = 'public';
select 'migrations_table', coalesce(to_regclass('public.migrations')::text, 'absent');
select 'system_identifier', system_identifier from pg_control_system();
SQL
  exit 0
fi
cd "$(dirname "$0")/../.." || exit 1   # backend/
exec railway run -s Postgres -e benchmark -- sh benchmark/scripts/preflight-benchmark.sh --inner
