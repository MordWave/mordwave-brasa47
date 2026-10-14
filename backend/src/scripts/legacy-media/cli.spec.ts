import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// `npm run media:legacy` is the ONLY thing that still needs Supabase. These run
// the real CLI (through the same ts-node loader the npm script uses) with a
// controlled environment; every case aborts at the guards, before any network
// access, so nothing is contacted.
const CLI = join(__dirname, 'cli.ts');
const BACKEND = join(__dirname, '..', '..', '..');
const RLWY_DB = 'postgresql://u:pw@fake.proxy.rlwy.net:1/railway';

function run(env: Record<string, string>, args: string[] = ['plan']) {
  const result = spawnSync(process.execPath, ['--loader', 'ts-node/esm', CLI, ...args], {
    cwd: BACKEND,
    encoding: 'utf8',
    timeout: 60_000,
    // A clean environment: only PATH plus what each case provides (no inherited SUPABASE_* / DB vars).
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

describe('media:legacy CLI keeps requiring Supabase when run by hand', () => {
  it('refuses to run without SUPABASE_URL', () => {
    const { code, out } = run({ MIGRATE_DB_URL: RLWY_DB });
    expect(code).toBe(1);
    expect(out).toContain('SUPABASE_URL is required');
  });

  it('refuses a SUPABASE_URL that is not a Supabase project', () => {
    const { code, out } = run({ MIGRATE_DB_URL: RLWY_DB, SUPABASE_URL: 'https://example.com' });
    expect(code).toBe(1);
    expect(out).toContain('does not look like a Supabase project URL');
  });

  it('refuses to run without the Railway database URL (even with Supabase configured)', () => {
    const { code, out } = run({ SUPABASE_URL: 'https://abcd.supabase.co' });
    expect(code).toBe(1);
    expect(out).toContain('MIGRATE_DB_URL is required');
  });

  it('refuses a Supabase database URL', () => {
    const { code, out } = run({ MIGRATE_DB_URL: 'postgresql://u:pw@db.abcd.supabase.co:5432/postgres', SUPABASE_URL: 'https://abcd.supabase.co' });
    expect(code).toBe(1);
    expect(out).toContain('looks like Supabase');
    expect(out).not.toContain('pw@');
  });

  it('apply without --confirm is refused at the guards as well', () => {
    const { code, out } = run({ MIGRATE_DB_URL: RLWY_DB }, ['apply']);
    expect(code).toBe(1);
    expect(out).toContain('ERROR');
  });
});
