// Level definitions + thresholds (pure: no k6 imports).
//
// "1 restaurant" = 25 concurrent sessions at peak. Derivation (see README):
//   70 customers/day, ~25 % in the peak hour => ~17 arrivals/hour;
//   stay 45 min => Little's law: 17 x 45/60 = ~13 concurrent;
//   peak factor x2 => ~25 concurrent sessions.
//
// LEVELS 1-3 (commercial benchmark): PERSISTENT sessions. Every VU is one device that joins once, loads
// the menu once, polls /status every 12 s (5 requests/min per device) and is never recycled; concurrency
// is exactly 25 per restaurant. Detail views (2-6) and orders (70 % none / 25 % one / 5 % several) are
// packed into the ~18-minute window, i.e. ~2.5x their real per-minute rate (45 -> 18 min): documented
// conservative load. Do NOT extrapolate monthly cost from those one-off frequencies.
//
// LEVEL 4 (saturation): sessions churn (DWELL_MEAN_MIN stays, accelerated join/menu/order rates) on
// purpose, to find the first bottleneck. Its numbers are never used for cost.
import { MEAN_DETAILS_PER_SESSION, MEAN_ORDERS_PER_SESSION, POLL_SEC, REAL_DWELL_MIN, steadyRps } from './model.mjs';

// Level 4 only: mean stay of a churning session.
export const DWELL_MEAN_MIN = 6;
export const COMPRESSION = REAL_DWELL_MIN / DWELL_MEAN_MIN;
export const CONCURRENT_PER_RESTAURANT = 25;

export const LEVELS = {
  0: { name: 'baseline', kind: 'baseline', idleMin: 5, healthMin: 5 },
  1: { name: '1 restaurant', kind: 'sessions', restaurants: 1, rampMin: 3, holdMin: 15, adminPollers: 2, ipMode: 'public' },
  2: { name: '3-5 restaurants (5)', kind: 'sessions', restaurants: 5, rampMin: 3, holdMin: 15, adminPollers: 2, ipMode: 'header' },
  3: {
    name: '5-10 restaurants (10)',
    kind: 'sessions',
    restaurants: 10,
    rampMin: 3,
    holdMin: 20,
    adminPollers: 2,
    ipMode: 'header',
    spike: { restaurants: 3, factor: 3, startMin: 10, durMin: 2 },
  },
  4: { name: 'stress', kind: 'stress', restaurants: 10, steps: [1, 2, 4, 8, 16], stepMin: 3, rampSec: 30, ipMode: 'header' },
};

export const sessionsTotal = (level) => LEVELS[level].restaurants * CONCURRENT_PER_RESTAURANT;
// Level 4 base rate (churn model): level-3 sessions at DWELL_MEAN_MIN stays.
export const expectedBaseRps = (level) => steadyRps(sessionsTotal(level), DWELL_MEAN_MIN);

// Levels 1-3 (persistent sessions): expected average req/s during the hold, customers + admin.
export function expectedPersistentRps(level) {
  const cfg = LEVELS[level];
  const windowSec = (cfg.rampMin + cfg.holdMin) * 60;
  const sessions = sessionsTotal(level);
  const polls = (sessions * (60 / POLL_SEC)) / 60;
  const oneOffs = (sessions * (3 + MEAN_DETAILS_PER_SESSION + MEAN_ORDERS_PER_SESSION)) / windowSec;
  const admin = cfg.restaurants * cfg.adminPollers * (1 / 5 + 1 / 10);
  return { polls, oneOffs, admin, total: polls + oneOffs + admin };
}

// Latency budgets in ms, by scope. PUBLIC numbers are what k6 sees from the internet: they include the
// round trip to the backend region (level 0 measured ~361 ms p50 on /health, while Railway reported
// 1 ms server-side p50 - the difference is network, not server). Initial level-1 targets are
// "baseline + ~400 ms" (~800 ms) for normal endpoints and ~1.2 s for orders; they are guidance, not
// hard aborts. INTERNAL numbers (no public network) are far tighter. Override with -e P95_<ENDPOINT>=ms.
const BUDGET = {
  public: { status: 800, join: 800, categories: 800, products: 800, product_detail: 800, orders_create: 1200, orders_rush: 1200, admin_orders: 800, admin_tables: 800, health: 800 },
  // Level 2+ targets (approved after Level 1; soft, never an abort): status 30, join/categories/detail/admin 50, products 60, orders 250.
  internal: { status: 30, join: 50, categories: 50, products: 60, product_detail: 50, orders_create: 250, orders_rush: 250, admin_orders: 50, admin_tables: 50, health: 20 },
};

export function thresholdsFor({ scope, level, env = {} }) {
  const budgets = BUDGET[scope] ?? BUDGET.public;
  const hard = (threshold, delayAbortEval = '30s') => ({ threshold, abortOnFail: true, delayAbortEval });
  const t = {
    // HARD ABORTS (level 1+): >1 % 5xx, a sustained pattern of 429s, >1 % failed requests, any dropped iteration.
    // Plain thresholds report the stricter "zero" expectation without aborting.
    server_error_rate: level === 4 ? [hard('rate<0.05')] : [hard('rate<0.01')],
    server_errors: level === 4 ? [{ threshold: 'count<200', abortOnFail: true, delayAbortEval: '20s' }] : ['count==0'],
    rate_limited: level === 4 ? ['count>=0'] : ['count==0', hard('count<30')],
    http_req_failed: level === 4 ? [hard('rate<0.02')] : ['rate<0.005', hard('rate<0.01')],
    checks: ['rate>0.99'],
    dropped_iterations: level === 4 ? ['count>=0'] : [hard('count==0', '1s')],
  };
  for (const [endpoint, p95] of Object.entries(budgets)) {
    const limit = Number(env[`P95_${endpoint.toUpperCase()}`] ?? p95);
    // A threshold per endpoint is also what makes k6 print that sub-metric in the summary.
    t[`http_req_duration{endpoint:${endpoint}}`] = [`p(95)<${limit}`, `p(99)<${limit * 2.5}`];
    t[`http_reqs{endpoint:${endpoint}}`] = ['count>=0'];
    t[`http_req_failed{endpoint:${endpoint}}`] = ['rate>=0'];
    t[`rate_limited{endpoint:${endpoint}}`] = ['count>=0'];
    t[`server_errors{endpoint:${endpoint}}`] = ['count>=0'];
  }
  if (level === 4) {
    LEVELS[4].steps.forEach((_, i) => {
      t[`http_req_duration{step:${i + 1}}`] = ['p(50)<60000', 'p(95)<60000', 'p(99)<60000'];
      t[`http_reqs{step:${i + 1}}`] = ['count>=0'];
    });
    t['http_req_duration{endpoint:status}'] = [`p(95)<${budgets.status}`, hard('p(95)<3000')];
  }
  return t;
}
