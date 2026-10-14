import { describe, expect, it } from 'vitest';
import { assertExpectedDatabase, assertRailwayDatabaseUrl, supabaseHostFromEnv } from './guards.js';

describe('assertRailwayDatabaseUrl', () => {
  it('accepts a Railway TCP proxy URL', () => {
    expect(assertRailwayDatabaseUrl('postgresql://postgres:pw@roundhouse.proxy.rlwy.net:12345/railway').hostname).toBe(
      'roundhouse.proxy.rlwy.net',
    );
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['Supabase pooler', 'postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:5432/postgres'],
    ['Supabase direct', 'postgresql://u:p@db.abcd.supabase.co:5432/postgres'],
    ['Railway private host', 'postgresql://u:p@postgres.railway.internal:5432/railway'],
    ['localhost', 'postgresql://u:p@localhost:5432/railway'],
    ['lookalike host', 'postgresql://u:p@evil-rlwy.net:5432/railway'],
    ['not a URL', 'not a url'],
    ['wrong scheme', 'mysql://u:p@x.proxy.rlwy.net:3306/railway'],
  ])('refuses %s', (_label, url) => {
    expect(() => assertRailwayDatabaseUrl(url)).toThrow();
  });

  it('never echoes the URL (password) in its error', () => {
    const url = 'postgresql://u:SuperSecretPw@db.abcd.supabase.co:5432/postgres';
    try {
      assertRailwayDatabaseUrl(url);
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as Error).message).not.toContain('SuperSecretPw');
      expect((error as Error).message).not.toContain('abcd');
    }
  });
});

describe('assertExpectedDatabase', () => {
  it('only accepts the "railway" database', () => {
    expect(() => assertExpectedDatabase('railway')).not.toThrow();
    for (const name of ['postgres', 'brasa47_rehearsal', 'Railway', '']) {
      expect(() => assertExpectedDatabase(name)).toThrow();
    }
  });
});

describe('supabaseHostFromEnv', () => {
  it('returns the host of a Supabase project URL', () => {
    expect(supabaseHostFromEnv('https://abcd.supabase.co')).toBe('abcd.supabase.co');
  });
  it.each([undefined, '', 'http://abcd.supabase.co', 'https://example.com', 'nope'])('refuses %j', (raw) => {
    expect(() => supabaseHostFromEnv(raw)).toThrow();
  });
});
