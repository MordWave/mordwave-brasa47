#!/usr/bin/env node
// Pulls the Railway side of a run (benchmark environment, read-only) into benchmark/.out/railway/<RUN_ID>-*.json,
// using the phase timestamps written by scripts/level1.sh. Always passes -e benchmark.
//   node benchmark/collect-run.mjs l1-a
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const run = process.argv[2];
if (!run) throw new Error('usage: collect-run.mjs <RUN_ID>');
const dir = 'benchmark/.out/railway';
mkdirSync(dir, { recursive: true });

const phases = readFileSync(`benchmark/.out/${run}-phases.txt`, 'utf8').split('\n');
const t0 = new Date(phases.find((l) => l.includes('phase=k6_begin')).split(' ')[0]);
const min = (n) => n * 60_000;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
const windows = {
  pre: [t0.getTime() - min(5), t0.getTime()],
  ramp: [t0.getTime(), t0.getTime() + min(3)],
  hold: [t0.getTime() + min(3), t0.getTime() + min(18)],
  post: [t0.getTime() + min(18), t0.getTime() + min(21)],
};
const whole = [t0.getTime() - min(10), t0.getTime() + min(22)];

function railway(args) {
  return execFileSync('railway', [...args, '-e', 'benchmark', '--json'], { encoding: 'utf8', timeout: 120_000 });
}
const save = (name, text) => writeFileSync(`${dir}/${run}-${name}.json`, text);

for (const svc of ['bench-backend', 'Postgres']) {
  save(`${svc}-raw`, railway(['metrics', '-s', svc, '--raw', '--since', iso(whole[0]), '--until', iso(whole[1])]));
}
for (const [name, [a, b]] of Object.entries(windows)) {
  save(`http-${name}`, railway(['metrics', '-s', 'bench-backend', '--http', '--since', iso(a), '--until', iso(b)]));
}
// server-side latency per endpoint over the whole load (ramp + hold), to set next to what k6 saw from the internet
const endpoints = {
  join: ['POST', '/table-sessions/join'],
  status: ['POST', '/table-sessions/status'],
  categories: ['GET', '/categories'],
  products: ['GET', '/products'],
  orders_create: ['POST', '/orders'],
  admin_orders: ['GET', '/orders/admin'],
  admin_tables: ['GET', '/tables/admin'],
};
const hs = windows.ramp[0];
const he = windows.hold[1];
for (const [name, [method, path]] of Object.entries(endpoints)) {
  save(`http-run-${name}`, railway(['metrics', '-s', 'bench-backend', '--http', '--method', method, '--path', path, '--since', iso(hs), '--until', iso(he)]));
}
writeFileSync(`${dir}/${run}-windows.json`, JSON.stringify(Object.fromEntries(Object.entries({ ...windows, whole }).map(([k, [a, b]]) => [k, [iso(a), iso(b)]])), null, 2));
console.log(`saved Railway data for ${run} in ${dir}`);
