// Pure workload model (no k6 imports) so it can be unit-tested with `node --test`.
// All the numbers that define "a realistic user" live here and in levels.mjs.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
export const between = (rng, lo, hi) => lo + rng() * (hi - lo);
export const intBetween = (rng, lo, hi) => Math.floor(between(rng, lo, hi + 1));

// RFC 4122 v4 shaped id (the backend validates with @IsUUID()).
export function uuid(rng) {
  const hex = (n) => Array.from({ length: n }, () => Math.floor(rng() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[Math.floor(rng() * 4)]}${hex(3)}-${hex(12)}`;
}

// One logical IP per restaurant (RFC 5737 documentation range, never routable).
// Used only in IP_MODE=header runs, to give each restaurant its own rate-limit
// buckets exactly like a real venue behind its own Wi-Fi.
export const logicalIp = (businessIndex) => `198.51.100.${(businessIndex % 250) + 1}`;

// ---- what one customer does -------------------------------------------------

export const POLL_SEC = 12; // src/pages/CustomerApp.jsx STATUS_POLL_MS = 12000  =>  5 requests/min per DEVICE
export const REAL_DWELL_MIN = 45;

// Share of sessions by number of orders (browse only / one order / several).
export const ORDER_PROFILE = [
  { weight: 0.7, orders: () => 0 },
  { weight: 0.25, orders: () => 1 },
  { weight: 0.05, orders: (rng) => intBetween(rng, 2, 3) },
];
export const MEAN_ORDERS_PER_SESSION = 0.7 * 0 + 0.25 * 1 + 0.05 * 2.5; // 0.375
export const MEAN_DETAILS_PER_SESSION = 4; // 2..6 views, mean 4

function ordersForSession(rng) {
  const roll = rng();
  let acc = 0;
  for (const p of ORDER_PROFILE) {
    acc += p.weight;
    if (roll <= acc) return p.orders(rng);
  }
  return 0;
}

// PERSISTENT session (levels 1-3): one device stays for `durationMs`, never recycled.
// Detail views (2-6) and orders are spread over the stay. When durationMs is shorter than a real stay
// (45 min) this packs those events into the test window - a documented, conservative compression.
// Largest-remainder split of `total` devices into [no order, one order, several] following 70/25/5, so a small
// test (25 devices) hits the profile exactly instead of drawing it at random (run l1-a drew only 3 order
// devices out of 25 by chance).
export function profileQuotas(total) {
  const shares = ORDER_PROFILE.map((p) => p.weight * total);
  const counts = shares.map(Math.floor);
  let left = total - counts.reduce((a, b) => a + b, 0);
  const byRemainder = shares.map((s, i) => [s - Math.floor(s), i]).sort((a, b) => b[0] - a[0]);
  for (const [, i] of byRemainder) {
    if (left-- <= 0) break;
    counts[i] += 1;
  }
  return counts;
}

// slot (0..total-1) -> number of orders for that device under the exact quotas
export function ordersForSlot(rng, slot, total) {
  const [none, one] = profileQuotas(total);
  if (slot < none) return 0;
  if (slot < none + one) return 1;
  return intBetween(rng, 2, 3);
}

export function persistentSessionPlan(rng, durationMs, forcedOrders) {
  const details = intBetween(rng, 2, 6);
  const detailAt = Array.from({ length: details }, () => Math.round(between(rng, 15_000, Math.max(16_000, durationMs - 10_000)))).sort((a, b) => a - b);
  const orders = forcedOrders ?? ordersForSession(rng);
  const orderAt = Array.from({ length: orders }, () => Math.round(between(rng, 0.2, 0.9) * durationMs)).sort((a, b) => a - b);
  return { dwellMs: durationMs, details, detailAt, orderAt, firstPoll: intBetween(rng, 0, POLL_SEC * 1000) };
}

// Churning session (level 4 / request-mix accounting only): a stay of ~dwellMeanMin minutes.
export function sessionPlan(rng, dwellMeanMin) {
  const dwellMs = Math.round(dwellMeanMin * 60_000 * between(rng, 0.6, 1.4));
  return persistentSessionPlan(rng, dwellMs);
}

// Timeline of everything the device does after the initial menu load.
export function buildTimeline(rng, plan) {
  const events = [];
  for (let t = plan.firstPoll; t < plan.dwellMs; t += POLL_SEC * 1000 + intBetween(rng, -400, 400)) events.push({ t, type: 'status' });
  plan.detailAt.forEach((t) => events.push({ t, type: 'detail' }));
  plan.orderAt.forEach((t) => events.push({ t, type: 'order' }));
  return events.sort((a, b) => a.t - b.t);
}

export function buildOrderPayload(rng, products, sessionToken) {
  const lines = intBetween(rng, 1, 4);
  const items = [];
  const used = new Set();
  for (let i = 0; i < lines; i += 1) {
    const product = pick(rng, products);
    if (used.has(product.id)) continue;
    used.add(product.id);
    const item = { productId: product.id, quantity: intBetween(rng, 1, 3) };
    if (product.removable.length > 0 && rng() < 0.3) item.removed = [pick(rng, product.removable)];
    if (product.addOns.length > 0 && rng() < 0.4) item.added = [pick(rng, product.addOns)];
    items.push(item);
  }
  const body = { sessionToken, clientRequestId: uuid(rng), items };
  if (rng() < 0.2) body.note = 'Sin picante, por favor [BENCH]';
  return body;
}

// ---- rates ------------------------------------------------------------------

// Requests one session produces, by endpoint, over a stay of dwellMin minutes.
export function requestsPerSession(dwellMin) {
  const polls = (dwellMin * 60) / POLL_SEC;
  return {
    status: polls,
    join: 1,
    categories: 1,
    products: 1,
    product_detail: MEAN_DETAILS_PER_SESSION,
    orders_create: MEAN_ORDERS_PER_SESSION,
  };
}
export const totalRequestsPerSession = (dwellMin) => Object.values(requestsPerSession(dwellMin)).reduce((a, b) => a + b, 0);

// Steady-state load of C concurrent sessions (Little: each lives dwellMin minutes).
export function steadyRps(concurrentSessions, dwellMin) {
  return (concurrentSessions * totalRequestsPerSession(dwellMin)) / (dwellMin * 60);
}

// Session arrivals per minute that keep `concurrent` sessions alive on average.
export const arrivalsPerMin = (concurrent, dwellMeanMin) => concurrent / dwellMeanMin;

// Weighted action table for the request-mix (stress) executor.
export function mixWeights(dwellMin) {
  const r = requestsPerSession(dwellMin);
  const total = Object.values(r).reduce((a, b) => a + b, 0);
  return Object.entries(r).map(([action, count]) => ({ action, weight: count / total }));
}

export function weightedPick(rng, entries) {
  let roll = rng();
  for (const e of entries) {
    roll -= e.weight;
    if (roll <= 0) return e.action;
  }
  return entries[entries.length - 1].action;
}
