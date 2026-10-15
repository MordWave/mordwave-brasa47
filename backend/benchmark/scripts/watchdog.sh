#!/bin/sh
# External hard-abort watchdog (things k6 cannot see). Polls Railway every INTERVAL s (default 30) and
# kills k6 when, for the BENCHMARK environment only:
#   - bench-backend CPU > 90 % of its limit for CPU_MIN consecutive minutes (default 2),
#   - bench-backend memory > 800 MB,
#   - Postgres CPU > 90 % sustained for CPU_MIN minutes,
#   - the Postgres volume reaches 400 MB (80 % of 500 MB),
#   - the backend log shows pool/connection/timeout errors (more than LOG_ERRORS, default 5, counting the one
#     normal startup line that mentions the pool timeout).
# STOP_RUNNER=1 also removes the bench-runner deployment (load generator inside Railway).
# Stops when benchmark/.out/<RUN_ID>.stop exists. Logs to benchmark/.out/<RUN_ID>-watchdog.log.
set -u
cd "$(dirname "$0")/../.." || exit 1   # backend/
run="${RUN_ID:?RUN_ID}"; every="${INTERVAL:-30}"; need=$(( ${CPU_MIN:-2} * 60 / every )); lim="${LOG_ERRORS:-5}"
out="benchmark/.out"; log="$out/$run-watchdog.log"; stopf="$out/$run.stop"; abortf="$out/$run.ABORT"
rm -f "$stopf" "$abortf"
breach_be=0; breach_pg=0
dep=$(railway deployment list -s bench-backend -e benchmark 2>/dev/null | sed -n 2p | awk '{print $1}')
echo "$(date -u +%FT%TZ) watchdog start run=$run every=${every}s need=$need consecutive checks, backend deployment=$dep" >> "$log"
abort() {
  echo "$(date -u +%FT%TZ) ABORT: $1" | tee -a "$log" > "$abortf"
  pkill -f "k6 run" 2>/dev/null
  # load generator inside Railway (bench-runner): remove its running deployment
  if [ "${STOP_RUNNER:-0}" = 1 ]; then railway down -s bench-runner -e benchmark -y >> "$log" 2>&1; fi
  exit 0
}
while [ ! -f "$stopf" ]; do
  for svc in bench-backend Postgres; do
    j=$(railway metrics -s "$svc" -e benchmark --cpu --memory --since 2m --json 2>/dev/null)
    vals=$(printf '%s' "$j" | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin); print('%.1f %.0f' % (d['cpu']['utilization_pct'], d['memory']['current_mb']))
except Exception: print('x x')")
    cpu=${vals% *}; mem=${vals#* }
    echo "$(date -u +%FT%TZ) $svc cpu_pct=$cpu mem_mb=$mem" >> "$log"
    [ "$cpu" = "x" ] && continue
    over=$(python3 -c "print(1 if float('$cpu') > 90 else 0)")
    if [ "$svc" = "bench-backend" ]; then
      if [ "$over" = 1 ]; then breach_be=$((breach_be + 1)); else breach_be=0; fi
      [ "$breach_be" -ge "$need" ] && abort "bench-backend CPU > 90 % for ${CPU_MIN:-2} min"
      python3 -c "import sys; sys.exit(0 if float('$mem') > 800 else 1)" && abort "bench-backend memory ${mem} MB > 800 MB"
    else
      if [ "$over" = 1 ]; then breach_pg=$((breach_pg + 1)); else breach_pg=0; fi
      [ "$breach_pg" -ge "$need" ] && abort "Postgres CPU > 90 % for ${CPU_MIN:-2} min"
    fi
  done
  # Postgres volume > 80 % of 500 MB (either reading of Railway's two-band DISK_USAGE series)
  disk=$(railway metrics -s Postgres -e benchmark --volume --raw --since 3m --json 2>/dev/null | python3 -c "
import sys,json
try:
    pts=json.load(sys.stdin)['measurements']['DISK_USAGE_GB']; print('%.0f' % (max(p['value'] for p in pts)*1024))
except Exception: print('x')")
  echo "$(date -u +%FT%TZ) postgres_volume_mb_max=$disk" >> "$log"
  [ "$disk" != "x" ] && [ "$disk" -ge 400 ] && abort "Postgres volume ${disk} MB >= 80 % of 500 MB"
  errs=$(railway logs -s bench-backend -e benchmark --deployment "$dep" 2>/dev/null | grep -ciE 'timeout|too many clients|connection terminated|ECONNRESET|ECONNREFUSED|pool')
  echo "$(date -u +%FT%TZ) backend_log_error_lines=$errs" >> "$log"
  [ "${errs:-0}" -gt "$lim" ] && abort "backend log has $errs pool/connection/timeout error lines (> $lim)"
  sleep "$every"
done
echo "$(date -u +%FT%TZ) watchdog stop (stop file)" >> "$log"
