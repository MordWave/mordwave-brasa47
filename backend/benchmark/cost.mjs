#!/usr/bin/env node
// Turns measured usage into dollars, using Railway's published per-unit rates
// (https://docs.railway.com/pricing/plans; verify before budgeting - override with flags).
//
//   node benchmark/cost.mjs --minutes 20 \
//        --backend-vcpu 0.18 --backend-gb 0.14 --pg-vcpu 0.07 --pg-gb 0.10 --egress-gb 0.02 \
//        --idle-backend-vcpu 0.005 --idle-backend-gb 0.12 --idle-pg-vcpu 0.005 --idle-pg-gb 0.07 \
//        --restaurants 5 --duty 0.17
//
// vcpu/gb are AVERAGES over the load window (Railway "avg" column). --idle-* come from level 0.
// --duty = fraction of the month the system runs at that load (peak hours / 24; default 4/24).
import { parseArgs } from './lib/guards.mjs';

const a = parseArgs(process.argv.slice(2));
const num = (k, d = 0) => (a[k] === undefined ? d : Number(a[k]));
const rate = { cpuMin: num('rate-cpu-min', 0.000463), gbMin: num('rate-gb-min', 0.000231), egressGb: num('rate-egress-gb', 0.05) };
const monthMin = 43_200;

const minutes = num('minutes', 0);
const load = { vcpu: num('backend-vcpu') + num('pg-vcpu'), gb: num('backend-gb') + num('pg-gb') };
const idle = { vcpu: num('idle-backend-vcpu') + num('idle-pg-vcpu'), gb: num('idle-backend-gb') + num('idle-pg-gb') };
const usd = (vcpu, gb, min) => vcpu * min * rate.cpuMin + gb * min * rate.gbMin;

const testCost = usd(load.vcpu, load.gb, minutes) + num('egress-gb') * rate.egressGb;
const duty = num('duty', 4 / 24);
const restaurants = Math.max(1, num('restaurants', 1));
const month = {
  idle: usd(idle.vcpu, idle.gb, monthMin),
  loaded: usd(load.vcpu, load.gb, monthMin * duty) + usd(idle.vcpu, idle.gb, monthMin * (1 - duty)),
};
const marginal = (month.loaded - month.idle) / restaurants;
const f = (n) => `$${n.toFixed(2)}`;
console.log(`cost of this run (${minutes} min): ${f(testCost)}`);
console.log(`monthly, idle only:                 ${f(month.idle)}`);
console.log(`monthly, ${restaurants} restaurant(s) at duty ${(duty * 100).toFixed(0)}%: ${f(month.loaded)}`);
console.log(`marginal per restaurant per month:  ${f(marginal)}   (excludes volume, bucket, frontend service, seat/plan fees)`);
