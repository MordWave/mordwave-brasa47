// Levels 1-3: PERSISTENT customer sessions, one scenario group per restaurant.
//
//   k6 run -e LEVEL=1 -e BASE_URL=https://<bench-backend-public-domain> \
//          -e FIXTURE=benchmark/.out/fixture.json -e IP_MODE=public -e RUN_ID=l1-a benchmark/k6/customer-session.mjs
//
// MODEL (commercial benchmark, no churn): every VU is ONE device that stays for the whole test.
//   - join ONCE, categories + products ONCE (in parallel, like MenuView), then
//   - POST /table-sessions/status every 12 s with jitter (5 requests/min per device),
//   - 2-6 product-detail views spread over the session,
//   - 70 % never order, 25 % create one order, 5 % create 2-3 orders,
//   - the session is never recycled: the VU ends when the test ends.
// Devices arrive staggered over the ramp (rampMin), so the join/menu burst is spread, not simultaneous.
// Concurrency is therefore exactly 25 sessions per restaurant (the peak we want to measure), and the
// one-off requests (join, menu, details, orders) happen ONCE per device.
//
// COMPRESSION (documented, conservative): a real device stays ~45 min; the test window is ~18 min, so its
// detail views and orders are packed into that window (about 2.5x their real per-minute rate). That makes
// the one-off traffic and the order rate conservative. Never extrapolate monthly cost from the one-off
// request frequencies measured here; polling (the bulk of the traffic) is real-time and unbiased.
//
// `adminPoller` mimics the Admin screens (orders every 5 s, tables every ~10 s).
// `tableRush` fires 5 devices of ONE table ordering within the same second (once, mid-test).
// `spike` (level 3) adds short-lived extra devices for a few minutes to emulate a rush.
import { sleep } from 'k6';
import http from 'k6/http';
import exec from 'k6/execution';
import { BASE_URL, IP_MODE, RUN_ID, SCOPE, classifyBatch, get, ipHeaders, jsonOf, loadFixture, login, post, summaryFiles } from './lib/common.mjs';
import { CONCURRENT_PER_RESTAURANT, LEVELS, thresholdsFor } from './lib/levels.mjs';
import { buildOrderPayload, buildTimeline, mulberry32, ordersForSlot, persistentSessionPlan, pick } from './lib/model.mjs';

const LEVEL = Number(__ENV.LEVEL || 1);
// SMOKE=1: 1 restaurant, 5 devices, 2 minutes, level-2 rules (internal runner, X-Real-Ip). Used to take the
// internal baseline before the full level 2. Same code path as the real levels.
const SMOKE = __ENV.SMOKE === '1';
const cfg = SMOKE
  ? { ...LEVELS[2], name: 'smoke', restaurants: 1, vus: 5, totalSec: 120, rampSec: 20, rushAtSec: 60, adminPollers: 2 }
  : LEVELS[LEVEL];
if (!cfg || cfg.kind !== 'sessions') throw new Error(`customer-session.mjs runs levels 1-3 (got LEVEL=${LEVEL}).`);
if (cfg.ipMode !== IP_MODE) {
  throw new Error(`Level ${LEVEL} must run with IP_MODE=${cfg.ipMode} (got ${IP_MODE}). Single-IP runs of several restaurants would measure the rate limiter, not the app.`);
}

const fixture = loadFixture();
if (fixture.businesses.length < cfg.restaurants) {
  throw new Error(`Fixture has ${fixture.businesses.length} businesses, level ${LEVEL} needs ${cfg.restaurants}.`);
}

const TOTAL_SEC = SMOKE ? cfg.totalSec : (cfg.rampMin + cfg.holdMin) * 60;
const RAMP_SEC = SMOKE ? cfg.rampSec : cfg.rampMin * 60;
const DEVICES = SMOKE ? cfg.vus : CONCURRENT_PER_RESTAURANT;
const RUSH_AT = SMOKE ? `${cfg.rushAtSec}s` : `${cfg.rampMin + Math.floor(cfg.holdMin / 2)}m`;

function buildScenarios() {
  const scenarios = {};
  for (let i = 0; i < cfg.restaurants; i += 1) {
    scenarios[`sessions_r${i + 1}`] = {
      executor: 'per-vu-iterations',
      exec: 'customerSession',
      env: { BIZ_INDEX: String(i), SESSION_SEC: String(TOTAL_SEC), RAMP_SEC: String(RAMP_SEC), STRATIFY: '1', DEVICES: String(DEVICES) },
      vus: DEVICES,
      iterations: 1, // ONE session per VU, never restarted
      maxDuration: `${TOTAL_SEC + 120}s`,
    };
    scenarios[`admin_r${i + 1}`] = {
      executor: 'constant-vus',
      exec: 'adminPoller',
      env: { BIZ_INDEX: String(i) },
      vus: cfg.adminPollers,
      duration: `${TOTAL_SEC}s`,
      gracefulStop: '30s',
    };
    scenarios[`rush_r${i + 1}`] = {
      executor: 'per-vu-iterations',
      exec: 'tableRush',
      env: { BIZ_INDEX: String(i) },
      vus: 1,
      iterations: 1,
      startTime: RUSH_AT,
      maxDuration: '2m',
    };
  }
  if (cfg.spike) {
    const spikeSec = cfg.spike.durMin * 60;
    const extra = CONCURRENT_PER_RESTAURANT * (cfg.spike.factor - 1);
    for (let i = 0; i < Math.min(cfg.spike.restaurants, cfg.restaurants); i += 1) {
      scenarios[`spike_r${i + 1}`] = {
        executor: 'per-vu-iterations',
        exec: 'customerSession',
        env: { BIZ_INDEX: String(i), SESSION_SEC: String(spikeSec), RAMP_SEC: '20' },
        vus: extra,
        iterations: 1,
        startTime: `${cfg.spike.startMin}m`,
        maxDuration: `${spikeSec + 120}s`,
      };
    }
  }
  return scenarios;
}

