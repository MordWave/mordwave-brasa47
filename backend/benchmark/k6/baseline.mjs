// Level 0: baseline without load. Two windows (the idle one is just waiting + sampling, see
// scripts/level0.sh):
//   1. idle: LEVELS[0].idleMin minutes with no requests at all;
//   2. this script: /health at 1 req/s for LEVELS[0].healthMin minutes = the latency floor
//      (network RTT + Node), no database involved.
// WITH_DBPATH=1 (+ FIXTURE) additionally reads /categories at 6/min to see the idle DB-path latency.
// The point of level 0 is mostly what Railway reports while the system is idle (CPU, RAM,
// Postgres connections); see collect-railway.sh / pg-sampler.sh.
import { RUN_ID, SCOPE, get, loadFixture, summaryFiles } from './lib/common.mjs';
import { LEVELS, thresholdsFor } from './lib/levels.mjs';

const cfg = LEVELS[0];
const fixture = __ENV.WITH_DBPATH === '1' && __ENV.FIXTURE ? loadFixture() : null;

const scenarios = {
  health: {
    executor: 'constant-arrival-rate',
    exec: 'health',
    rate: 1,
    timeUnit: '1s',
    duration: `${cfg.healthMin}m`,
    preAllocatedVUs: 2,
    maxVUs: 5,
  },
};
if (fixture) {
  scenarios.dbpath = {
    executor: 'constant-arrival-rate',
    exec: 'dbPath',
    rate: 6,
    timeUnit: '1m',
    duration: `${cfg.healthMin}m`,
    preAllocatedVUs: 2,
    maxVUs: 5,
  };
}

export const options = {
  scenarios,
  thresholds: {
    ...Object.fromEntries(Object.entries(thresholdsFor({ scope: SCOPE, level: 0, env: __ENV })).filter(([k]) => /endpoint:(health|categories)/.test(k) || ['rate_limited', 'server_errors', 'http_req_failed', 'checks'].includes(k))),
  },
  tags: { run: RUN_ID, level: '0', scope: SCOPE },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
};

export function health() {
  get('/health', 'health', { businessIndex: 0 });
}

export function dbPath() {
  get(`/categories?businessSlug=${encodeURIComponent(fixture.businesses[0].slug)}`, 'categories', { businessIndex: 0 });
}

export function handleSummary(data) {
  return summaryFiles(data, 0);
}
