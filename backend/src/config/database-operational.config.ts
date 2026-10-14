// Operational (per-environment) Postgres pool/timeout settings. Everything
// here may legitimately differ between Railway PostgreSQL, a local Postgres and
// AWS RDS later, so it comes from env vars with safe defaults. Static
// product rules (per-Business limits, pagination, body size…) live elsewhere
// and are not configurable per environment.
//
// Strict on purpose, like config/resource-limits.config.ts: unset/blank ->
// the default; anything else must be a plain integer inside its bounds or
// the app refuses to start. A typo ("5s", "0", "1e9") must never silently
// turn into "no timeout" or a pool of one.

export interface DbOperationalConfig {
  poolMax: number;
  connectionTimeoutMs: number;
  idleTimeoutMs: number;
  statementTimeoutMs: number;
  queryTimeoutMs: number;
}

interface Setting {
  envVar: string;
  key: keyof DbOperationalConfig;
  defaultValue: number;
  min: number;
  max: number;
}

export const DB_SETTINGS: readonly Setting[] = [
  // Per application instance. With N replicas the database sees N × this, so
  // keep it well below the database's (or pooler's) connection ceiling.
  { envVar: 'DB_POOL_MAX', key: 'poolMax', defaultValue: 5, min: 1, max: 100 },
  // How long a request waits for a free pooled connection before failing
  // fast (-> 503) instead of queueing forever.
  { envVar: 'DB_CONNECTION_TIMEOUT_MS', key: 'connectionTimeoutMs', defaultValue: 5_000, min: 100, max: 120_000 },
  // Idle pooled connections are closed after this long.
  { envVar: 'DB_IDLE_TIMEOUT_MS', key: 'idleTimeoutMs', defaultValue: 30_000, min: 1_000, max: 3_600_000 },
  // Server-side: Postgres cancels any single statement running longer than
  // this (SQLSTATE 57014 -> 504).
  { envVar: 'DB_STATEMENT_TIMEOUT_MS', key: 'statementTimeoutMs', defaultValue: 15_000, min: 100, max: 600_000 },
  // Client-side (pg): stops waiting for a query after this long. A backstop
  // for when the server-side timeout can't fire (e.g. a pooler that drops
  // startup parameters, or a hung connection), so it must be larger than
  // the statement timeout.
  { envVar: 'DB_QUERY_TIMEOUT_MS', key: 'queryTimeoutMs', defaultValue: 20_000, min: 100, max: 600_000 },
];

function parseSetting(setting: Setting, raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return setting.defaultValue;
  const trimmed = raw.trim();
  const value = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  if (!Number.isSafeInteger(value) || value < setting.min || value > setting.max) {
    throw new Error(
      `${setting.envVar} must be an integer between ${setting.min} and ${setting.max} (got "${raw}")`,
    );
  }
  return value;
}

export function loadDbOperationalConfig(env: NodeJS.ProcessEnv = process.env): DbOperationalConfig {
  const config = {} as DbOperationalConfig;
  for (const setting of DB_SETTINGS) {
    config[setting.key] = parseSetting(setting, env[setting.envVar]);
  }
  if (config.queryTimeoutMs <= config.statementTimeoutMs) {
    throw new Error(
      `DB_QUERY_TIMEOUT_MS (${config.queryTimeoutMs}) must be greater than DB_STATEMENT_TIMEOUT_MS (${config.statementTimeoutMs}) so the server-side timeout fires first`,
    );
  }
  return config;
}

// Options handed to the `pg` Pool through TypeORM's `extra`. Only the
// application's DataSource uses this: the TypeORM CLI's DataSource
// (config/data-source.ts) deliberately sets none of them, so migrations/DDL
// never inherit a short statement_timeout.
//
// statement_timeout travels as a Postgres startup parameter. Direct
// connections and session-mode poolers honour it; some transaction-mode
// poolers ignore or reject startup parameters. query_timeout is the
// client-side backstop either way (see DB_QUERY_TIMEOUT_MS).
//
// TO VERIFY AFTER THE FIRST DEPLOY (the local e2e can't: PGlite neither
// receives nor enforces statement_timeout): run a READ-ONLY query over a
// connection created with the application's own settings — same pool options
// as buildPgPoolExtra(), same DATABASE_URL — and check the session value:
//     SHOW statement_timeout;      -- expect "15s" (DB_STATEMENT_TIMEOUT_MS)
// Optionally also confirm enforcement with a harmless
//     SELECT pg_sleep(20);         -- expect SQLSTATE 57014 after ~15s
// If a pooler in front of the database ignores the startup parameter (SHOW
// reports "0"), evaluate `ALTER ROLE <app role> SET statement_timeout = ...` as a separate,
// explicit change. Until then DB_QUERY_TIMEOUT_MS is the only active guard.
export function buildPgPoolExtra(config: DbOperationalConfig) {
  return {
    max: config.poolMax,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    idleTimeoutMillis: config.idleTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
    query_timeout: config.queryTimeoutMs,
  };
}
