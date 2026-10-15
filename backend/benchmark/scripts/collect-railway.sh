#!/bin/sh
# Snapshots Railway metrics (CPU/RAM/network/HTTP latency+status) and error counts for the benchmark
# environment into benchmark/.out/railway-<RUN_ID>-*.{json,txt}. Read-only; explicit -e benchmark everywhere.
#
#   sh benchmark/scripts/collect-railway.sh l1-a 25     # run id, minutes of window
set -u
run="${1:?run id}"; mins="${2:?window minutes}"
cd "$(dirname "$0")/../.." || exit 1   # backend/
mkdir -p benchmark/.out
for svc in bench-backend Postgres; do
  railway metrics -s "$svc" -e benchmark --since "${mins}m" --json > "benchmark/.out/railway-$run-$svc.json" 2>/dev/null
  railway metrics -s "$svc" -e benchmark --since "${mins}m" > "benchmark/.out/railway-$run-$svc.txt" 2>&1
done
railway deployment list -s bench-backend -e benchmark > "benchmark/.out/railway-$run-deployments.txt" 2>&1
dep=$(railway deployment list -s bench-backend -e benchmark 2>/dev/null | sed -n 2p | awk '{print $1}')
if [ -n "$dep" ]; then
  railway logs -s bench-backend -e benchmark --deployment "$dep" > "benchmark/.out/railway-$run-backend.log" 2>&1
  printf 'backend log lines=%s errors=%s pool/timeouts=%s\n' \
    "$(wc -l < "benchmark/.out/railway-$run-backend.log")" \
    "$(grep -ciE 'error|exception' "benchmark/.out/railway-$run-backend.log")" \
    "$(grep -ciE 'timeout|too many clients|connection terminated' "benchmark/.out/railway-$run-backend.log")"
fi
echo "saved to benchmark/.out/railway-$run-*"
