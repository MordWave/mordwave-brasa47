#!/usr/bin/env node
// Re-exports the k6 fixture from an already seeded benchmark database.
// Used by the in-Railway runner (levels 2-4), where BENCH_DATABASE_URL is the
// private URL of the benchmark Postgres and BENCH_ADMIN_PASSWORD is the same
// value the seed used. Read-only.
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { connectGuarded, parseArgs } from './lib/guards.mjs';
import { exportFixture } from './lib/fixture.mjs';

const args = parseArgs(process.argv.slice(2));
const out = resolve(args.out ?? 'benchmark/.out/fixture.json');
const { client, target } = await connectGuarded({ requireMarker: true });
try {
  console.log(`target: host=${target.host} db=${target.database} (guards passed, read-only)`);
  const fixture = await exportFixture(client, { adminPassword: process.env.BENCH_ADMIN_PASSWORD ?? null });
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(fixture, null, 2), { mode: 0o600 });
  await chmod(out, 0o600);
  console.log(`fixture: ${out} (${fixture.businesses.length} businesses)`);
} finally {
  await client.end();
}
