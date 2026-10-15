#!/bin/sh
# Variables (set on the bench-runner service in the benchmark environment):
#   BACKEND_HOST             bench-backend.railway.internal           (private name; must contain "bench-backend")
#   BACKEND_PORT             optional; if unset the port is probed (8080, 3000, 8000, 5000)
#   BENCH_DATABASE_URL       reference to the benchmark Postgres private URL (read-only use: export-fixture)
#   BENCH_ADMIN_PASSWORD     same value used when seeding
#   RUN_LEVEL                smoke | 2 | 3 | 4   (empty => do nothing, just idle)
#   RUN_ID                   free label, e.g. l2-smoke
# Each deploy runs ONE thing, prints the summary to the logs, then idles (so the container is not restarted).
set -u
idle() { echo "$1"; exec sleep infinity; }
[ "${RAILWAY_ENVIRONMENT_NAME:-}" = "benchmark" ] || idle "ABORT: RAILWAY_ENVIRONMENT_NAME != benchmark"
case "${BACKEND_HOST:-}" in *bench-backend*) ;; *) idle "ABORT: BACKEND_HOST must be the benchmark backend" ;; esac
[ -n "${RUN_LEVEL:-}" ] || idle "RUN_LEVEL empty: idle (runner ready)."

port="${BACKEND_PORT:-}"
if [ -z "$port" ]; then
  for p in 8080 3000 8000 5000; do
    if node -e "fetch('http://$BACKEND_HOST:$p/health',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then port=$p; break; fi
  done
fi
[ -n "$port" ] || idle "ABORT: could not reach $BACKEND_HOST on any known port"
export BASE_URL="http://$BACKEND_HOST:$port"
echo "target: $BASE_URL (private network)  region: ${RAILWAY_REPLICA_REGION:-?}  run: ${RUN_ID:-$RUN_LEVEL}"

mkdir -p benchmark/.out
export FIXTURE=/app/benchmark/.out/fixture.json
node benchmark/export-fixture.mjs --out "$FIXTURE" || idle "fixture export failed"

smoke=0; level="$RUN_LEVEL"; script=customer-session.mjs
case "$RUN_LEVEL" in
  smoke) smoke=1; level=2 ;;
  4) script=stress-mix.mjs ;;
esac
if [ "$smoke" = 1 ]; then
  node benchmark/runner/ip-probe.mjs || echo "IPPROBE FAILED - not running the smoke"
fi
echo "=== k6 ${RUN_LEVEL} run ${RUN_ID:-$RUN_LEVEL} start $(date -u +%FT%TZ) ==="
k6 run -e BASE_URL="$BASE_URL" -e LEVEL="$level" -e SMOKE="$smoke" -e IP_MODE=header -e SCOPE=internal \
  -e RUN_ID="${RUN_ID:-L$RUN_LEVEL}" -e FIXTURE="$FIXTURE" \
  -e BENCH_ADMIN_PASSWORD="${BENCH_ADMIN_PASSWORD:-}" -e OUT_DIR=/app/benchmark/.out \
  "benchmark/k6/$script"
echo "=== k6 exit code $? end $(date -u +%FT%TZ) ==="
exec sleep infinity
