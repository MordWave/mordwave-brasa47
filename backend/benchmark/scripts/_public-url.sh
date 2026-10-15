# Sourced by the benchmark scripts, inside `railway run -s Postgres -e benchmark`.
# The benchmark Postgres template exposes the proxy as RAILWAY_TCP_PROXY_DOMAIN/PORT but not as
# DATABASE_PUBLIC_URL, so build it here, in-process. Never echo it.
if [ -z "${DATABASE_PUBLIC_URL:-}" ] && [ -n "${RAILWAY_TCP_PROXY_DOMAIN:-}" ] && [ -n "${RAILWAY_TCP_PROXY_PORT:-}" ]; then
  _host="${RAILWAY_TCP_PROXY_DOMAIN%.}"
  DATABASE_PUBLIC_URL="postgresql://${PGUSER}:${PGPASSWORD}@${_host}:${RAILWAY_TCP_PROXY_PORT}/${PGDATABASE}"
  unset _host
fi
