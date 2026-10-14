import 'reflect-metadata';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { DataSource } from 'typeorm';
import { MediaUrlService } from '../../media/media-url.service.js';
import { S3ObjectStoreService } from '../../media/s3-object-store.service.js';
import { loadS3Config } from '../../media/s3.config.js';
import { FetchHttpProbe, FileManifestStore, HttpSourceStore } from './adapters.js';
import { assertExpectedDatabase, assertRailwayDatabaseUrl, supabaseHostFromEnv } from './guards.js';
import { LegacyMediaMigrator } from './migrator.js';
import { renderReport } from './report.js';
import { SqlRowRepository } from './sql-row-repository.js';
import type { Plan } from './types.js';

// Legacy media migration: Supabase Storage -> Railway Bucket.
//
//   plan  (default)  read-only inventory + dry-run. Writes ONLY local files.
//   apply            copies + records storage keys. Needs --confirm <planHash>
//                    quoting the hash printed by the plan you reviewed.
//
// Run through `railway run` so every secret is injected into this process
// only (see docs/legacy-media-migration.md); nothing is ever written to disk
// except the plan/manifest, which hold no secrets.

interface Args {
  command: 'plan' | 'apply';
  out: string;
  confirm?: string;
  only?: string[];
  limit?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: 'plan', out: join(homedir(), 'brasa47-migration', 'media-legacy') };
  const rest = [...argv];
  if (rest[0] === 'plan' || rest[0] === 'apply') args.command = rest.shift() as Args['command'];
  while (rest.length) {
    const flag = rest.shift()!;
    const value = () => {
      const v = rest.shift();
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === '--out') args.out = value();
    else if (flag === '--confirm') args.confirm = value();
    else if (flag === '--only') args.only = value().split(',');
    else if (flag === '--limit') args.limit = Number.parseInt(value(), 10);
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (args.limit !== undefined && !(args.limit > 0)) throw new Error('--limit must be a positive integer');
  return args;
}

async function listSupabaseObjects(url: string, key: string, bucket: string): Promise<string[]> {
  const client = createClient(url, key);
  const found: string[] = [];
  const walk = async (prefix: string): Promise<void> => {
    for (let offset = 0; ; offset += 100) {
      const { data, error } = await client.storage.from(bucket).list(prefix, { limit: 100, offset });
      if (error) throw new Error('Listing the Supabase bucket failed');
      for (const entry of data ?? []) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.id === null) await walk(path);
        else if (!entry.name.endsWith('.emptyFolderPlaceholder')) found.push(path);
      }
      if ((data?.length ?? 0) < 100) return;
    }
  };
  await walk('');
  return found.sort();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = (line: string) => console.log(line);

  // ---- guards, before any connection ----
  assertRailwayDatabaseUrl(process.env.MIGRATE_DB_URL);
  const supabaseHost = supabaseHostFromEnv(process.env.SUPABASE_URL);
  const supabaseBucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'product-images';
  const s3Config = loadS3Config(process.env);
  if (!s3Config) throw new Error('The Railway Bucket (AWS_*) is not configured');
  const mediaBaseUrl = MediaUrlService.parseBaseUrl(process.env.MEDIA_PUBLIC_BASE_URL);
  if (!mediaBaseUrl) throw new Error('MEDIA_PUBLIC_BASE_URL is required');

  const dataSource = new DataSource({
    type: 'postgres',
    url: process.env.MIGRATE_DB_URL,
    ssl: { rejectUnauthorized: false },
    entities: [],
    synchronize: false,
  });
  await dataSource.initialize();
  try {
    const [{ current_database: database }] = (await dataSource.query('SELECT current_database()')) as Array<{ current_database: string }>;
    assertExpectedDatabase(database);
    const [{ n }] = (await dataSource.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE (table_name = 'products' AND column_name = 'image_storage_key')
          OR (table_name = 'businesses' AND column_name = 'logo_storage_key')`,
    )) as Array<{ n: number }>;
    if (n !== 2) throw new Error('The storage key columns are missing: run the PR 1 migration first');
    log(`target database: ${database} (Railway) | bucket ${s3Config.bucket} | supabase bucket ${supabaseBucket}`);

    const migrator = new LegacyMediaMigrator({
      rows: new SqlRowRepository((sql, params) => dataSource.query(sql, params)),
      source: new HttpSourceStore(),
      bucket: new S3ObjectStoreService(s3Config),
      probe: new FetchHttpProbe(),
      manifests: new FileManifestStore(join(args.out, 'manifest.json')),
      supabase: { supabaseHost, bucket: supabaseBucket },
      mediaBaseUrl,
      database,
      log,
    });

    await mkdir(args.out, { recursive: true, mode: 0o700 });
    const planPath = join(args.out, 'plan.json');

    if (args.command === 'plan') {
      const plan = await migrator.plan();
      await writeFile(planPath, JSON.stringify(plan, null, 2), { mode: 0o600 });
      await chmod(planPath, 0o600);
      const objects = process.env.SUPABASE_SECRET_KEY
        ? await listSupabaseObjects(process.env.SUPABASE_URL as string, process.env.SUPABASE_SECRET_KEY, supabaseBucket)
        : null;
      log(renderReport(plan, objects));
      log('');
      log('DRY-RUN: nothing was written to the database, the bucket or Supabase.');
      log(`To apply this exact plan: apply --confirm ${plan.planHash}`);
      return;
    }

    // ---- apply ----
    if (!args.confirm) throw new Error('apply requires --confirm <planHash> (printed by the plan you reviewed)');
    const plan = JSON.parse(await readFile(planPath, 'utf8')) as Plan;
    if (args.confirm !== plan.planHash) {
      throw new Error('--confirm does not match the saved plan hash: re-run plan and review it');
    }
    const results = await migrator.apply(plan, { onlyIds: args.only, limit: args.limit });
    const count = (o: string) => results.filter((r) => r.outcome === o).length;
    log(`done: migrated=${count('migrated')} skipped=${count('skipped')} aborted_row_changed=${count('aborted_row_changed')} failed=${count('failed')}`);
    if (count('failed') > 0 || count('aborted_row_changed') > 0) process.exitCode = 1;
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  // Messages here are written by this code (no URLs/secrets).
  console.error(`ERROR: ${error instanceof Error ? error.message : 'unexpected failure'}`);
  process.exit(1);
});
