// Level 4: stress until the first threshold breaks.
//
// Not a VU-per-session model (thousands of sleeping VUs would stress the load
// generator, not the backend). Instead an open-model request mix: every
// iteration is ONE request whose type follows the per-session request counts
// (about 80-97 % are status polls) and whose restaurant / IP / table are random.
// Session tokens are collected once in setup() by joining every table.
//
// The arrival rate steps through LEVELS[4].steps x the level-3 steady rate
// (250 sessions). Every request carries a `step` tag so the report can show
// the latency curve per step; the run aborts at the first broken threshold.
import exec from 'k6/execution';
import { sleep } from 'k6';
import { IP_MODE, RUN_ID, SCOPE, get, jsonOf, loadFixture, post, summaryFiles } from './lib/common.mjs';
import { DWELL_MEAN_MIN, LEVELS, expectedBaseRps, thresholdsFor } from './lib/levels.mjs';
import { buildOrderPayload, mixWeights, mulberry32, pick, weightedPick } from './lib/model.mjs';

const cfg = LEVELS[4];
if (IP_MODE !== 'header') throw new Error('Level 4 requires IP_MODE=header (one logical IP per restaurant).');

const fixture = loadFixture();
const restaurants = Math.min(cfg.restaurants, fixture.businesses.length);
const weights = mixWeights(DWELL_MEAN_MIN);
const baseRps = Math.round(
  (expectedBaseRps(3) * restaurants) / LEVELS[3].restaurants,
);

function stages() {
  const out = [];
  for (const factor of cfg.steps) {
    out.push({ target: Math.round(baseRps * factor), duration: `${cfg.rampSec}s` });
    out.push({ target: Math.round(baseRps * factor), duration: `${cfg.stepMin}m` });
  }
  return out;
}

export const options = {
  scenarios: {
    mix: {
      executor: 'ramping-arrival-rate',
      startRate: Math.max(1, baseRps),
      timeUnit: '1s',
      preAllocatedVUs: 200,
      maxVUs: 3000,
      stages: stages(),
      gracefulStop: '30s',
    },
  },
  thresholds: thresholdsFor({ scope: SCOPE, level: 4, env: __ENV }),
  tags: { run: RUN_ID, level: '4', scope: SCOPE },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
};

// Joins every table once (<= 10 per restaurant, well under the 120/min/IP join limit).
export function setup() {
  const sessions = [];
  for (let i = 0; i < restaurants; i += 1) {
    for (const table of fixture.businesses[i].tables) {
      const joined = jsonOf(post('/table-sessions/join', { qrToken: table.qrToken }, 'join', 200, { businessIndex: i }));
      if (joined?.sessionToken) sessions.push({ biz: i, token: joined.sessionToken, slug: joined.businessSlug });
    }
    sleep(0.2);
  }
  if (sessions.length === 0) throw new Error('No session tokens collected.');
  return { sessions };
}

function currentStep() {
  const elapsed = exec.instance.currentTestRunDuration / 1000;
  const perStep = cfg.rampSec + cfg.stepMin * 60;
  return Math.min(cfg.steps.length, Math.floor(elapsed / perStep) + 1);
}

export default function (data) {
  const rng = mulberry32(exec.scenario.iterationInTest * 2654435761 + 1);
  const s = pick(rng, data.sessions);
  const biz = fixture.businesses[s.biz];
  const opts = { businessIndex: s.biz, step: currentStep() };
  const q = `?businessSlug=${encodeURIComponent(s.slug)}`;
  switch (weightedPick(rng, weights)) {
    case 'status':
      post('/table-sessions/status', { sessionToken: s.token }, 'status', 200, opts);
      break;
    case 'join':
      post('/table-sessions/join', { qrToken: pick(rng, biz.tables).qrToken }, 'join', 200, opts);
      break;
    case 'categories':
      get(`/categories${q}`, 'categories', opts);
      break;
    case 'products':
      get(`/products${q}`, 'products', opts);
      break;
    case 'product_detail':
      get(`/products/${pick(rng, biz.products).id}${q}`, 'product_detail', opts);
      break;
    default:
      post('/orders', buildOrderPayload(rng, biz.products, s.token), 'orders_create', 201, opts);
  }
}

export function handleSummary(data) {
  return summaryFiles(data, 4);
}
