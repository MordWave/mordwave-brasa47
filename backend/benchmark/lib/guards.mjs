// Safety guards shared by seed / reset / export-fixture.
//
// These scripts WRITE (seed, reset). They must be impossible to point at
// production by accident, so every one of them goes through connectGuarded():
//
//   1. the connection string comes from BENCH_DATABASE_URL only (never from
//      DATABASE_URL, which in a `railway run` shell could be production's);
//   2. on a remote host, RAILWAY_ENVIRONMENT_NAME must be exactly "benchmark"
//      (injected by `railway run -e benchmark ...`) and the host must be a
//      Railway proxy/private host; localhost needs BENCH_ALLOW_LOCAL=1 (tests);
//   3. the database must be recognisably a benchmark database: either it has
//      the benchmark_marker row, or it is completely empty of app data;
//   4. whatever the marker says, any business whose slug does not start with
//      the benchmark prefix makes the script refuse (production has real
//      businesses, e.g. "brasa-47").
//
// Credentials are never printed: only host and database name.
import pg from 'pg';

// Guard failures are expected outcomes, not crashes: print the reason only.
process.on('uncaughtException', (err) => {
  console.error(err.message);
  process.exit(1);
});

export const BENCH_PREFIX = 'bench';
export const BENCH_EMAIL_DOMAIN = 'benchmark.invalid';

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split('=');
    if (inline !== undefined) out[key] = inline;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out[key] = argv[(i += 1)];
    else out[key] = true;
  }
  return out;
}

export function intArg(args, name, fallback, { min = 0, max = 100000 } = {}) {
  const raw = args[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return value;
}

function describeTarget(url) {
  const u = new URL(url);
  return { host: u.hostname, port: u.port || '5432', database: u.pathname.replace(/^\//, '') };
}

export function assertTargetAllowed(url, env = process.env) {
  if (!url) throw new Error('BENCH_DATABASE_URL is not set (refusing to fall back to DATABASE_URL).');
  if (/supabase/i.test(url)) throw new Error('Refusing: the URL looks like Supabase.');
  const { host } = describeTarget(url);
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (local) {
    if (env.BENCH_ALLOW_LOCAL !== '1') {
      throw new Error('Refusing a local database unless BENCH_ALLOW_LOCAL=1 (used by tests only).');
    }
    return;
  }
  if (env.RAILWAY_ENVIRONMENT_NAME !== 'benchmark') {
    throw new Error(
      `Refusing: RAILWAY_ENVIRONMENT_NAME is "${env.RAILWAY_ENVIRONMENT_NAME ?? '(unset)'}", expected "benchmark". ` +
        'Run through `railway run -e benchmark ...`.',
    );
  }
  if (!/\.rlwy\.net$/.test(host) && !/\.railway\.internal$/.test(host)) {
    throw new Error(`Refusing: host "${host}" is not a Railway proxy/private host.`);
  }
}

// Returns { client, target, markerExists }. The caller must client.end().
export async function connectGuarded({ requireMarker = false } = {}) {
  const url = process.env.BENCH_DATABASE_URL;
  assertTargetAllowed(url);
  const client = new pg.Client({
    connectionString: url,
    // Railway Postgres (public proxy and private network alike) speaks TLS with a self-signed cert, like the backend's own pool.
    ssl: /\.(rlwy\.net|railway\.internal)$/.test(describeTarget(url).host) ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  try {
    const target = describeTarget(url);
    const marker = await client.query(`select to_regclass('public.benchmark_marker') as t`);
    const markerExists = marker.rows[0].t !== null;
    if (markerExists) {
      const row = await client.query(`select env from benchmark_marker where id = 1`);
      if (row.rows[0]?.env !== 'benchmark') throw new Error('benchmark_marker present but env != "benchmark".');
    } else {
      if (requireMarker) throw new Error('Refusing: no benchmark_marker in this database.');
      const counts = await client.query(
        `select (select count(*) from businesses)::int as b, (select count(*) from users)::int as u`,
      );
      if (counts.rows[0].b !== 0 || counts.rows[0].u !== 0) {
        throw new Error(
          `Refusing: no benchmark_marker and the database already has data (businesses=${counts.rows[0].b}, users=${counts.rows[0].u}). ` +
            'This does not look like a fresh benchmark database.',
        );
      }
    }
    const foreign = await client.query(`select slug from businesses where slug not like $1 limit 3`, [`${BENCH_PREFIX}-%`]);
    if (foreign.rowCount > 0) {
      throw new Error(`Refusing: found non-benchmark business slug(s): ${foreign.rows.map((r) => r.slug).join(', ')}.`);
    }
    return { client, target, markerExists };
  } catch (err) {
    await client.end();
    throw err;
  }
}
