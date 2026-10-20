import bcrypt from 'bcrypt';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource, type QueryRunner } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { Business } from '../src/business/business.entity.js';
import { AddCredentialsSecurity1790400000000 } from '../src/migrations/1790400000000-AddCredentialsSecurity.js';
import { User } from '../src/user/user.entity.js';
import { UserRole } from '../src/user/user-role.enum.js';
import { runMigrationsBefore } from './support/run-all-migrations.js';
import { seedBusinessAtSchemaState } from './support/seed-business-at-schema-state.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

const TEST_BCRYPT_COST = 4;
const NEW_COLUMNS = ['credentials_version', 'must_change_password'];

// The additive credentials-security migration (8D.2d-2a), exercised on a real Postgres (ephemeral PGlite) at the
// exact schema state right before it, with "legacy" users that exist BEFORE the migration (inserted with raw SQL:
// since 8D.2d-2b the User entity maps the new columns, so the application itself only works AFTER the migration —
// which is the deploy order the runbook enforces). The tokens of the previous runtime (no `cv` claim) are simulated by
// signing a payload without it.
//
// Deliberately NOT proven here (PGlite is one session; see the migration's own notes): lock waits and
// lock_timeout expiry under a competing transaction. Only that the timeout is set around the ALTER and restored.
describe('AddCredentialsSecurity migration (e2e, real local Postgres)', () => {
  let testDb: TestDatabase;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let business: Business;
  let jwt: JwtService;

  const migration = new AddCredentialsSecurity1790400000000();
  const admin = { email: 'admin@credentials-schema.test', password: 'Sup3rSecret!Admin' };
  const superAdmin = { email: 'root@credentials-schema.test', password: 'Sup3rSecret!Root' };
  let legacyAdminId: string;
  let legacySuperAdminId: string;

  async function run(direction: 'up' | 'down'): Promise<void> {
    const queryRunner = dataSource.createQueryRunner();
    try {
      await migration[direction](queryRunner);
    } finally {
      await queryRunner.release();
    }
  }

  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => dataSource.query(sql, params) as Promise<T[]>;

  const lockTimeout = async (): Promise<string> => (await q<{ v: string }>(`SELECT current_setting('lock_timeout') AS v`))[0]!.v;

  const newColumns = async () =>
    q<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'users' AND column_name IN ('credentials_version', 'must_change_password')
       ORDER BY column_name`,
    );

  // Every column that existed before the migration, as text, per user.
  const legacyFingerprint = async (): Promise<string> =>
    (
      await q<{ h: string }>(
        `SELECT md5(coalesce(string_agg(concat_ws('|', id::text, email, password_hash, role::text, coalesce(business_id::text, '-'), active::text, created_at::text, updated_at::text), ';' ORDER BY id), '')) AS h FROM users`,
      )
    )[0]!.h;

  const columnNames = async (): Promise<string[]> =>
    (await q<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' ORDER BY ordinal_position`)).map((r) => r.c);

  // A thin QueryRunner whose ALTER can be observed or made to fail on the CLIENT side (a server-side error in a
  // parameterised statement can desynchronise the PGlite socket, so failures are injected here instead).
  function observed(real: QueryRunner, hooks: { beforeAlter?: () => Promise<void>; failAlter?: boolean; serverVersionNum?: string }): QueryRunner {
    return new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'query') {
          return async (sql: string, params?: unknown[]) => {
            if (hooks.serverVersionNum && sql.includes('server_version_num')) return [{ version: hooks.serverVersionNum }];
            if (sql.startsWith('ALTER TABLE "users"')) {
              await hooks.beforeAlter?.();
              if (hooks.failAlter) throw new Error('injected ALTER failure');
            }
            return target.query(sql, params);
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  }

  beforeAll(async () => {
    testDb = await startTestDatabase();
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = '';
    process.env.DB_HOST = testDb.host;
    process.env.DB_PORT = String(testDb.port);
    process.env.DB_USERNAME = 'postgres';
    process.env.DB_PASSWORD = 'postgres';
    process.env.DB_NAME = 'postgres';
    process.env.DB_POOL_MAX = '1';

    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication<INestApplication<App>>();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = moduleFixture.get(DataSource);
    jwt = moduleFixture.get(JwtService);

    // Schema exactly as production has it today (every migration before this one) ...
    await runMigrationsBefore(dataSource, AddCredentialsSecurity1790400000000);

    // ... with users that already exist.
    business = await seedBusinessAtSchemaState(dataSource, 'Legacy Co', 'legacy-co-credentials');
    const insertUser = async (u: { email: string; password: string }, role: UserRole, businessId: string | null): Promise<string> => {
      const hash = await bcrypt.hash(u.password, TEST_BCRYPT_COST);
      const rows = (await dataSource.query(
        `INSERT INTO users (email, password_hash, role, business_id) VALUES ($1, $2, $3, $4) RETURNING id`,
        [u.email, hash, role, businessId],
      )) as Array<{ id: string }>;
      return rows[0]!.id;
    };
    legacyAdminId = await insertUser(admin, UserRole.ADMIN, business.id);
    legacySuperAdminId = await insertUser(superAdmin, UserRole.SUPER_ADMIN, null);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await testDb?.stop();
  });

  let fingerprintBefore: string;
  let columnsBefore: string[];
  let lockTimeoutBefore: string;
  let legacyToken: string; // what the previous runtime issued: no `cv` claim
  // POST /auth/login is limited to 5 per minute per IP, so this file logs in twice in total and reuses tokens.

  it('before the migration the columns do not exist and the legacy users are there', async () => {
    expect(await newColumns()).toEqual([]);
    legacyToken = await jwt.signAsync({ sub: legacyAdminId, email: admin.email, role: UserRole.ADMIN, businessId: business.id });
    fingerprintBefore = await legacyFingerprint();
    columnsBefore = await columnNames();
    lockTimeoutBefore = await lockTimeout();
  });

  describe('a failure leaves nothing behind', () => {
    it('a failing ALTER inside a transaction rolls everything back, columns and lock_timeout included', async () => {
      const runner = dataSource.createQueryRunner();
      try {
        await runner.startTransaction();
        let seenDuringAlter = '';
        await expect(
          migration.up(
            observed(runner, {
              beforeAlter: async () => {
                seenDuringAlter = String(((await runner.query(`SELECT current_setting('lock_timeout') AS v`)) as Array<{ v: string }>)[0]!.v);
              },
              failAlter: true,
            }),
          ),
        ).rejects.toThrow('injected ALTER failure');
        expect(seenDuringAlter).toBe('5s');
        await runner.rollbackTransaction();
      } finally {
        await runner.release();
      }
      expect(await newColumns()).toEqual([]);
      expect(await lockTimeout()).toBe(lockTimeoutBefore);
      expect(await legacyFingerprint()).toBe(fingerprintBefore);
    });

    it('outside a transaction a failing ALTER still restores the session lock_timeout', async () => {
      const runner = dataSource.createQueryRunner();
      try {
        await expect(migration.up(observed(runner, { failAlter: true }))).rejects.toThrow('injected ALTER failure');
      } finally {
        await runner.release();
      }
      expect(await newColumns()).toEqual([]);
      expect(await lockTimeout()).toBe(lockTimeoutBefore);
    });

    it("a rollback after a successful up() (a later migration failing in TypeORM's 'all' mode) undoes it", async () => {
      const runner = dataSource.createQueryRunner();
      try {
        await runner.startTransaction();
        await migration.up(runner);
        // (the pool holds ONE connection and the runner owns it: inside the transaction, ask through the runner)
        const inside = (await runner.query(
          `SELECT current_setting('lock_timeout') AS lock_timeout, (SELECT count(*)::int FROM information_schema.columns WHERE table_name = 'users' AND column_name IN ('credentials_version', 'must_change_password')) AS columns`,
        )) as Array<{ lock_timeout: string; columns: number }>;
        expect(inside).toEqual([{ lock_timeout: lockTimeoutBefore, columns: 2 }]); // restored after success: later migrations are unaffected
        await runner.rollbackTransaction();
      } finally {
        await runner.release();
      }
      expect(await newColumns()).toEqual([]);
      expect(await legacyFingerprint()).toBe(fingerprintBefore);
    });
  });

  describe('PostgreSQL version guard', () => {
    it('refuses on a server older than 11 before requesting any lock or running the ALTER, with a clear message', async () => {
      const statements: string[] = [];
      const runner = dataSource.createQueryRunner();
      try {
        const spied = new Proxy(observed(runner, { serverVersionNum: '100023' }), {
          get(target, prop, receiver) {
            if (prop === 'query') {
              return (sql: string, params?: unknown[]) => {
                statements.push(sql);
                return (target.query as (s: string, p?: unknown[]) => Promise<unknown>)(sql, params);
              };
            }
            return Reflect.get(target, prop, receiver) as unknown;
          },
        });
        await expect(migration.up(spied)).rejects.toThrow(/refused to run, nothing was changed: PostgreSQL 11 or newer is required.*reports 100023/);
      } finally {
        await runner.release();
      }
      expect(statements.filter((sql) => /ALTER TABLE|lock_timeout/.test(sql))).toEqual([]);
      expect(await newColumns()).toEqual([]);
      expect(await lockTimeout()).toBe(lockTimeoutBefore);
      expect(await legacyFingerprint()).toBe(fingerprintBefore);
    });

    it('accepts PostgreSQL 11 itself (the boundary) and the server it really runs on', async () => {
      const runner = dataSource.createQueryRunner();
      try {
        await migration.up(observed(runner, { serverVersionNum: '110000' }));
      } finally {
        await runner.release();
      }
      expect(await newColumns()).toHaveLength(2);
      await run('down');
      expect(await newColumns()).toEqual([]);
      expect(Number((await q<{ v: string }>(`SELECT current_setting('server_version_num') AS v`))[0]!.v)).toBeGreaterThanOrEqual(110000);
    });
  });

  describe('up()', () => {
    it('adds exactly the two columns with the agreed types, NOT NULL and constant defaults', async () => {
      const observedTimeouts: string[] = [];
      const runner = dataSource.createQueryRunner();
      try {
        await migration.up(
          observed(runner, {
            beforeAlter: async () => {
              observedTimeouts.push(String(((await runner.query(`SELECT current_setting('lock_timeout') AS v`)) as Array<{ v: string }>)[0]!.v));
            },
          }),
        );
      } finally {
        await runner.release();
      }
      expect(observedTimeouts).toEqual(['5s']); // a short lock_timeout was in force while the ALTER ran ...
      expect(await lockTimeout()).toBe(lockTimeoutBefore); // ... and is back to what it was

      expect(await newColumns()).toEqual([
        { column_name: 'credentials_version', data_type: 'integer', is_nullable: 'NO', column_default: '0' },
        { column_name: 'must_change_password', data_type: 'boolean', is_nullable: 'NO', column_default: 'false' },
      ]);
      const after = await columnNames();
      expect(after.filter((c) => !columnsBefore.includes(c)).sort()).toEqual(NEW_COLUMNS);
      expect(after.filter((c) => columnsBefore.includes(c))).toEqual(columnsBefore); // nothing else added, removed or reordered
    });

    it('does not alter any existing user: emails, hashes, roles, business links, flags and timestamps are identical', async () => {
      expect(await legacyFingerprint()).toBe(fingerprintBefore);
      const rows = await q<{ id: string; role: string; business_id: string | null }>(`SELECT id, role, business_id FROM users ORDER BY email`);
      expect(rows).toEqual([
        { id: legacyAdminId, role: 'ADMIN', business_id: business.id },
        { id: legacySuperAdminId, role: 'SUPER_ADMIN', business_id: null },
      ]);
    });

    it('existing users get credentials_version = 0 and must_change_password = false', async () => {
      const rows = await q(`SELECT credentials_version, must_change_password FROM users`);
      expect(rows).toEqual([
        { credentials_version: 0, must_change_password: false },
        { credentials_version: 0, must_change_password: false },
      ]);
    });

    it('new users get the same defaults, whether inserted by the entity (mapping the columns, none set), by raw SQL, or like the bootstrap CLI does', async () => {
      const userRepo = dataSource.getRepository(User);
      await userRepo.save(userRepo.create({ email: 'entity@credentials-schema.test', passwordHash: 'h', role: UserRole.ADMIN, businessId: business.id }));
      await q(`INSERT INTO users (email, password_hash, role, business_id) VALUES ('raw@credentials-schema.test', 'h', 'ADMIN', $1)`, [business.id]);
      await q(
        `INSERT INTO users (email, password_hash, role, business_id, active) VALUES ('cli@credentials-schema.test', 'h', 'SUPER_ADMIN', NULL, true)`,
      );
      const rows = await q(`SELECT credentials_version, must_change_password FROM users WHERE email LIKE '%@credentials-schema.test' AND email NOT IN ($1, $2)`, [
        admin.email,
        superAdmin.email,
      ]);
      expect(rows).toHaveLength(3);
      for (const row of rows) expect(row).toEqual({ credentials_version: 0, must_change_password: false });
      await q(`DELETE FROM users WHERE email IN ('entity@credentials-schema.test', 'raw@credentials-schema.test', 'cli@credentials-schema.test')`);
    });

    it('both columns reject NULL (checked inside the database, without leaving a failed statement on the connection)', async () => {
      await q(
        `DO $$
         DECLARE r text := 'accepted';
         BEGIN
           BEGIN
             INSERT INTO users (email, password_hash, role, credentials_version) VALUES ('null-a@credentials-schema.test', 'h', 'SUPER_ADMIN', NULL);
           EXCEPTION WHEN not_null_violation THEN r := 'rejected';
           END;
           IF r = 'accepted' THEN RAISE EXCEPTION 'credentials_version accepted NULL'; END IF;
           BEGIN
             INSERT INTO users (email, password_hash, role, must_change_password) VALUES ('null-b@credentials-schema.test', 'h', 'SUPER_ADMIN', NULL);
           EXCEPTION WHEN not_null_violation THEN r := 'rejected-both';
           END;
           IF r <> 'rejected-both' THEN RAISE EXCEPTION 'must_change_password accepted NULL'; END IF;
         END $$`,
      ); // the block itself raises if either column accepted NULL
      expect(await q(`SELECT 1 FROM users WHERE email LIKE 'null-%@credentials-schema.test'`)).toEqual([]);
      expect(await legacyFingerprint()).toBe(fingerprintBefore);
    });

    it('the application works on the migrated schema: login and /auth/me; new tokens carry cv = 0, nothing else changed in the JWT', async () => {
      const adminLogin = await request(app.getHttpServer()).post('/auth/login').send(admin).expect(200);
      const superLogin = await request(app.getHttpServer()).post('/auth/login').send(superAdmin).expect(200);
      expect(Object.keys(adminLogin.body).sort()).toEqual(['accessToken', 'user']);
      expect(adminLogin.body.user).toEqual({ id: legacyAdminId, email: admin.email, role: 'ADMIN', businessId: business.id, active: true, mustChangePassword: false });
      expect(superLogin.body.user).toEqual({ id: legacySuperAdminId, email: superAdmin.email, role: 'SUPER_ADMIN', businessId: null, active: true, mustChangePassword: false });

      for (const login of [adminLogin, superLogin]) {
        const payload = JSON.parse(Buffer.from(String(login.body.accessToken).split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
        expect(Object.keys(payload).sort()).toEqual(['businessId', 'cv', 'email', 'exp', 'iat', 'role', 'sub']);
        expect(payload.cv).toBe(0);
        const me = await request(app.getHttpServer()).get('/auth/me').set('Authorization', `Bearer ${String(login.body.accessToken)}`).expect(200);
        expect(me.body).toEqual(login.body.user);
      }
    });

    it('a token issued BEFORE the migration by the previous runtime (no cv claim) is still accepted after it: existing sessions survive the deploy', async () => {
      await request(app.getHttpServer()).get('/auth/me').set('Authorization', `Bearer ${legacyToken}`).expect(200);
      expect(await legacyFingerprint()).toBe(fingerprintBefore);
    });
  });

  describe('down()', () => {
    it('removes only the two columns and leaves every other column and row identical', async () => {
      await run('down');
      expect(await newColumns()).toEqual([]);
      expect(await columnNames()).toEqual(columnsBefore);
      expect(await legacyFingerprint()).toBe(fingerprintBefore);
      expect(await lockTimeout()).toBe(lockTimeoutBefore);
      // (the application itself needs the columns now, so it is not exercised on the rolled-back schema: that is why the
      // migration must be applied BEFORE the code that maps them, and down() must not be used while that code runs)
    });

    it('can be applied again after a rollback (up -> down -> up) with the same result', async () => {
      await run('up');
      expect(await newColumns()).toHaveLength(2);
      expect(await q(`SELECT credentials_version, must_change_password FROM users`)).toEqual([
        { credentials_version: 0, must_change_password: false },
        { credentials_version: 0, must_change_password: false },
      ]);
      expect(await legacyFingerprint()).toBe(fingerprintBefore);
    });
  });
});
