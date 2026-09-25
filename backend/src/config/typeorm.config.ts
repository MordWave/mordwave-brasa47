import { registerAs } from '@nestjs/config';
import type { TypeOrmModuleOptions } from '@nestjs/typeorm';

// Unset by default — the pg driver's own default pool size (10) applies,
// same as always. Exists only so a test with an unusual connection target
// (see backend/test/support/test-database.ts: an ephemeral local Postgres
// that can only tolerate a single connection at a time) can force a small
// pool without touching this file's real branches.
function poolExtra(): { max: number } | undefined {
  const max = Number(process.env.DB_POOL_MAX);
  return Number.isInteger(max) && max > 0 ? { max } : undefined;
}

export default registerAs(
  'database',
  (): TypeOrmModuleOptions => {
    const databaseUrl = process.env.DATABASE_URL;

    if (databaseUrl) {
      return {
        type: 'postgres',
        url: databaseUrl,
        ssl: { rejectUnauthorized: false },
        autoLoadEntities: true,
        // Schema changes go exclusively through TypeORM migrations from here
        // on — synchronize never runs, in dev or production.
        synchronize: false,
        extra: poolExtra(),
      };
    }

    return {
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USERNAME ?? 'postgres',
      password: process.env.DB_PASSWORD ?? 'postgres',
      database: process.env.DB_NAME ?? 'brasa47',
      autoLoadEntities: true,
      synchronize: process.env.NODE_ENV !== 'production',
      extra: poolExtra(),
    };
  },
);