import type { ClientConfig } from 'pg';

// How the CLI reaches PostgreSQL. It reads the SAME variables as the application (DATABASE_URL, or the DB_* set) but is
// stricter: there are NO defaults. A tool that creates a privileged account must never fall back to "localhost / postgres /
// brasa47" because a variable was forgotten — it refuses and names the missing VARIABLES (never their values).
export interface TargetInfo {
  source: 'DATABASE_URL' | 'DB_*';
  host: string;
  port: string;
  database: string;
  ssl: boolean;
  environment: string;
  service: string | null;
}

export class ConfigError extends Error {}

export interface ResolvedConnection {
  clientConfig: ClientConfig;
  target: TargetInfo;
}

const TIMEOUTS = { connectionTimeoutMillis: 10_000, statement_timeout: 15_000, query_timeout: 20_000 };
const APPLICATION_NAME = 'mordwave-bootstrap-super-admin';

export function resolveConnection(env: Record<string, string | undefined>): ResolvedConnection {
  const environment = env.RAILWAY_ENVIRONMENT_NAME || env.NODE_ENV || 'desconocido';
  const service = env.RAILWAY_SERVICE_NAME || null;
  const databaseUrl = env.DATABASE_URL;

  if (databaseUrl) {
    let url: URL;
    try {
      url = new URL(databaseUrl);
    } catch {
      throw new ConfigError('DATABASE_URL no es una URL de PostgreSQL válida.'); // the value is never echoed
    }
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
      throw new ConfigError('DATABASE_URL no es una URL de PostgreSQL válida.');
    }
    return {
      // Same SSL setting as the application (src/config/typeorm.config.ts) for a connection string.
      clientConfig: { connectionString: databaseUrl, ssl: { rejectUnauthorized: false }, application_name: APPLICATION_NAME, ...TIMEOUTS },
      target: {
        source: 'DATABASE_URL',
        host: url.hostname,
        port: url.port || '5432',
        database: decodeURIComponent(url.pathname.replace(/^\//, '')),
        ssl: true,
        environment,
        service,
      },
    };
  }

  const missing = ['DB_HOST', 'DB_NAME', 'DB_USERNAME', 'DB_PASSWORD'].filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new ConfigError(`Configuración insuficiente: define DATABASE_URL, o bien ${missing.join(', ')} (no hay valores por defecto).`);
  }
  const port = env.DB_PORT || '5432';
  return {
    clientConfig: {
      host: env.DB_HOST,
      port: Number(port),
      user: env.DB_USERNAME,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      application_name: APPLICATION_NAME,
      ...TIMEOUTS,
    },
    target: { source: 'DB_*', host: env.DB_HOST!, port, database: env.DB_NAME!, ssl: false, environment, service },
  };
}

export function describeTarget(target: TargetInfo): string {
  return [
    `origen de la configuración: ${target.source}`,
    `host: ${target.host}`,
    `puerto: ${target.port}`,
    `base de datos: ${target.database}`,
    `ssl: ${target.ssl ? 'sí' : 'no'}`,
    `entorno: ${target.environment}`,
    ...(target.service ? [`servicio: ${target.service}`] : []),
  ].join('\n  ');
}
