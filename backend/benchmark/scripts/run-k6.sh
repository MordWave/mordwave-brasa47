#!/bin/sh
# Local k6 runner for levels 0 and 1 ONLY (levels 2-4 need distinct logical IPs and run inside the
# benchmark environment, see runner/README section in benchmark/README.md).
#
#   BASE_URL=https://<bench-backend-public-domain> RUN_ID=l1-a sh benchmark/scripts/run-k6.sh 1
set -u
level="${1:?level (0 or 1)}"
case "$level" in 0|1) ;; *) echo "Only levels 0 and 1 run locally."; exit 1 ;; esac
command -v k6 >/dev/null 2>&1 || { echo "k6 is not installed (brew install k6 - needs the user's OK)."; exit 1; }
: "${BASE_URL:?BASE_URL is required}"
case "$BASE_URL" in *bench-backend*) ;; *) echo "ABORT: BASE_URL must be the benchmark backend"; exit 1 ;; esac
cd "$(dirname "$0")/../.." || exit 1   # backend/
run="${RUN_ID:-L$level-$(date +%Y%m%d-%H%M%S)}"
script=customer-session.mjs; [ "$level" = 0 ] && script=baseline.mjs
# k6 open() resolves relative paths against the script directory, so always pass an absolute one.
fixture="${FIXTURE:-$PWD/benchmark/.out/fixture.json}"
exec k6 run \
  -e BASE_URL="$BASE_URL" -e LEVEL="$level" -e IP_MODE=public -e SCOPE=public -e RUN_ID="$run" -e FIXTURE="$fixture" \
  ${BENCH_ADMIN_PASSWORD:+-e BENCH_ADMIN_PASSWORD="$BENCH_ADMIN_PASSWORD"} \
  "benchmark/k6/$script"
