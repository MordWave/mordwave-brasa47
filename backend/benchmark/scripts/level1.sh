#!/bin/sh
# Level 1 orchestration (benchmark env only), public endpoint, local k6:
#   ramp 3 min + hold 15 min (inside k6) + RECOVERY_SEC (default 180 s) of observation with no load.
# Runs in parallel: pg-sampler.sh (Postgres, via the benchmark TCP proxy) and watchdog.sh (hard aborts).
# Phase timestamps -> benchmark/.out/<RUN_ID>-phases.txt.
set -u
cd "$(dirname "$0")/../.." || exit 1   # backend/
run="${RUN_ID:-l1-a}"; rec="${RECOVERY_SEC:-180}"; pre="${PRE_SEC:-300}"
: "${BASE_URL:?}"
case "$BASE_URL" in *bench-backend*) ;; *) echo "ABORT: BASE_URL must be the benchmark backend"; exit 1 ;; esac
out=benchmark/.out; log="$out/$run-phases.txt"; mkdir -p "$out"; : > "$log"
stamp() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$1" | tee -a "$log"; }

total=$(( pre + 18 * 60 + rec + 180 ))
RUN_ID="$run" DURATION="$total" INTERVAL=5 sh benchmark/scripts/pg-sampler.sh > "$out/$run-sampler.log" 2>&1 &
sampler=$!
RUN_ID="$run" sh benchmark/scripts/watchdog.sh > "$out/$run-watchdog.out" 2>&1 &
wd=$!
stamp "phase=pre_begin (${pre} s idle observation before the ramp)"
end=$(( $(date +%s) + pre )); while [ "$(date +%s)" -lt "$end" ]; do sleep 5; done
stamp "phase=k6_begin (setup login, then 3 min ramp + 15 min hold)"
RUN_ID="$run" sh benchmark/scripts/run-k6.sh 1 > "$out/$run-k6.log" 2>&1
code=$?
stamp "phase=k6_end exit=$code"
if [ -f "$out/$run.ABORT" ]; then stamp "ABORTED by watchdog: $(cat "$out/$run.ABORT")"; fi
stamp "phase=recovery_begin ($rec s without load)"
end=$(( $(date +%s) + rec )); while [ "$(date +%s)" -lt "$end" ]; do sleep 5; done
stamp "phase=recovery_end"
touch "$out/$run.stop"
sleep 3
wait "$sampler" 2>/dev/null
stamp "phase=done"
