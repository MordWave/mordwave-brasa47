// Run with:  node --test benchmark/test/
import assert from 'node:assert/strict';
import { isIP } from 'node:net';
import { test } from 'node:test';
import { buildBusiness } from '../lib/dataset.mjs';
import { assertTargetAllowed } from '../lib/guards.mjs';
import { CONCURRENT_PER_RESTAURANT, DWELL_MEAN_MIN, LEVELS, expectedBaseRps, expectedPersistentRps, thresholdsFor } from '../k6/lib/levels.mjs';
import {
  POLL_SEC,
  buildOrderPayload,
  buildTimeline,
  ordersForSlot,
  persistentSessionPlan,
  profileQuotas,
  logicalIp,
  mixWeights,
  mulberry32,
  requestsPerSession,
  sessionPlan,
  steadyRps,
  totalRequestsPerSession,
  uuid,
} from '../k6/lib/model.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('status polling is 5 requests/min per DEVICE (12 s interval)', () => {
  assert.equal(60 / POLL_SEC, 5);
});

test('per-sessionToken polling scales with devices at the table; the 60/min limit is reached at 12 devices', () => {
  const perDevice = 60 / POLL_SEC;
  assert.equal(perDevice * 12, 60);
  const devicesPerTable = CONCURRENT_PER_RESTAURANT / 10; // 25 sessions over 10 tables
  assert.equal(devicesPerTable * perDevice, 12.5); // far below 60
});

test('concurrency derivation: 17 arrivals/h x 45 min = ~13, x2 peak = ~25', () => {
  const real = (17 * 45) / 60;
  assert.ok(real > 12.5 && real < 13);
  assert.equal(CONCURRENT_PER_RESTAURANT, 25);
});

test('request mix: polls dominate, weights sum to 1', () => {
  const r = requestsPerSession(DWELL_MEAN_MIN);
  assert.equal(r.status, (DWELL_MEAN_MIN * 60) / POLL_SEC);
  const w = mixWeights(DWELL_MEAN_MIN);
  assert.ok(Math.abs(w.reduce((a, e) => a + e.weight, 0) - 1) < 1e-9);
  assert.ok(w.find((e) => e.action === 'status').weight > 0.8);
});

test('level 4 churn model: base rate scales with restaurants', () => {
  const l1 = expectedBaseRps(1);
  const l3 = expectedBaseRps(3);
  assert.ok(Math.abs(l3 / l1 - 10) < 1e-9);
  assert.equal(steadyRps(25, DWELL_MEAN_MIN), l1);
  assert.ok(totalRequestsPerSession(DWELL_MEAN_MIN) < totalRequestsPerSession(45));
});

test('levels 1-3 are persistent: polling is real-time, one-offs are small', () => {
  const l1 = expectedPersistentRps(1);
  assert.ok(Math.abs(l1.polls - (25 * 5) / 60) < 1e-9); // 25 devices x 5 req/min
  assert.ok(l1.total > 2.5 && l1.total < 3.2, `L1 ${l1.total}`);
  assert.ok(l1.oneOffs < 0.25); // join+menu once, 2-6 details, 0.375 orders per device over ~18 min
  assert.ok(Math.abs(expectedPersistentRps(3).polls / l1.polls - 10) < 1e-9);
});

test('persistent session plan: 2-6 details, 70/25/5 orders, everything inside the stay, no recycling', () => {
  const rng = mulberry32(2026);
  const duration = 18 * 60_000;
  const N = 20000;
  const orders = { 0: 0, 1: 0, many: 0 };
  let detailsMin = 99;
  let detailsMax = 0;
  for (let i = 0; i < N; i += 1) {
    const plan = persistentSessionPlan(rng, duration);
    detailsMin = Math.min(detailsMin, plan.details);
    detailsMax = Math.max(detailsMax, plan.details);
    assert.equal(plan.dwellMs, duration);
    assert.ok(plan.detailAt.every((t) => t >= 15_000 && t < duration));
    assert.ok(plan.orderAt.every((t) => t >= 0.2 * duration && t <= 0.9 * duration));
    orders[plan.orderAt.length === 0 ? 0 : plan.orderAt.length === 1 ? 1 : 'many'] += 1;
    for (const e of buildTimeline(rng, plan)) assert.ok(e.t < duration);
  }
  assert.equal(detailsMin, 2);
  assert.equal(detailsMax, 6);
  assert.ok(Math.abs(orders[0] / N - 0.7) < 0.02, `no-order share ${orders[0] / N}`);
  assert.ok(Math.abs(orders[1] / N - 0.25) < 0.02, `one-order share ${orders[1] / N}`);
  assert.ok(Math.abs(orders.many / N - 0.05) < 0.01, `multi-order share ${orders.many / N}`);
});

test('order payload satisfies the DTO limits', () => {
  const rng = mulberry32(42);
  const products = Array.from({ length: 50 }, () => ({ id: uuid(rng), removable: ['a', 'b'], addOns: ['x'] }));
  for (let i = 0; i < 500; i += 1) {
    const body = buildOrderPayload(rng, products, 'tok');
    assert.match(body.clientRequestId, UUID);
    assert.ok(body.items.length >= 1 && body.items.length <= 50);
    assert.ok((body.note ?? '').length <= 300);
    for (const it of body.items) {
      assert.match(it.productId, UUID);
      assert.ok(Number.isInteger(it.quantity) && it.quantity >= 1 && it.quantity <= 50);
      assert.ok((it.removed ?? []).length <= 20 && (it.added ?? []).length <= 20);
    }
    assert.equal(new Set(body.items.map((x) => x.productId)).size, body.items.length);
  }
});

