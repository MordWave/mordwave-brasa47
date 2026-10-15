// Runs inside bench-runner before a smoke test. Proves, in the private network, that the backend keys its
// rate limits and audit log on the X-Real-Ip we send (the "logical IP"), using only ~10 requests:
//   1. an audited, no-op category edit carrying X-Real-Ip: 198.51.100.1 (restaurant 1's logical IP) ->
//      the audit row must hold exactly that address (checked afterwards from the Postgres side);
//   2. login bucket: 5 failed logins from IP A are answered 401, the 6th 429; the same moment IP B still 401.
// Uses IPs outside the load test's range (198.51.100.201/.202) so it never consumes a restaurant's bucket.
import { readFileSync } from 'node:fs';

const base = process.env.BASE_URL;
const fixture = JSON.parse(readFileSync(process.env.FIXTURE, 'utf8'));
const biz = fixture.businesses[0];
const call = async (method, path, body, headers = {}) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};

const login = await call('POST', '/auth/login', { email: biz.adminEmail, password: fixture.adminPassword }, { 'X-Real-Ip': '198.51.100.200' });
const cats = await call('GET', `/categories?businessSlug=${biz.slug}`);
const c = cats.json[0];
const audited = await call('PATCH', `/categories/${c.id}`, { name: c.name }, { Authorization: `Bearer ${login.json.accessToken}`, 'X-Real-Ip': '198.51.100.1' });
console.log(`IPPROBE audited no-op edit with X-Real-Ip 198.51.100.1 -> ${audited.status} (category ${c.slug})`);

const bad = (ip) => call('POST', '/auth/login', { email: 'nobody@benchmark.invalid', password: 'wrong-password-probe' }, { 'X-Real-Ip': ip });
const a = [];
for (let i = 0; i < 6; i += 1) a.push((await bad('198.51.100.201')).status);
const b = (await bad('198.51.100.202')).status;
console.log(`IPPROBE login bucket IP A (x6): ${a.join(',')} | IP B (x1): ${b}`);
const ok = a.slice(0, 5).every((s) => s === 401) && a[5] === 429 && b === 401 && audited.status === 200;
console.log(`IPPROBE result: ${ok ? 'PASS' : 'FAIL'} (expected A: 401x5 then 429; B: 401)`);
process.exit(ok ? 0 : 1);
