// k6-side helpers shared by the three entry scripts.
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import { logicalIp } from './model.mjs';

export const rateLimited = new Counter('rate_limited'); // 429s
export const serverErrors = new Counter('server_errors'); // 5xx + transport errors (status 0)
export const serverErrorRate = new Rate('server_error_rate'); // share of requests that were 5xx/transport errors

// ---- target safety ------------------------------------------------------------
// BASE_URL has no default on purpose. It must contain BASE_URL_MUST_CONTAIN
// (default "bench-backend", the benchmark service name in both its public and
// private hostnames) and must never look like production or Vercel.
export const BASE_URL = (__ENV.BASE_URL || '').replace(/\/+$/, '');
const MUST_CONTAIN = __ENV.BASE_URL_MUST_CONTAIN || 'bench-backend';
if (!BASE_URL) throw new Error('BASE_URL is required (no default, to avoid hitting production by accident).');
if (!BASE_URL.includes(MUST_CONTAIN)) throw new Error(`BASE_URL must contain "${MUST_CONTAIN}" (refusing ${BASE_URL}).`);
if (/mordwave-brasa47-production|mordwave-brasa47\.vercel\.app|mordwave-brasa47-web/.test(BASE_URL)) {
  throw new Error('BASE_URL looks like production/Vercel/frontend. Refusing.');
}

export const IP_MODE = __ENV.IP_MODE || 'public'; // "public": real source IP | "header": X-Real-Ip per logical restaurant
export const SCOPE = __ENV.SCOPE || (IP_MODE === 'header' ? 'internal' : 'public');
export const RUN_ID = __ENV.RUN_ID || `run-${Date.now()}`;

// Anything >= 400 counts as failed in http_req_failed; we classify separately below.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }));

export function loadFixture() {
  const path = __ENV.FIXTURE;
  if (!path) throw new Error('FIXTURE is required (path to the JSON written by seed.mjs / export-fixture.mjs).');
  const fixture = JSON.parse(open(path));
  if (!fixture.businesses || fixture.businesses.length === 0) throw new Error('Fixture has no businesses.');
  for (const b of fixture.businesses) {
    if (!/^bench-/.test(b.slug)) throw new Error(`Fixture contains a non-benchmark business: ${b.slug}`);
  }
  return fixture;
}

export function ipHeaders(businessIndex) {
  return IP_MODE === 'header' && businessIndex !== undefined ? { 'X-Real-Ip': logicalIp(businessIndex) } : {};
}

function headers(businessIndex, extra) {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json', ...extra };
  return { ...h, ...ipHeaders(businessIndex) };
}

// Also used for http.batch() responses, which bypass request().
export function classifyBatch(responses, endpoint, expected) {
  for (const res of responses) {
    classify(res, endpoint);
    check(res, { [`${endpoint} ${expected}`]: (r) => r.status === expected }, { endpoint });
  }
}

function classify(res, endpoint) {
  serverErrorRate.add(res.status >= 500 || res.status === 0, { endpoint });
  if (res.status === 429) rateLimited.add(1, { endpoint });
  else if (res.status >= 500 || res.status === 0) serverErrors.add(1, { endpoint });
}

// opts: { businessIndex, token, step }
export function request(method, path, body, endpoint, expected, opts = {}) {
  const extra = opts.token ? { Authorization: `Bearer ${opts.token}` } : {};
  const tags = { endpoint };
  if (opts.step !== undefined) tags.step = String(opts.step);
  const res = http.request(method, `${BASE_URL}${path}`, body === null ? null : JSON.stringify(body), {
    headers: headers(opts.businessIndex, extra),
    tags,
  });
  classify(res, endpoint);
  check(res, { [`${endpoint} ${expected}`]: (r) => r.status === expected }, tags);
  return res;
}

export const get = (path, endpoint, opts) => request('GET', path, null, endpoint, 200, opts);
export const post = (path, body, endpoint, expected, opts) => request('POST', path, body, endpoint, expected, opts);

export function jsonOf(res) {
  try {
    return res.json();
  } catch (_) {
    return null;
  }
}

export function login(business, businessIndex, password) {
  const res = post('/auth/login', { email: business.adminEmail, password }, 'login', 200, { businessIndex });
  const body = jsonOf(res);
  return body?.accessToken ?? null;
}

// Compact end-of-run output + JSON export for the report.
export function summaryFiles(data, level, extraName = '') {
  const outDir = __ENV.OUT_DIR || 'benchmark/.out';
  const name = `${outDir}/summary-L${level}${extraName}-${RUN_ID}.json`;
  const m = data.metrics;
  const fmt = (metric, stat) => (m[metric]?.values?.[stat] !== undefined ? m[metric].values[stat].toFixed(1) : '-');
  const lines = [`\n== L${level} ${RUN_ID} scope=${SCOPE} ipMode=${IP_MODE} ==`];
  lines.push(`requests=${m.http_reqs?.values?.count ?? 0} rps(avg)=${fmt('http_reqs', 'rate')} failed=${((m.http_req_failed?.values?.rate ?? 0) * 100).toFixed(2)}% 429=${m.rate_limited?.values?.count ?? 0} 5xx=${m.server_errors?.values?.count ?? 0} dropped=${m.dropped_iterations?.values?.count ?? 0}`);
  for (const key of Object.keys(m).filter((k) => k.startsWith('http_req_duration{endpoint:') || k.startsWith('http_req_duration{step:')).sort()) {
    lines.push(`${key.padEnd(48)} p50=${fmt(key, 'med')} p95=${fmt(key, 'p(95)')} p99=${fmt(key, 'p(99)')} max=${fmt(key, 'max')}`);
  }
  return { [name]: JSON.stringify(data, null, 2), stdout: `${lines.join('\n')}\n` };
}
