import { afterEach, describe, expect, it } from 'vitest';
import databaseConfig from './typeorm.config.js';
import {
  buildPgPoolExtra,
  DB_SETTINGS,
  loadDbOperationalConfig,
} from './database-operational.config.js';

describe('loadDbOperationalConfig', () => {
  it('uses the approved defaults when nothing is set', () => {
    expect(loadDbOperationalConfig({})).toEqual({
      poolMax: 5,
      connectionTimeoutMs: 5_000,
      idleTimeoutMs: 30_000,
      statementTimeoutMs: 15_000,
      queryTimeoutMs: 20_000,
    });
  });

  it('treats blank values as unset', () => {
    expect(loadDbOperationalConfig({ DB_POOL_MAX: '', DB_QUERY_TIMEOUT_MS: '   ' })).toEqual(
      loadDbOperationalConfig({}),
    );
  });

  it('reads every setting from its env var (and trims whitespace)', () => {
    expect(
      loadDbOperationalConfig({
        DB_POOL_MAX: ' 10 ',
        DB_CONNECTION_TIMEOUT_MS: '3000',
        DB_IDLE_TIMEOUT_MS: '60000',
        DB_STATEMENT_TIMEOUT_MS: '8000',
        DB_QUERY_TIMEOUT_MS: '12000',
      }),
    ).toEqual({
      poolMax: 10,
      connectionTimeoutMs: 3_000,
      idleTimeoutMs: 60_000,
      statementTimeoutMs: 8_000,
      queryTimeoutMs: 12_000,
    });
  });

  it.each(DB_SETTINGS.map((s) => [s.envVar, s] as const))(
    '%s rejects non-integers, zero/negative and out-of-range values',
    (envVar, setting) => {
      const valid = { DB_STATEMENT_TIMEOUT_MS: '1000', DB_QUERY_TIMEOUT_MS: '2000' };
      for (const bad of ['abc', '5s', '1.5', '-1', '0x10', '1e3', 'NaN', String(setting.min - 1), String(setting.max + 1)]) {
        expect(() => loadDbOperationalConfig({ ...valid, [envVar]: bad }), `${envVar}=${bad}`).toThrow(
          new RegExp(`${envVar} must be an integer between`),
        );
      }
    },
  );

  it('accepts the exact bounds', () => {
    expect(loadDbOperationalConfig({ DB_POOL_MAX: '1' }).poolMax).toBe(1);
    expect(loadDbOperationalConfig({ DB_POOL_MAX: '100' }).poolMax).toBe(100);
  });

  it('requires the query timeout to be greater than the statement timeout', () => {
    expect(() =>
      loadDbOperationalConfig({ DB_STATEMENT_TIMEOUT_MS: '20000', DB_QUERY_TIMEOUT_MS: '20000' }),
    ).toThrow(/DB_QUERY_TIMEOUT_MS .* must be greater than DB_STATEMENT_TIMEOUT_MS/);
    // Raising only the statement timeout past the default query timeout is also caught.
    expect(() => loadDbOperationalConfig({ DB_STATEMENT_TIMEOUT_MS: '30000' })).toThrow(
      /must be greater/,
    );
  });
});

describe('buildPgPoolExtra', () => {
  it('maps the config onto pg Pool options', () => {
    expect(buildPgPoolExtra(loadDbOperationalConfig({}))).toEqual({
      max: 5,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 15_000,
      query_timeout: 20_000,
    });
  });
});

describe('TypeORM database config (app DataSource)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('always carries the pool options, for both URL and host/port connections', () => {
    process.env.DATABASE_URL = 'postgresql://u:p@db.example.test:5432/postgres';
    const viaUrl = databaseConfig() as { extra: unknown; synchronize: boolean };
    expect(viaUrl.extra).toEqual(buildPgPoolExtra(loadDbOperationalConfig()));
    expect(viaUrl.synchronize).toBe(false);

    delete process.env.DATABASE_URL;
    const viaHost = databaseConfig() as { extra: unknown };
    expect(viaHost.extra).toEqual(buildPgPoolExtra(loadDbOperationalConfig()));
  });

  it('keeps synchronize disabled in production', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.DATABASE_URL;
    expect((databaseConfig() as { synchronize: boolean }).synchronize).toBe(false);
  });

  it('refuses to build the config (app does not start) on an invalid value', () => {
    process.env.DB_POOL_MAX = 'lots';
    expect(() => databaseConfig()).toThrow(/DB_POOL_MAX/);
  });

  it('the migration CLI DataSource carries no pool/timeout options', async () => {
    process.env.DB_STATEMENT_TIMEOUT_MS = '100';
    process.env.DB_QUERY_TIMEOUT_MS = '200';
    const { default: cli } = await import('./data-source.js');
    expect(cli.options.synchronize).toBe(false);
    expect((cli.options as { extra?: unknown }).extra).toBeUndefined();
  });
});