export const options = {
  scenarios: buildScenarios(),
  thresholds: thresholdsFor({ scope: SCOPE, level: LEVEL, env: __ENV }),
  // (smoke and levels 2-3 run in the internal runner: scope=internal budgets apply)
  tags: { run: RUN_ID, level: String(LEVEL), scope: SCOPE },
  maxRedirects: 0, // this benchmark has no bucket/media: never follow a redirect off the backend
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
};

// One login per restaurant, before the load starts (login is limited to 5/min per IP:
// with IP_MODE=header each restaurant has its own bucket; in public mode there is only one).
export function setup() {
  const password = fixture.adminPassword || __ENV.BENCH_ADMIN_PASSWORD;
  if (!password) throw new Error('Admin password missing (fixture.adminPassword or BENCH_ADMIN_PASSWORD).');
  const tokens = [];
  for (let i = 0; i < cfg.restaurants; i += 1) {
    tokens.push(login(fixture.businesses[i], i, password));
    if (IP_MODE === 'public' && i < cfg.restaurants - 1) sleep(13);
  }
  if (tokens.some((t) => !t)) throw new Error('Admin login failed for at least one benchmark business.');
  return { tokens };
}

// One device = one iteration = the whole session.
export function customerSession() {
  const idx = Number(__ENV.BIZ_INDEX);
  const sessionSec = Number(__ENV.SESSION_SEC);
  const rampSec = Number(__ENV.RAMP_SEC);
  const biz = fixture.businesses[idx];
  const rng = mulberry32((exec.vu.idInTest + 1) * 7919 + idx * 104729);
  const opts = { businessIndex: idx };

  // Staggered arrival over the ramp; the session then lasts until the scenario's end.
  const arrival = rng() * rampSec;
  sleep(arrival);
  const startedAt = Date.now();
  const durationMs = Math.max(30_000, (sessionSec - arrival) * 1000);
  // Exact 70/25/5 quotas across the restaurant's devices (spike devices keep the random draw).
  const forced = __ENV.STRATIFY === '1' ? ordersForSlot(rng, exec.scenario.iterationInInstance, Number(__ENV.DEVICES || CONCURRENT_PER_RESTAURANT)) : undefined;
  const plan = persistentSessionPlan(rng, durationMs, forced);

  const table = biz.tables[exec.vu.idInTest % biz.tables.length]; // spreads devices over the 10 tables
  const joined = jsonOf(post('/table-sessions/join', { qrToken: table.qrToken }, 'join', 200, opts));
  if (!joined?.sessionToken) return;

  const q = `?businessSlug=${encodeURIComponent(joined.businessSlug)}`;
  // The app fires both menu reads in parallel (MenuView.jsx Promise.all).
  const [cats, prods] = http.batch([
    ['GET', `${BASE_URL}/categories${q}`, null, { tags: { endpoint: 'categories' }, headers: ipHeaders(idx) }],
    ['GET', `${BASE_URL}/products${q}`, null, { tags: { endpoint: 'products' }, headers: ipHeaders(idx) }],
  ]);
  classifyBatch([cats], 'categories', 200);
  classifyBatch([prods], 'products', 200);

  for (const ev of buildTimeline(rng, plan)) {
    const wait = startedAt + ev.t - Date.now();
    if (wait > 0) sleep(wait / 1000);
    if (ev.type === 'status') {
      post('/table-sessions/status', { sessionToken: joined.sessionToken }, 'status', 200, opts);
    } else if (ev.type === 'detail') {
      get(`/products/${pick(rng, biz.products).id}${q}`, 'product_detail', opts);
    } else {
      post('/orders', buildOrderPayload(rng, biz.products, joined.sessionToken), 'orders_create', 201, opts);
    }
  }
}

export function adminPoller(data) {
  const idx = Number(__ENV.BIZ_INDEX);
  const opts = { businessIndex: idx, token: data.tokens[idx] };
  const end = Date.now() + 60_000;
  let ticks = 0;
  while (Date.now() < end) {
    get('/orders/admin?status=NEW&limit=50', 'admin_orders', opts);
    if (ticks % 2 === 0) get('/tables/admin', 'admin_tables', opts); // ~every 10 s (real UI: 12 s)
    ticks += 1;
    sleep(5);
  }
}

// Five devices of the same table ordering together: stresses the per-table row locks
// (restaurant_tables + table_sessions FOR UPDATE) and the 10/min per-sessionToken limit.
export function tableRush() {
  const idx = Number(__ENV.BIZ_INDEX);
  const biz = fixture.businesses[idx];
  const rng = mulberry32(idx * 31 + 7);
  const table = biz.tables[0];
  const opts = { businessIndex: idx };
  const joined = jsonOf(post('/table-sessions/join', { qrToken: table.qrToken }, 'join', 200, opts));
  if (!joined?.sessionToken) return;
  const reqs = Array.from({ length: 5 }, () => [
    'POST',
    `${BASE_URL}/orders`,
    JSON.stringify(buildOrderPayload(rng, biz.products, joined.sessionToken)),
    { tags: { endpoint: 'orders_rush' }, headers: { 'Content-Type': 'application/json', ...ipHeaders(idx) } },
  ]);
  classifyBatch(http.batch(reqs), 'orders_rush', 201);
}

export function handleSummary(data) {
  return summaryFiles(data, LEVEL, SMOKE ? '-smoke' : '');
}
