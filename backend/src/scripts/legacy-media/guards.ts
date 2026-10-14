// Pre-flight guards. They run before the first connection / write and throw
// on anything that is not exactly the intended target. Messages never echo
// URLs, passwords or keys.

export function assertRailwayDatabaseUrl(raw: string | undefined): URL {
  if (!raw) throw new Error('MIGRATE_DB_URL is required (the Railway PostgreSQL public URL)');
  if (/supabase/i.test(raw)) throw new Error('Refusing to run: the database URL looks like Supabase');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('MIGRATE_DB_URL is not a valid URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('MIGRATE_DB_URL must be a postgres URL');
  }
  if (!url.hostname.endsWith('.rlwy.net')) {
    throw new Error('Refusing to run: the database host is not a Railway public proxy (*.rlwy.net)');
  }
  return url;
}

export const EXPECTED_DATABASE = 'railway';

export function assertExpectedDatabase(currentDatabase: string): void {
  if (currentDatabase !== EXPECTED_DATABASE) {
    throw new Error(`Refusing to run: connected database is not "${EXPECTED_DATABASE}"`);
  }
}

// SUPABASE_URL host, which legacy URLs must match to count as Supabase Storage.
export function supabaseHostFromEnv(raw: string | undefined): string {
  if (!raw) throw new Error('SUPABASE_URL is required to recognise legacy Supabase URLs');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('SUPABASE_URL is not a valid URL');
  }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.supabase.co')) {
    throw new Error('SUPABASE_URL does not look like a Supabase project URL');
  }
  return url.hostname;
}
