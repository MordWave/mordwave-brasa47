import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcrypt';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource, QueryRunner } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import type { SqlExecutor } from '../src/cli/bootstrap-super-admin/bootstrap-db.js';
import { BootstrapDb } from '../src/cli/bootstrap-super-admin/bootstrap-db.js';
import type { TargetInfo } from '../src/cli/bootstrap-super-admin/connection.js';
import { EXIT, runBootstrap, type Configured } from '../src/cli/bootstrap-super-admin/core.js';
import { listExpectedMigrations } from '../src/cli/bootstrap-super-admin/main.js';
import type { Prompter } from '../src/cli/bootstrap-super-admin/prompter.js';
import { runCheck, runRecovery, type RecoveryConfigured } from '../src/cli/recover-super-admin/core.js';
import { RecoveryDb, type RecoveryOperation } from '../src/cli/recover-super-admin/recovery-db.js';
import { ALL_MIGRATIONS, runAllMigrations } from './support/run-all-migrations.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

// The recovery CLI against the REAL backend: the accounts are created by the bootstrap CLI, modified by the recovery CLI,
// and then used through the application's own HTTP API (login, /auth/me, the forced-password-change guard), so what is
// proved is the thing that matters: a recovery operation takes effect on the next request of every JWT issued before it,
// and leaves the application's authentication working.
//
// The CLI and the app share the ONE connection PGlite tolerates (the app's pool is size 1): the CLI borrows it through a
// query runner for the duration of one run and gives it back.
describe('recover-super-admin with the real backend (e2e, real local Postgres)', () => {
  let testDb: TestDatabase;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let counter = 0;

  const PASSWORD = 'initial-Passw0rd-for-root';
  const NEW_PASSWORD = 'recovered-Passw0rd-for-root';
  const CHOSEN_PASSWORD = 'chosen-by-the-owner-Passw0rd';
  const EMAIL = 'root@recover-auth.test';
  const REASON = 'Pérdida de acceso del titular, ticket 1234';
  const TARGET: TargetInfo = { source: 'DB_*', host: '127.0.0.1', port: '0', database: 'postgres', ssl: false, environment: 'test', service: null };
  const expectedMigrations = listExpectedMigrations();

  const nextIp = () => `198.51.100.${(counter += 1) % 250}`;
  const http = () => request(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`);
  const login = (password: string) => http().post('/auth/login').set('X-Real-IP', nextIp()).send({ email: EMAIL, password });
  const authed = (method: 'get' | 'post', path: string, token: string) => http()[method](path).set('Authorization', `Bearer ${token}`).set('X-Real-IP', nextIp());
  const me = (token: string) => authed('get', '/auth/me', token);
  const businesses = (token: string) => authed('get', '/businesses', token); // SUPER_ADMIN-only, NOT allowed while a password change is pending
  const db = async (sql: string, params?: unknown[]) => (await dataSource.query(sql, params)) as Array<Record<string, any>>;
  const userRow = async () => (await db('SELECT * FROM users WHERE email = $1', [EMAIL]))[0]!;
  const auditActions = async () => (await db('SELECT action FROM platform_audit_logs WHERE target_email = $1 ORDER BY created_at, id', [EMAIL])).map((r) => r.action);
  const phraseFor = (operation: RecoveryOperation) =>
    operation === 'reset-password' ? `RESTABLECER CONTRASEÑA DE ${EMAIL} EN test` : operation === 'reactivate' ? `REACTIVAR ${EMAIL} EN test` : `REVOCAR SESIONES DE ${EMAIL} EN test`;

  // One CLI "session": borrows the app's only connection, hands it back on close().
  function cliConnection() {
    let runner: QueryRunner | null = null;
    const sql: SqlExecutor = {
      query: async (text, params) => {
        const result = await runner!.query(text, params, true);
        return { rows: (result.records ?? []) as Array<Record<string, unknown>> };
      },
    };
    return {
      sql,
      connect: async () => void (runner = dataSource.createQueryRunner()),
      close: async () => {
        await runner?.release();
        runner = null;
      },
    };
  }
  const prompter = (visible: string[], hidden: string[]): Prompter => ({ isInteractive: () => true, ask: async () => visible.shift() ?? '', askHidden: async () => hidden.shift() ?? '' });

  async function recover(operation: RecoveryOperation, password?: string) {
    const out: string[] = [];
    const conn = cliConnection();
    const code = await runRecovery(
      {
        configure: (): RecoveryConfigured => ({ target: TARGET, db: new RecoveryDb(conn.sql), connect: conn.connect, close: conn.close }),
        expectedMigrations,
        out: (line) => void out.push(line),
        prompter: prompter([REASON, '', phraseFor(operation)], password ? [password, password] : []),
        hashPassword: (p) => bcrypt.hash(p, 4),
      },
      { operation, email: EMAIL },
    );
    return { code, text: out.join('\n') };
  }
  async function bootstrap(email: string, password: string) {
    const out: string[] = [];
    const conn = cliConnection();
    const code = await runBootstrap(
      {
        configure: (): Configured => ({ target: TARGET, db: new BootstrapDb(conn.sql), connect: conn.connect, close: conn.close }),
        expectedMigrations,
        out: (line) => void out.push(line),
        prompter: prompter([`CREAR SUPER_ADMIN ${email}`], [password, password]),
        hashPassword: (p) => bcrypt.hash(p, 4),
      },
      { email },
    );
    return { code, text: out.join('\n') };
  }
  async function check() {
    const out: string[] = [];
    const conn = cliConnection();
    const code = await runCheck(
      { configure: (): RecoveryConfigured => ({ target: TARGET, db: new RecoveryDb(conn.sql), connect: conn.connect, close: conn.close }), expectedMigrations, out: (l) => void out.push(l) },
      { email: EMAIL },
    );
    return { code, text: out.join('\n') };
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
    process.env.CLIENT_IP_HEADER = 'x-real-ip';

    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication<INestApplication<App>>();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    dataSource = moduleFixture.get(DataSource);
    await runAllMigrations(dataSource);

    // what TypeORM's migration runner records, so the CLIs' "every migration applied" check sees a real production-like state
    await db('CREATE TABLE "migrations" ("id" SERIAL PRIMARY KEY, "timestamp" bigint NOT NULL, "name" character varying NOT NULL)');
    for (const Migration of ALL_MIGRATIONS) {
      const name = new Migration().name!;
      await db('INSERT INTO migrations (timestamp, name) VALUES ($1, $2)', [Number(name.match(/(\d+)$/)![1]), name]);
    }
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await testDb?.stop();
  });

  it('the CLIs see the application\'s own database as a valid, fully migrated target (compatibility with the 18 migrations)', async () => {
    expect(expectedMigrations).toHaveLength(18);
    const created = await bootstrap(EMAIL, PASSWORD);
    expect(created.code).toBe(EXIT.ok);
    expect(created.text).toMatch(/SUPER_ADMIN_BOOTSTRAPPED registrado/);
    expect(await auditActions()).toEqual(['SUPER_ADMIN_BOOTSTRAPPED']);
    const checked = await check();
    expect(checked.code).toBe(EXIT.ok);
    expect(checked.text).toMatch(/18 migraciones/);
  });

  it('the bootstrap refuses a second SUPER_ADMIN once one exists, and writes nothing (account, audit)', async () => {
    const users = (await db('SELECT count(*)::int AS n FROM users'))[0]!.n;
    const audit = (await db('SELECT count(*)::int AS n FROM platform_audit_logs'))[0]!.n;
    const again = await bootstrap('second@recover-auth.test', PASSWORD);
    expect(again.code).toBe(EXIT.refused);
    expect(again.text).toMatch(/Ya existe un SUPER_ADMIN/);
    expect((await db('SELECT count(*)::int AS n FROM users'))[0]!.n).toBe(users);
    expect((await db('SELECT count(*)::int AS n FROM platform_audit_logs'))[0]!.n).toBe(audit);
  });

  it('revoke-sessions: every JWT issued before it stops working at the next request; the password still works and issues a fresh one', async () => {
    const first = (await login(PASSWORD).expect(200)).body.accessToken as string;
    const second = (await login(PASSWORD).expect(200)).body.accessToken as string;
    await me(first).expect(200);
    await me(second).expect(200);

    const done = await recover('revoke-sessions');
    expect(done.code).toBe(EXIT.ok);
    expect((await userRow()).credentials_version).toBe(1);

    await me(first).expect(401);
    await me(second).expect(401);
    await businesses(first).expect(401);
    const fresh = (await login(PASSWORD).expect(200)).body;
    expect(fresh.user.mustChangePassword).toBe(false); // revoking sessions does not force a password change
    await me(fresh.accessToken).expect(200);
    await businesses(fresh.accessToken).expect(200);
  });

  it('reset-password: old tokens and the old password stop working, the new password works and forces a change before anything else', async () => {
    const before = (await login(PASSWORD).expect(200)).body.accessToken as string;
    const done = await recover('reset-password', NEW_PASSWORD);
    expect(done.code).toBe(EXIT.ok);
    expect(done.text).not.toContain(NEW_PASSWORD);
    expect((await userRow()).credentials_version).toBe(2);

    await me(before).expect(401);
    await login(PASSWORD).expect(401); // the old password is gone
    const fresh = (await login(NEW_PASSWORD).expect(200)).body;
    expect(fresh.user.mustChangePassword).toBe(true);
    await me(fresh.accessToken).expect(200); // allowed while the change is pending
    expect((await businesses(fresh.accessToken).expect(403)).body.errorCode).toBe('PASSWORD_CHANGE_REQUIRED');

    // the owner chooses their own password: the application clears the flag and the account is fully usable again
    const changed = await authed('post', '/auth/change-password', fresh.accessToken).send({ currentPassword: NEW_PASSWORD, newPassword: CHOSEN_PASSWORD }).expect(200);
    expect(changed.body.user.mustChangePassword).toBe(false);
    await businesses(changed.body.accessToken).expect(200);
    await me(fresh.accessToken).expect(401); // the change revoked the temporary session as well
    const row = await userRow();
    expect(row.must_change_password).toBe(false);
    expect(row.credentials_version).toBe(3);
  });

  it('a recovery run that was prepared before the owner changed the password does not overwrite it', async () => {
    // The same race as the PGlite suite, end to end: the operator reads the account (version 3), the owner changes the
    // password through the API, and only then does the operator confirm.
    const out: string[] = [];
    const conn = cliConnection();
    const visible = [REASON, ''];
    const code = await runRecovery(
      {
        configure: (): RecoveryConfigured => ({ target: TARGET, db: new RecoveryDb(conn.sql), connect: conn.connect, close: conn.close }),
        expectedMigrations,
        out: (line) => void out.push(line),
        prompter: {
          isInteractive: () => true,
          ask: async () => {
            if (visible.length === 2) {
              // the owner acts while the operator is typing — the CLI's connection is released for this instant
              await conn.close();
              const token = (await login(CHOSEN_PASSWORD).expect(200)).body.accessToken as string;
              await authed('post', '/auth/change-password', token).send({ currentPassword: CHOSEN_PASSWORD, newPassword: 'the-newest-Passw0rd-xyz' }).expect(200);
              await conn.connect();
            }
            return visible.shift() ?? phraseFor('reset-password');
          },
          askHidden: async () => NEW_PASSWORD,
        },
        hashPassword: (p) => bcrypt.hash(p, 4),
      },
      { operation: 'reset-password', email: EMAIL },
    );
    expect(code).toBe(EXIT.refused);
    expect(out.join('\n')).toMatch(/no se sobrescribió nada/);
    expect(await bcrypt.compare('the-newest-Passw0rd-xyz', (await userRow()).password_hash)).toBe(true);
    await login('the-newest-Passw0rd-xyz').expect(200);
    await login(NEW_PASSWORD).expect(401);
  });

  it('reactivate: a token issued BEFORE the account was deactivated stays dead after reactivation; the pending temporary-password flag survives', async () => {
    const before = (await login('the-newest-Passw0rd-xyz').expect(200)).body.accessToken as string;
    await me(before).expect(200);

    await db('UPDATE users SET active = false, must_change_password = true WHERE email = $1', [EMAIL]);
    await me(before).expect(401); // inactive accounts are refused
    await login('the-newest-Passw0rd-xyz').expect(401);

    const done = await recover('reactivate');
    expect(done.code).toBe(EXIT.ok);
    const row = await userRow();
    expect(row.active).toBe(true);
    expect(row.must_change_password).toBe(true); // reactivation does not clear the pending flag

    await me(before).expect(401); // would have revived without the version bump
    const fresh = (await login('the-newest-Passw0rd-xyz').expect(200)).body;
    expect(fresh.user.mustChangePassword).toBe(true);
    expect((await businesses(fresh.accessToken).expect(403)).body.errorCode).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('reset-password on a deactivated account changes the password but the account still cannot log in', async () => {
    await db('UPDATE users SET active = false WHERE email = $1', [EMAIL]);
    expect((await recover('reset-password', NEW_PASSWORD)).code).toBe(EXIT.ok);
    expect((await userRow()).active).toBe(false);
    await login(NEW_PASSWORD).expect(401);
    expect((await recover('reactivate')).code).toBe(EXIT.ok);
    await login(NEW_PASSWORD).expect(200);
  });

  it('the audit trail of the whole story is complete: one event per successful operation, no secrets, no actor', async () => {
    expect(await auditActions()).toEqual([
      'SUPER_ADMIN_BOOTSTRAPPED',
      'SUPER_ADMIN_SESSIONS_REVOKED',
      'SUPER_ADMIN_PASSWORD_RESET',
      'SUPER_ADMIN_REACTIVATED',
      'SUPER_ADMIN_PASSWORD_RESET',
      'SUPER_ADMIN_REACTIVATED',
    ]);
    const rows = await db('SELECT * FROM platform_audit_logs WHERE target_email = $1', [EMAIL]);
    for (const row of rows) expect(row.actor_user_id).toBeNull();
    const dump = JSON.stringify(rows);
    for (const secret of [PASSWORD, NEW_PASSWORD, CHOSEN_PASSWORD, 'the-newest-Passw0rd-xyz', String((await userRow()).password_hash)]) expect(dump).not.toContain(secret);
    expect(dump).not.toMatch(/\$2[aby]\$|eyJ/);
  });
});
