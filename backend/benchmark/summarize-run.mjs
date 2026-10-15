#!/usr/bin/env node
// Offline report builder: k6 summary + Railway raw series (collect-run.mjs) + Postgres CSV (pg-sampler.sh).
//   node benchmark/summarize-run.mjs l1-a > benchmark/reports/l1-a.md
// Keeps the two latency views apart: "k6 / Internet" (client side, includes the network round trip)
// vs "Railway / server" (time spent inside the platform proxy + app). They are NOT interchangeable.
import { existsSync, readFileSync } from 'node:fs';

const run = process.argv[2];
if (!run) throw new Error('usage: summarize-run.mjs <RUN_ID>');
const level = Number(process.argv[3] ?? 1);
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const k6 = read(`benchmark/.out/summary-L${level}-${run}.json`);
const win = read(`benchmark/.out/railway/${run}-windows.json`);
const num = (x, d = 1) => (x === undefined || x === null || Number.isNaN(x) ? '-' : Number(x).toFixed(d));
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const max = (xs) => (xs.length ? Math.max(...xs) : NaN);
const EMPTY_HTTP = { total: 0, '2xx': 0, '4xx': 0, '5xx': 0, p50_ms: '-', p90_ms: '-', p95_ms: '-', p99_ms: '-' };
const out = [];
const p = (s = '') => out.push(s);

// ---- phases ----------------------------------------------------------------------------------
const phases = readFileSync(`benchmark/.out/${run}-phases.txt`, 'utf8').trim().split('\n');
p(`# Informe Nivel ${level} — run \`${run}\``);
p();
p('## Fases');
p('```');
phases.forEach((l) => p(l));
p('```');
for (const f of [`benchmark/.out/${run}.ABORT`]) if (existsSync(f)) p(`**ABORTADO**: ${readFileSync(f, 'utf8').trim()}`);

// ---- k6 (Internet) ---------------------------------------------------------------------------
const m = k6.metrics;
const dur = (k6.state?.testRunDurationMs ?? 0) / 1000;
const v = (name, stat) => m[name]?.values?.[stat];
p();
p('## 1. Latencia observada por k6 desde Internet (incluye red; NO es tiempo del servidor)');
p(`Duración de la prueba: ${num(dur, 0)} s · peticiones: ${v('http_reqs', 'count')} · promedio ${num(v('http_reqs', 'rate'), 2)} req/s · checks ${num((v('checks', 'rate') ?? 0) * 100, 2)} % · iteraciones ${v('iterations', 'count') ?? '-'} · dropped ${v('dropped_iterations', 'count') ?? 0}`);
p();
p('| Endpoint | req | req/s | p50 ms | p95 ms | p99 ms | máx ms | errores | 429 | 5xx |');
p('|---|---|---|---|---|---|---|---|---|---|');
const endpoints = ['join', 'categories', 'products', 'product_detail', 'status', 'orders_create', 'orders_rush', 'admin_orders', 'admin_tables', 'health'];
for (const e of endpoints) {
  const key = `http_req_duration{endpoint:${e}}`;
  const n = v(`http_reqs{endpoint:${e}}`, 'count');
  if (!n) continue;
  p(`| ${e} | ${n} | ${num(n / dur, 2)} | ${num(v(key, 'med'))} | ${num(v(key, 'p(95)'))} | ${num(v(key, 'p(99)'))} | ${num(v(key, 'max'))} | ${v(`http_req_failed{endpoint:${e}}`, 'passes') ?? 0} | ${v(`rate_limited{endpoint:${e}}`, 'count') ?? 0} | ${v(`server_errors{endpoint:${e}}`, 'count') ?? 0} |`);
}
p();
p(`Total: 429 = ${v('rate_limited', 'count') ?? 0} · 5xx/transporte = ${v('server_errors', 'count') ?? 0} · http_req_failed = ${num((v('http_req_failed', 'rate') ?? 0) * 100, 3)} %`);
p();
p('Umbrales de k6:');
for (const [name, metric] of Object.entries(m)) {
  for (const [expr, res] of Object.entries(metric.thresholds ?? {})) {
    if (/>=0$|rate>=0/.test(expr)) continue;
    p(`- ${res.ok ? 'OK ' : 'FALLA'} \`${name}\` ${expr}`);
  }
}

