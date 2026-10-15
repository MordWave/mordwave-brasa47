import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { runAllMigrations } from './run-all-migrations.js';
import { startTestDatabase, type TestDatabase } from './test-database.js';

export interface IsolatedApp {
  app: INestApplication<App>;
  dataSource: DataSource;
  testDb: TestDatabase;
  stop: () => Promise<void>;
}

// The one way an e2e file boots the real AppModule against an ISOLATED database: an ephemeral local PGlite
// (test-database.ts) with every real migration applied through the app's own single connection
// (run-all-migrations.ts). Nothing here can reach Supabase, Railway or any external Postgres: the DB_* variables
// point at the local PGlite socket and DATABASE_URL is forced empty, so even a developer's `.env` holding an old
// URL is ignored (Nest's ConfigModule never overrides a variable that is already set; see also
// isolate-e2e-env.ts, the network tripwire installed for every e2e file).
//
// Call it from beforeAll and stop() from afterAll: PGlite's socket server accepts ONE connection for its whole
// lifetime, so an app per test (beforeEach) is not possible, one app per file is.
export async function startIsolatedApp({ validation = false }: { validation?: boolean } = {}): Promise<IsolatedApp> {
  const testDb = await startTestDatabase();

  process.env.NODE_ENV = 'production';
  process.env.DATABASE_URL = '';
  process.env.DB_HOST = testDb.host;
  process.env.DB_PORT = String(testDb.port);
  process.env.DB_USERNAME = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_NAME = 'postgres';
  process.env.DB_POOL_MAX = '1';

  const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  if (validation) {
    // Same global pipe main.ts installs in production; DTO-level validation only runs through it.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  }
  await app.init();
  const dataSource = moduleFixture.get(DataSource);
  await runAllMigrations(dataSource);

  return {
    app,
    dataSource,
    testDb,
    stop: async () => {
      await app.close();
      await testDb.stop();
    },
  };
}

// Tables that the guard/validation-only suites must never write to. Used to prove those files leave the isolated
// database exactly as the migrations created it.
const GUARDED_TABLES = ['businesses', 'users', 'categories', 'products', 'restaurant_tables', 'table_sessions', 'orders', 'order_items', 'audit_logs'];

export async function countRows(dataSource: DataSource): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of GUARDED_TABLES) {
    const rows = (await dataSource.query(`SELECT count(*)::int AS n FROM "${table}"`)) as Array<{ n: number }>;
    counts[table] = rows[0]!.n;
  }
  return counts;
}
