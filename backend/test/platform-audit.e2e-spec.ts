import bcrypt from 'bcrypt';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource, type QueryRunner } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { Business } from '../src/business/business.entity.js';
import { AddPlatformAuditLogs1790500000000 } from '../src/migrations/1790500000000-AddPlatformAuditLogs.js';
import { User } from '../src/user/user.entity.js';
import { UserRole } from '../src/user/user-role.enum.js';
import { runMigrationsBefore } from './support/run-all-migrations.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

const TEST_BCRYPT_COST = 4;
const EXPECTED_COLUMNS = [
  'id',
  'created_at',
  'action',
  'source',
  'environment',
  'target_user_id',
  'target_email',
  'actor_user_id',
  'operator_label',
  'reason',
  'metadata',
];

// The platform audit table (8D.2d-6a), exercised on a real Postgres (ephemeral PGlite) at the exact schema state right
// before it, with users and business data that already exist: the migration must leave them, the audit_logs table and the
// authentication of the CURRENT application untouched.
//
// Rejections are checked INSIDE the database (a DO block that swallows the expected violation and raises if the statement
// was accepted or failed on another constraint): a failed parameterised statement can desynchronise PGlite's socket, so no
// server-side error is ever sent back to the client here.
//
// Not demonstrable here (PGlite is one session): lock waits and lock_timeout expiry under a competing transaction.
describe('AddPlatformAuditLogs migration (e2e, real local Postgres)', () => {
  let testDb: TestDatabase;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let business: Business;
  let adminId: string;
  let superId: string;
  const migration = new AddPlatformAuditLogs1790500000000();
  const admin = { email: 'admin@platform-audit.test', password: 'Sup3rSecret!Admin' };

  async function run(direction: 'up' | 'down'): Promise<void> {
    const queryRunner = dataSource.createQueryRunner();
    try {
      await migration[direction](queryRunner);
    } finally {
      await queryRunner.release();
    }
  }

  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => dataSource.query(sql, params) as Promise<T[]>;
  const tableExists = async () => (await q<{ r: string | null }>(`SELECT to_regclass('public.platform_audit_logs')::text AS r`))[0]!.r !== null;
  const count = async () => (await q<{ n: number }>(`SELECT count(*)::int AS n FROM platform_audit_logs`))[0]!.n;
  const lockTimeout = async () => (await q<{ v: string }>(`SELECT current_setting('lock_timeout') AS v`))[0]!.v;

  // fingerprint of what must not change
  const fingerprint = async () =>
    (
      await q<{ h: string }>(
        `SELECT md5(
           coalesce((SELECT string_agg(u::text, ';' ORDER BY id) FROM users u), '') || '#' ||
           coalesce((SELECT string_agg(b::text, ';' ORDER BY id) FROM businesses b), '') || '#' ||
           coalesce((SELECT string_agg(a::text, ';' ORDER BY id) FROM audit_logs a), '')) AS h`,
      )
    )[0]!.h;
  const auditLogsDefinition = async () =>
    q(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'audit_logs' ORDER BY ordinal_position`);

  // `statement` must be refused with `when` (a PL/pgSQL condition name); `constraint` / `column` pin down which rule did it
  async function rejected(statement: string, when: string, opts: { constraint?: string; column?: string; message?: string } = {}): Promise<void> {
    const check = opts.constraint
      ? `IF c IS DISTINCT FROM '${opts.constraint}' THEN RAISE EXCEPTION 'refused by the wrong constraint: %', c; END IF;`
      : opts.column
        ? `IF col IS DISTINCT FROM '${opts.column}' THEN RAISE EXCEPTION 'refused on the wrong column: %', col; END IF;`
        : opts.message
          ? `IF m NOT LIKE '%${opts.message}%' THEN RAISE EXCEPTION 'refused with another message: %', m; END IF;`
          : '';
    await q(
      `DO $$ DECLARE c text; col text; m text; BEGIN
         BEGIN
           ${statement};
           RAISE EXCEPTION 'ACCEPTED: the statement should have been refused';
         EXCEPTION WHEN ${when} THEN
           GET STACKED DIAGNOSTICS c = CONSTRAINT_NAME, col = COLUMN_NAME, m = MESSAGE_TEXT;
           ${check}
         END;
       END $$`,
    );
  }

  const insert = (cols: Record<string, string | null>) => {
    const entries = Object.entries(cols);
    const lit = (v: string | null) => (v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`);
    return `INSERT INTO platform_audit_logs (${entries.map(([k]) => k).join(', ')}) VALUES (${entries.map(([, v]) => lit(v)).join(', ')})`;
  };
  const ok = (cols: Record<string, string | null>) => q(`${insert(cols)} RETURNING id`);

  // wraps the real query runner: the ALTER/CREATE statements can be observed, or made to fail on the CLIENT side
  function observed(real: QueryRunner, hooks: { failOn?: RegExp; seenLockTimeout?: string[] }): QueryRunner {
    return new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'query') {
          return async (sql: string, params?: unknown[]) => {
            if (/^\s*ALTER TABLE "platform_audit_logs"/.test(sql)) {
              hooks.seenLockTimeout?.push(String(((await target.query(`SELECT current_setting('lock_timeout') AS v`)) as Array<{ v: string }>)[0]!.v));
            }
            if (hooks.failOn?.test(sql)) throw new Error('injected failure');
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

    // the schema exactly as production has it today (every migration before this one) ...
    await runMigrationsBefore(dataSource, AddPlatformAuditLogs1790500000000);

    // ... with data that already exists
    const businessRepo = dataSource.getRepository(Business);
    business = await businessRepo.save(businessRepo.create({ name: 'Audit Co', slug: 'audit-co-platform' }));
    const userRepo = dataSource.getRepository(User);
    adminId = (await userRepo.save(userRepo.create({ email: admin.email, passwordHash: await bcrypt.hash(admin.password, TEST_BCRYPT_COST), role: UserRole.ADMIN, businessId: business.id }))).id;
    superId = (await userRepo.save(userRepo.create({ email: 'root@platform-audit.test', passwordHash: await bcrypt.hash('Sup3rSecret!Root', TEST_BCRYPT_COST), role: UserRole.SUPER_ADMIN, businessId: null }))).id;
    await q(
      `INSERT INTO audit_logs (business_id, user_id, user_email, action, entity_type, metadata) VALUES ($1, $2, $3, 'PRODUCT_CREATED', 'Product', '{"name":"x"}')`,
      [business.id, adminId, admin.email],
    );
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await testDb?.stop();
  });

  let before: { fingerprint: string; auditLogs: unknown; lockTimeout: string };

  it('before the migration the table does not exist', async () => {
    expect(await tableExists()).toBe(false);
    before = { fingerprint: await fingerprint(), auditLogs: await auditLogsDefinition(), lockTimeout: await lockTimeout() };
  });

  describe('a failure leaves nothing behind', () => {
    it('a failure in the middle of up() inside a transaction rolls everything back, lock_timeout included', async () => {
      const runner = dataSource.createQueryRunner();
      const seen: string[] = [];
      try {
        await runner.startTransaction();
        await expect(migration.up(observed(runner, { failOn: /CREATE TRIGGER "TRG_platform_audit_logs_append_only"/, seenLockTimeout: seen }))).rejects.toThrow('injected failure');
        expect(seen[0]).toBe('5s'); // a short lock_timeout was in force while the DDL ran
        await runner.rollbackTransaction();
      } finally {
        await runner.release();
      }
      expect(await tableExists()).toBe(false);
      expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'platform_audit_logs_append_only'`))[0]!.n).toBe(0);
      expect(await lockTimeout()).toBe(before.lockTimeout);
    });

    it('outside a transaction a failure still restores the session lock_timeout', async () => {
      const runner = dataSource.createQueryRunner();
      try {
        await expect(migration.up(observed(runner, { failOn: /CREATE INDEX "IDX_platform_audit_logs_created_id"/ }))).rejects.toThrow('injected failure');
      } finally {
        await runner.release();
      }
      expect(await lockTimeout()).toBe(before.lockTimeout);
      await q(`DROP TABLE IF EXISTS platform_audit_logs`); // outside a transaction the half-made table stays: clean the harness
    });
  });

  describe('up()', () => {
    it('creates exactly the agreed columns, with the right types and nullability (and none that could hold a secret)', async () => {
      await run('up');
      const columns = await q<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
        `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'platform_audit_logs' ORDER BY ordinal_position`,
      );
      expect(columns.map((c) => c.column_name)).toEqual(EXPECTED_COLUMNS);
      const by = Object.fromEntries(columns.map((c) => [c.column_name, c]));
      for (const name of ['id', 'created_at', 'action', 'source', 'metadata']) expect(by[name]!.is_nullable, name).toBe('NO');
      for (const name of ['environment', 'target_user_id', 'target_email', 'actor_user_id', 'operator_label', 'reason']) expect(by[name]!.is_nullable, name).toBe('YES');
      expect(by.id!.data_type).toBe('uuid');
      expect(by.created_at!.data_type).toBe('timestamp with time zone');
      expect(by.metadata!.data_type).toBe('jsonb');
      expect(by.metadata!.column_default).toContain('{}');
      expect(columns.map((c) => c.column_name).join(' ')).not.toMatch(/password|hash|token|jwt|secret|key|credential/i);
    });

    it('has the primary key, the three indexes and the two SET NULL foreign keys', async () => {
      const indexes = (await q<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'platform_audit_logs' ORDER BY indexname`)).map((r) => r.indexname);
      expect(indexes).toEqual(['IDX_platform_audit_logs_action_created', 'IDX_platform_audit_logs_created_id', 'IDX_platform_audit_logs_target_created', 'PK_platform_audit_logs']);
      const fks = await q<{ conname: string; confdeltype: string; refs: string }>(
        `SELECT conname, confdeltype, confrelid::regclass::text AS refs FROM pg_constraint WHERE conrelid = 'platform_audit_logs'::regclass AND contype = 'f' ORDER BY conname`,
      );
      expect(fks).toEqual([
        { conname: 'FK_platform_audit_logs_actor_user_id', confdeltype: 'n', refs: 'users' },
        { conname: 'FK_platform_audit_logs_target_user_id', confdeltype: 'n', refs: 'users' },
      ]);
    });

    it('does not alter users, businesses or audit_logs: every row identical, audit_logs definition unchanged', async () => {
      expect(await fingerprint()).toBe(before.fingerprint);
      expect(await auditLogsDefinition()).toEqual(before.auditLogs);
      expect(await lockTimeout()).toBe(before.lockTimeout);
    });

    it('the CURRENT application keeps working with the table present: login and /auth/me are unchanged', async () => {
      const server = app.getHttpServer();
      const login = await request(server).post('/auth/login').send(admin).expect(200);
      expect(login.body.user).toMatchObject({ id: adminId, email: admin.email, role: 'ADMIN', mustChangePassword: false });
      await request(server).get('/auth/me').set('Authorization', `Bearer ${String(login.body.accessToken)}`).expect(200);
      expect(await count()).toBe(0); // and the application wrote nothing to the new table
    });
  });

  describe('constraints and required fields', () => {
    it('accepts a record with NO authenticated actor (the bootstrap case): only action and source are needed', async () => {
      const rows = await ok({ action: 'SUPER_ADMIN_BOOTSTRAPPED', source: 'bootstrap-cli' });
      expect(rows).toHaveLength(1);
      const [row] = await q(`SELECT * FROM platform_audit_logs WHERE id = $1`, [(rows[0] as { id: string }).id]);
      expect(row).toMatchObject({ action: 'SUPER_ADMIN_BOOTSTRAPPED', source: 'bootstrap-cli', actor_user_id: null, target_user_id: null, target_email: null, reason: null, operator_label: null, environment: null, metadata: {} });
      expect(row!.created_at).toBeInstanceOf(Date);
      expect(String(row!.id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    });

    it('a bootstrap record for an account that does not exist yet, and a recovery record with everything filled in', async () => {
      await ok({ action: 'SUPER_ADMIN_BOOTSTRAPPED', source: 'bootstrap-cli', environment: 'production', target_email: 'new-root@platform-audit.test', operator_label: 'wal (typed, unverified)' });
      await ok({
        action: 'SUPER_ADMIN_PASSWORD_RESET',
        source: 'recovery-cli',
        environment: 'production',
        target_user_id: superId,
        target_email: 'root@platform-audit.test',
        operator_label: 'wal (typed, unverified)',
        reason: 'lost password, owner verified out of band',
      });
      const [r] = await q(`SELECT * FROM platform_audit_logs WHERE action = 'SUPER_ADMIN_PASSWORD_RESET'`);
      expect(r).toMatchObject({ target_user_id: superId, target_email: 'root@platform-audit.test', reason: 'lost password, owner verified out of band' });
    });

    it('a record may also carry an authenticated actor (a user of the application)', async () => {
      await ok({ action: 'SUPER_ADMIN_SESSIONS_REVOKED', source: 'api', actor_user_id: superId, target_user_id: superId });
      expect((await q(`SELECT 1 FROM platform_audit_logs WHERE actor_user_id = $1`, [superId])).length).toBe(1);
    });

    it('action and source are required, and have a shape (SCREAMING_SNAKE / lower-kebab)', async () => {
      await rejected(`INSERT INTO platform_audit_logs (source) VALUES ('recovery-cli')`, 'not_null_violation', { column: 'action' });
      await rejected(`INSERT INTO platform_audit_logs (action) VALUES ('SUPER_ADMIN_PASSWORD_RESET')`, 'not_null_violation', { column: 'source' });
      await rejected(insert({ action: `X${'A'.repeat(80)}`, source: 'recovery-cli' }), 'string_data_right_truncation'); // 81 characters: the column itself refuses
      for (const action of ['lowercase', 'Mixed_Case', 'A', 'HAS SPACE', '1STARTS_WITH_DIGIT', '']) {
        await rejected(insert({ action, source: 'recovery-cli' }), 'check_violation', { constraint: 'CHK_platform_audit_logs_action' });
      }
      await rejected(insert({ action: 'SUPER_ADMIN_PASSWORD_RESET', source: `a${'b'.repeat(40)}` }), 'string_data_right_truncation');
      for (const source of ['Recovery-CLI', 'x', 'has space', '1cli', '']) {
        await rejected(insert({ action: 'SUPER_ADMIN_PASSWORD_RESET', source }), 'check_violation', { constraint: 'CHK_platform_audit_logs_source' });
      }
    });

    it('a reason or operator label, when given, cannot be blank; lengths are bounded by the column', async () => {
      await rejected(insert({ action: 'SUPER_ADMIN_PASSWORD_RESET', source: 'recovery-cli', reason: '   ' }), 'check_violation', { constraint: 'CHK_platform_audit_logs_reason' });
      await rejected(insert({ action: 'SUPER_ADMIN_PASSWORD_RESET', source: 'recovery-cli', operator_label: ' ' }), 'check_violation', { constraint: 'CHK_platform_audit_logs_operator_label' });
      await rejected(insert({ action: 'SUPER_ADMIN_PASSWORD_RESET', source: 'recovery-cli', reason: 'x'.repeat(501) }), 'string_data_right_truncation');
      await rejected(insert({ action: 'SUPER_ADMIN_PASSWORD_RESET', source: 'recovery-cli', operator_label: 'x'.repeat(121) }), 'string_data_right_truncation');
      await ok({ action: 'SUPER_ADMIN_PASSWORD_RESET', source: 'recovery-cli', reason: 'x'.repeat(500), operator_label: 'x'.repeat(120) });
    });

    it('target and actor must be real users (foreign keys), never an invented id', async () => {
      const ghost = '00000000-0000-4000-8000-000000000000';
      await rejected(insert({ action: 'SUPER_ADMIN_PASSWORD_RESET', source: 'recovery-cli', target_user_id: ghost }), 'foreign_key_violation', { constraint: 'FK_platform_audit_logs_target_user_id' });
      await rejected(insert({ action: 'SUPER_ADMIN_PASSWORD_RESET', source: 'recovery-cli', actor_user_id: ghost }), 'foreign_key_violation', { constraint: 'FK_platform_audit_logs_actor_user_id' });
    });
  });

  describe('secret-looking KEYS are refused (values are not inspected: the tools must write only allowed fields)', () => {
    it('metadata must be a small JSON object', async () => {
      await rejected(`INSERT INTO platform_audit_logs (action, source, metadata) VALUES ('SUPER_ADMIN_PASSWORD_RESET', 'recovery-cli', '[1,2]'::jsonb)`, 'check_violation', { constraint: 'CHK_platform_audit_logs_metadata_object' });
      await rejected(`INSERT INTO platform_audit_logs (action, source, metadata) VALUES ('SUPER_ADMIN_PASSWORD_RESET', 'recovery-cli', '"text"'::jsonb)`, 'check_violation', { constraint: 'CHK_platform_audit_logs_metadata_object' });
      await rejected(
        `INSERT INTO platform_audit_logs (action, source, metadata) VALUES ('SUPER_ADMIN_PASSWORD_RESET', 'recovery-cli', jsonb_build_object('note', repeat(md5(random()::text), 1000)))`,
        'check_violation',
        { constraint: 'CHK_platform_audit_logs_metadata_size' },
      );
      await ok({ action: 'SUPER_ADMIN_PASSWORD_RESET', source: 'recovery-cli', metadata: '{"version_before":3,"version_after":4,"active_after":true,"forced_change":true}' } as never);
    });

    it('a metadata object with a key named like a secret is refused, at any depth and in any case', async () => {
      for (const key of ['password', 'newPassword', 'PASSWORD_HASH', 'passwordHash', 'token', 'accessToken', 'jwt', 'authorization', 'api_key', 'apiKey', 'secret', 'sshKey', 'privateKey', 'credentials', 'hash']) {
        await rejected(
          `INSERT INTO platform_audit_logs (action, source, metadata) VALUES ('SUPER_ADMIN_PASSWORD_RESET', 'recovery-cli', jsonb_build_object('${key}', 'x'))`,
          'check_violation',
          { constraint: 'CHK_platform_audit_logs_metadata_no_secret_keys' },
        );
      }
      await rejected(
        `INSERT INTO platform_audit_logs (action, source, metadata) VALUES ('SUPER_ADMIN_PASSWORD_RESET', 'recovery-cli', jsonb_build_object('outer', jsonb_build_object('inner', jsonb_build_object('refreshToken', 'x'))))`,
        'check_violation',
        { constraint: 'CHK_platform_audit_logs_metadata_no_secret_keys' },
      );
    });

    it('the guard looks at KEYS only: it is NOT a guarantee that free text or values are free of sensitive data (the tools must write only allowed fields)', async () => {
      // documented limitation, pinned here so nobody mistakes the CHECK for a content filter: these are accepted
      await ok({ action: 'SUPER_ADMIN_PASSWORD_RESET', source: 'recovery-cli', reason: 'free text is not inspected', metadata: '{"note":"a value is not inspected either"}' } as never);
    });

    it('ordinary non-secret facts, and values that merely mention a word, are fine (keys avoid the guarded words: version_before, forced_change...)', async () => {
      await q(
        `INSERT INTO platform_audit_logs (action, source, reason, metadata) VALUES ('SUPER_ADMIN_PASSWORD_RESET', 'recovery-cli', 'owner forgot the word password', '{"note":"reset requested, no hash here","version_before":1,"forced_change":true}'::jsonb)`,
      );
    });
  });

  describe('append-only integrity', () => {
    it('UPDATE and DELETE of a record are refused by the database, and the record is exactly as it was', async () => {
      const [{ id }] = (await ok({ action: 'SUPER_ADMIN_BOOTSTRAPPED', source: 'bootstrap-cli', target_email: 'immutable@platform-audit.test' })) as Array<{ id: string }>;
      const beforeRow = JSON.stringify((await q(`SELECT * FROM platform_audit_logs WHERE id = '${id}'`))[0]);
      for (const statement of [
        `UPDATE platform_audit_logs SET reason = 'edited' WHERE id = '${id}'`,
        `UPDATE platform_audit_logs SET action = 'SUPER_ADMIN_PASSWORD_RESET' WHERE id = '${id}'`,
        `UPDATE platform_audit_logs SET target_email = NULL WHERE id = '${id}'`,
        `UPDATE platform_audit_logs SET metadata = '{}'::jsonb, created_at = now() WHERE id = '${id}'`,
        `UPDATE platform_audit_logs SET target_user_id = '${superId}' WHERE id = '${id}'`, // pointing it at someone else is an edit too
        `DELETE FROM platform_audit_logs WHERE id = '${id}'`,
      ]) {
        await rejected(statement, 'restrict_violation', { message: 'append-only' });
      }
      expect(JSON.stringify((await q(`SELECT * FROM platform_audit_logs WHERE id = '${id}'`))[0])).toBe(beforeRow);
    });

    it('TRUNCATE and DELETE of everything are refused too', async () => {
      const total = await count();
      await rejected(`TRUNCATE platform_audit_logs`, 'restrict_violation', { message: 'append-only' });
      await rejected(`DELETE FROM platform_audit_logs`, 'restrict_violation', { message: 'append-only' });
      expect(await count()).toBe(total);
    });

    it('removing a referenced user keeps the record: the foreign key only turns the id into NULL and the e-mail snapshot remains', async () => {
      const gone = (await q<{ id: string }>(`INSERT INTO users (email, password_hash, role, business_id) VALUES ('temp-target@platform-audit.test', 'h', 'ADMIN', $1) RETURNING id`, [business.id]))[0]!.id;
      const [{ id }] = (await ok({ action: 'SUPER_ADMIN_PASSWORD_RESET', source: 'recovery-cli', target_user_id: gone, target_email: 'temp-target@platform-audit.test', actor_user_id: gone })) as Array<{ id: string }>;
      await q(`DELETE FROM users WHERE id = $1`, [gone]);
      const [row] = await q(`SELECT target_user_id, actor_user_id, target_email, action FROM platform_audit_logs WHERE id = $1`, [id]);
      expect(row).toEqual({ target_user_id: null, actor_user_id: null, target_email: 'temp-target@platform-audit.test', action: 'SUPER_ADMIN_PASSWORD_RESET' });
    });

    it('the log lives apart: nothing was written to audit_logs and the platform records are not visible there', async () => {
      expect(await auditLogsDefinition()).toEqual(before.auditLogs);
      expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM audit_logs`))[0]!.n).toBe(1);
    });
  });

  describe('down()', () => {
    it('REFUSES to run while the table holds records (dropping it would erase the audit trail) and changes nothing', async () => {
      const total = await count();
      expect(total).toBeGreaterThan(0);
      await expect(run('down')).rejects.toThrow(/refused to run, nothing was changed: platform_audit_logs holds \d+ record\(s\)/);
      expect(await tableExists()).toBe(true);
      expect(await count()).toBe(total);
    });

    it('drops an EMPTY table with its function, leaving users and audit_logs as they were; up -> down -> up works', async () => {
      // the only way to empty it is to drop the append-only trigger by hand, which is what a deliberate operator would do
      await q(`ALTER TABLE platform_audit_logs DISABLE TRIGGER USER`);
      await q(`DELETE FROM platform_audit_logs`);
      await q(`ALTER TABLE platform_audit_logs ENABLE TRIGGER USER`);
      await run('down');
      expect(await tableExists()).toBe(false);
      expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'platform_audit_logs_append_only'`))[0]!.n).toBe(0);
      expect(await auditLogsDefinition()).toEqual(before.auditLogs);
      await run('up');
      expect(await tableExists()).toBe(true);
      expect(await count()).toBe(0);
      expect(await lockTimeout()).toBe(before.lockTimeout);
    });
  });
});