// ---- Railway HTTP (servidor) ------------------------------------------------------------------
p();
p('## 2. Latencia reportada por Railway (lado servidor)');
p();
p('| Ventana | req | 2xx | 4xx | 5xx | p50 ms | p90 ms | p95 ms | p99 ms |');
p('|---|---|---|---|---|---|---|---|---|');
for (const ph of ['pre', 'ramp', 'hold', 'post']) {
  const f = `benchmark/.out/railway/${run}-http-${ph}.json`;
  if (!existsSync(f)) continue;
  const h = read(f).http ?? EMPTY_HTTP;
  p(`| ${ph} | ${h.total} | ${h['2xx']} | ${h['4xx']} | ${h['5xx']} | ${h.p50_ms} | ${h.p90_ms} | ${h.p95_ms} | ${h.p99_ms} |`);
}
p();
p('Por endpoint durante toda la carga (rampa + meseta), Railway junto a lo visto por k6 en esos mismos endpoints:');
p();
p('| Endpoint | Railway req | Railway p50 | p95 | p99 | k6 p50 | k6 p95 | k6 p99 | diferencia p50 (≈ red) |');
p('|---|---|---|---|---|---|---|---|---|');
for (const e of ['join', 'status', 'categories', 'products', 'orders_create', 'admin_orders', 'admin_tables']) {
  const f = `benchmark/.out/railway/${run}-http-run-${e}.json`;
  if (!existsSync(f)) continue;
  const h = read(f).http ?? EMPTY_HTTP;
  const key = `http_req_duration{endpoint:${e}}`;
  p(`| ${e} | ${h.total} | ${h.p50_ms} | ${h.p95_ms} | ${h.p99_ms} | ${num(v(key, 'med'))} | ${num(v(key, 'p(95)'))} | ${num(v(key, 'p(99)'))} | ${num(v(key, 'med') - h.p50_ms, 0)} ms |`);
}

// ---- recursos ---------------------------------------------------------------------------------
function series(svc) {
  const d = read(`benchmark/.out/railway/${run}-${svc}-raw.json`).measurements;
  return Object.fromEntries(Object.entries(d).map(([k, pts]) => [k, pts.map((x) => ({ t: Date.parse(x.ts), v: x.value }))]));
}
const between = (pts, [a, b]) => pts.filter((x) => x.t >= Date.parse(a) && x.t < Date.parse(b));
p();
p('## 3. Recursos (Railway, serie de 30 s)');
p();
p('| Servicio | Fase | CPU prom (vCPU) | CPU máx | RAM prom (MB) | RAM máx | Σ RX (MB) | Σ TX (MB) |');
p('|---|---|---|---|---|---|---|---|');
const svcs = { 'bench-backend': series('bench-backend'), Postgres: series('Postgres') };
for (const [svc, s] of Object.entries(svcs)) {
  for (const ph of ['pre', 'ramp', 'hold', 'post']) {
    const cpu = between(s.CPU_USAGE, win[ph]).map((x) => x.v);
    const mem = between(s.MEMORY_USAGE_GB, win[ph]).map((x) => x.v * 1024);
    const rx = between(s.NETWORK_RX_GB, win[ph]).map((x) => x.v * 1024);
    const tx = between(s.NETWORK_TX_GB, win[ph]).map((x) => x.v * 1024);
    p(`| ${svc} | ${ph} | ${num(avg(cpu), 4)} | ${num(max(cpu), 4)} | ${num(avg(mem), 0)} | ${num(max(mem), 0)} | ${num(rx.reduce((a, b) => a + b, 0), 2)} | ${num(tx.reduce((a, b) => a + b, 0), 2)} |`);
  }
}
p();
p('_Límites: CPU 2 vCPU · RAM 1024 MB por servicio. Σ RX/TX = suma de las muestras de 30 s (incrementos por intervalo)._');