test('timeline: sorted, polls every ~12 s, orders inside the stay', () => {
  const rng = mulberry32(7);
  const plan = sessionPlan(rng, DWELL_MEAN_MIN);
  const ev = buildTimeline(rng, plan);
  for (let i = 1; i < ev.length; i += 1) assert.ok(ev[i].t >= ev[i - 1].t);
  const polls = ev.filter((e) => e.type === 'status').length;
  assert.ok(Math.abs(polls - plan.dwellMs / 12000) <= 2);
  assert.ok(plan.orderAt.every((t) => t > 0 && t < plan.dwellMs));
});

test('logical IPs are valid and unique per restaurant', () => {
  const ips = Array.from({ length: 250 }, (_, i) => logicalIp(i));
  assert.equal(new Set(ips).size, 250);
  assert.ok(ips.every((ip) => isIP(ip) === 4));
});

test('dataset: N x 5 x 50 x 10, benchmark-labelled, unique tokens', () => {
  const b = buildBusiness(3, { categories: 5, products: 50, tables: 10, seed: 1 });
  assert.equal(b.slug, 'bench-03');
  assert.match(b.adminEmail, /@benchmark\.invalid$/);
  assert.equal(b.categories.length, 5);
  assert.equal(b.products.length, 50);
  assert.equal(b.tables.length, 10);
  assert.ok(b.products.every((p) => p.name.startsWith('[BENCH]')));
  const tokens = new Set(b.tables.flatMap((t) => [t.qrToken, t.sessionToken]));
  assert.equal(tokens.size, 20);
  assert.ok([...tokens].every((t) => /^[A-Za-z0-9_-]{32}$/.test(t)));
  assert.deepEqual(buildBusiness(3, { seed: 1 }).products, b.products); // deterministic
});

test('levels: shapes and IP modes', () => {
  assert.equal(LEVELS[1].ipMode, 'public');
  for (const l of [2, 3, 4]) assert.equal(LEVELS[l].ipMode, 'header');
  assert.equal(LEVELS[3].restaurants, 10);
  const t = thresholdsFor({ scope: 'public', level: 1, env: {} });
  assert.ok(t['http_req_duration{endpoint:status}']);
  assert.ok(t.rate_limited.includes('count==0'));
  assert.ok(t.rate_limited.some((x) => x.abortOnFail), '429 pattern is a hard abort');
  assert.ok(t.server_error_rate.some((x) => x.abortOnFail && x.threshold === 'rate<0.01'), '5xx > 1 % is a hard abort');
  assert.ok(t.dropped_iterations.some((x) => x.abortOnFail));
  assert.ok(t['http_req_duration{endpoint:orders_create}'][0].includes('1200'));
  assert.ok(t['rate_limited{endpoint:status}'] && t['server_errors{endpoint:status}']);
  const t4 = thresholdsFor({ scope: 'internal', level: 4, env: {} });
  assert.ok(t4['http_req_duration{step:5}']);
});

test('guards: refuse unsafe targets', () => {
  const env = (o) => ({ ...o });
  assert.throws(() => assertTargetAllowed(undefined, env({})), /BENCH_DATABASE_URL/);
  assert.throws(() => assertTargetAllowed('postgresql://u:p@db.supabase.co:5432/x', env({})), /Supabase/);
  assert.throws(() => assertTargetAllowed('postgresql://u:p@localhost:5432/x', env({})), /BENCH_ALLOW_LOCAL/);
  assert.throws(() => assertTargetAllowed('postgresql://u:p@a.proxy.rlwy.net:1/railway', env({ RAILWAY_ENVIRONMENT_NAME: 'production' })), /benchmark/);
  assert.throws(() => assertTargetAllowed('postgresql://u:p@a.proxy.rlwy.net:1/railway', env({})), /benchmark/);
  assert.throws(() => assertTargetAllowed('postgresql://u:p@example.com:1/railway', env({ RAILWAY_ENVIRONMENT_NAME: 'benchmark' })), /Railway/);
  assert.doesNotThrow(() => assertTargetAllowed('postgresql://u:p@a.proxy.rlwy.net:1/railway', env({ RAILWAY_ENVIRONMENT_NAME: 'benchmark' })));
  assert.doesNotThrow(() => assertTargetAllowed('postgresql://u:p@postgres.railway.internal:5432/railway', env({ RAILWAY_ENVIRONMENT_NAME: 'benchmark' })));
});

test('profile quotas: exact 70/25/5 split with largest remainder', () => {
  assert.deepEqual(profileQuotas(100), [70, 25, 5]);
  assert.deepEqual(profileQuotas(25), [18, 6, 1]);
  for (const n of [1, 7, 25, 50, 250]) assert.equal(profileQuotas(n).reduce((a, b) => a + b, 0), n);
  const rng = mulberry32(5);
  const per = Array.from({ length: 25 }, (_, slot) => ordersForSlot(rng, slot, 25));
  assert.equal(per.filter((x) => x === 0).length, 18);
  assert.equal(per.filter((x) => x === 1).length, 6);
  assert.equal(per.filter((x) => x >= 2).length, 1);
  assert.equal(persistentSessionPlan(rng, 600_000, 0).orderAt.length, 0);
  assert.equal(persistentSessionPlan(rng, 600_000, 2).orderAt.length, 2);
});
