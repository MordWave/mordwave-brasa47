#!/bin/sh
# Level 0 orchestration (benchmark env only): IDLE_MIN minutes of nothing, then HEALTH_MIN minutes of
# /health at 1 req/s with k6, while pg-sampler.sh records Postgres connections the whole time.
# Writes phase timestamps to benchmark/.out/l0-<RUN_ID>-phases.txt.
set -u
cd "$(dirname "$0")/../.." || exit 1   # backend/
run="${RUN_ID:-l0-a}"; idle="${IDLE_MIN:-5}"; health="${HEALTH_MIN:-5}"
: "${BASE_URL:?}"
case "$BASE_URL" in *bench-backend*) ;; *) echo "ABORT: BASE_URL must be the benchmark backend"; exit 1 ;; esac
log="benchmark/.out/l0-$run-phases.txt"; mkdir -p benchmark/.out
stamp() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$1" | tee -a "$log"; }

total=$(( (idle + health) * 60 + 30 ))
RUN_ID="$run" DURATION="$total" INTERVAL=5 sh benchmark/scripts/pg-sampler.sh > "benchmark/.out/l0-$run-sampler.log" 2>&1 &
sampler=$!
stamp "phase=start idle_min=$idle health_min=$health sampler_pid=$sampler"
sleep 5
stamp "phase=idle_begin"
end=$(( $(date +%s) + idle * 60 ))
while [ "$(date +%s)" -lt "$end" ]; do sleep 5; done
stamp "phase=idle_end"
stamp "phase=health_begin"
RUN_ID="$run" sh benchmark/scripts/run-k6.sh 0 > "benchmark/.out/l0-$run-k6.log" 2>&1
stamp "phase=health_end k6_exit=$?"
wait "$sampler"
stamp "phase=done"