// ---- volumen ----------------------------------------------------------------------------------
// Railway's DISK_USAGE series flips between two readings (a "low" band ~105-110 MB and a "high" band
// ~213 MB, about 2x) every 30-90 s, independently of load. Both bands are reported; the trend is what matters.
const disk = svcs.Postgres.DISK_USAGE_GB.map((x) => ({ t: x.t, mb: x.v * 1024 }));
const bandAt = (iso, half = 90_000) => {
  const t = Date.parse(iso);
  const pts = disk.filter((x) => Math.abs(x.t - t) <= half).map((x) => x.mb);
  const low = pts.filter((x) => x < 160);
  const high = pts.filter((x) => x >= 160);
  return `${low.length ? num(max(low)) : '-'} / ${high.length ? num(max(high)) : '-'}`;
};
p();
p('## 4. Volumen de Postgres (MB; límite 500 MB)');
p();
p('| Momento | banda baja / banda alta |');
p('|---|---|');
p(`| 10 min antes del inicio | ${bandAt(win.whole[0], 150_000)} |`);
p(`| inicio (antes de la rampa) | ${bandAt(win.ramp[0])} |`);
p(`| fin de la meseta | ${bandAt(win.hold[1])} |`);
p(`| 3 min después | ${bandAt(win.post[1])} |`);
const lows = disk.filter((x) => x.mb < 160).map((x) => x.mb);
const highs = disk.filter((x) => x.mb >= 160).map((x) => x.mb);
p();
p(`Serie completa (${disk.length} puntos de 30 s): banda baja ${num(Math.min(...lows))}–${num(max(lows))} MB · banda alta ${num(Math.min(...highs))}–${num(max(highs))} MB.`);

// ---- Postgres CSV ------------------------------------------------------------------------------
const csvPath = `benchmark/.out/pg-${run}.csv`;
if (existsSync(csvPath)) {
  const [head, ...lines] = readFileSync(csvPath, 'utf8').trim().split('\n');
  const cols = head.split(',');
  const rows = lines.map((l) => Object.fromEntries(l.split(',').map((x, i) => [cols[i], x])));
  const ts = (r) => Date.parse(r.ts.replace(' ', 'T').replace(/\+00$/, 'Z'));
  p();
  p('## 5. PostgreSQL (muestreo cada 5 s por el TCP Proxy)');
  p();
  p('| Fase | muestras | conexiones tot prom/máx | activas prom/máx | idle prom/máx | idle in tx máx | esperas lock máx | commits Δ | rollbacks Δ | deadlocks Δ | cache hit % |');
  p('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const ph of ['pre', 'ramp', 'hold', 'post']) {
    const r = rows.filter((x) => ts(x) >= Date.parse(win[ph][0]) && ts(x) < Date.parse(win[ph][1]));
    if (!r.length) continue;
    const col = (c) => r.map((x) => Number(x[c]));
    const delta = (c) => col(c).at(-1) - col(c)[0];
    const hit = delta('blks_hit');
    const rd = delta('blks_read');
    p(`| ${ph} | ${r.length} | ${num(avg(col('total')), 1)} / ${max(col('total'))} | ${num(avg(col('active')), 1)} / ${max(col('active'))} | ${num(avg(col('idle')), 1)} / ${max(col('idle'))} | ${max(col('idle_in_tx'))} | ${max(col('waiting_lock'))} | ${delta('xact_commit')} | ${delta('xact_rollback')} | ${delta('deadlocks')} | ${num((100 * hit) / Math.max(1, hit + rd), 2)} |`);
  }
  p();
  p(`Tamaño lógico de la BD: ${rows[0].db_mb} → ${rows.at(-1).db_mb} MB · max_connections ${rows[0].max_conn}.`);
}

// ---- watchdog ----------------------------------------------------------------------------------
const wd = `benchmark/.out/${run}-watchdog.log`;
if (existsSync(wd)) {
  const lines = readFileSync(wd, 'utf8').trim().split('\n');
  const grab = (svc, key) => lines.filter((l) => l.includes(` ${svc} `)).map((l) => Number(l.match(new RegExp(`${key}=([0-9.]+)`))?.[1])).filter((x) => !Number.isNaN(x));
  p();
  p('## 6. Vigilante de aborto');
  p(`- bench-backend: CPU % máx ${num(max(grab('bench-backend', 'cpu_pct')))} · RAM MB máx ${num(max(grab('bench-backend', 'mem_mb')), 0)}`);
  p(`- Postgres: CPU % máx ${num(max(grab('Postgres', 'cpu_pct')))} · RAM MB máx ${num(max(grab('Postgres', 'mem_mb')), 0)}`);
  const errs = lines.filter((l) => l.includes('backend_log_error_lines=')).map((l) => Number(l.split('=').pop()));
  p(`- líneas de error de pool/conexión/timeout en el log del backend: máx ${max(errs)}`);
}
console.log(out.join('\n'));
