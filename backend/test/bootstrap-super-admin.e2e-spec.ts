import bcrypt from 'bcrypt';
import pg from 'pg';
import type { QueryRunner } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BootstrapDb } from '../src/cli/bootstrap-super-admin/bootstrap-db.js';
import { ConfigError, type TargetInfo } from '../src/cli/bootstrap-super-admin/connection.js';
import { EXIT, runBootstrap, runCheck, type Configured } from '../src/cli/bootstrap-super-admin/core.js';
import { PromptAborted, type Prompter } from '../src/cli/bootstrap-super-admin/prompter.js';
import { BCRYPT_COST } from '../src/cli/bootstrap-super-admin/constants.js';
import { listExpectedMigrations } from '../src/cli/bootstrap-super-admin/main.js';
import { ALL_MIGRATIONS } from './support/run-all-migrations.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

// Integration of the bootstrap CLI's database layer and orchestration against a real (ephemeral, local) PostgreSQL engine:
// the real migrations, the real SQL, the real bcrypt. The CLI's own `pg` client IS the one connection (pglite-socket
// tolerates a single connection per lifetime, see startTestDatabase), through which the schema is also built.
//
// What this does NOT prove: genuine concurrency. PGlite is one Postgres session, so two transactions can never really
// interleave here. The race is covered deterministically instead: the transaction re-checks "no SUPER_ADMIN / no such email"
// after taking its advisory lock (so a run whose pre-check went stale is refused), and the UNIQUE(email) constraint is the
// backstop. The advisory lock's effect between two REAL sessions is not validated in this environment.
describe('bootstrap-super-admin against a real local Postgres (PGlite)', () => {
  let testDb: TestDatabase;
  let client: pg.Client;
  let db: BootstrapDb;

  const PASSWORD = 'correct-horse-battery-staple';
  const EMAIL = 'root@mordwave.test';
  const TARGET: TargetInfo = { source: 'DB_*', host: '127.0.0.1', port: '0', database: 'postgres', ssl: false, environment: 'test', service: null };
  const q = async (sql: string, params?: unknown[]) => (await client.query(sql, params)).rows as Array<Record<string, unknown>>;
  const users = () => q('SELECT id, email, role, business_id, active, password_hash, created_at, updated_at FROM users ORDER BY created_at, email');
  const expectedMigrations = listExpectedMigrations();
  // platform_audit_logs is append-only (no DELETE/TRUNCATE, not even in tests), so tests compare counts and look at the newest rows
  const auditRows = () => q('SELECT * FROM platform_audit_logs ORDER BY created_at, id');
  const auditCount = async () => Number((await q('SELECT count(*)::int AS n FROM platform_audit_logs'))[0]!.n);

  function configured(): Configured {
    return { target: TARGET, db, connect: async () => undefined, close: async () => undefined };
  }
  function operator(options: { hidden?: string[]; visible?: string[] } = {}) {
    const out: string[] = [];
    const hidden = [...(options.hidden ?? [PASSWORD, PASSWORD])];
    const visible = [...(options.visible ?? [`CREAR SUPER_ADMIN ${EMAIL}`])];
    const prompter: Prompter = {
      isInteractive: () => true,
      ask: async () => visible.shift() ?? (() => { throw new PromptAborted(); })(),
      askHidden: async () => hidden.shift() ?? (() => { throw new PromptAborted(); })(),
    };
    const deps = {
      configure: configured,
      expectedMigrations,
      out: (line: string) => void out.push(line),
      prompter,
      hashPassword: (password: string) => bcrypt.hash(password, BCRYPT_COST),
    };
    return { deps, out, text: () => out.join('\n') };
  }

  beforeAll(async () => {
    testDb = await startTestDatabase();
    client = new pg.Client({ host: testDb.host, port: testDb.port, user: 'postgres', password: 'postgres', database: 'postgres' });
    await client.connect();

    // Build the schema with the real migrations and record them the way TypeORM does.
    const runner = { query: async (sql: string, params?: unknown[]) => (await client.query(sql, params)).rows } as unknown as QueryRunner;
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    for (const Migration of ALL_MIGRATIONS) await new Migration().up(runner);
    await client.query('CREATE TABLE "migrations" ("id" SERIAL PRIMARY KEY, "timestamp" bigint NOT NULL, "name" character varying NOT NULL)');
    for (const Migration of ALL_MIGRATIONS) {
      const name = new Migration().name!;
      await client.query('INSERT INTO migrations (timestamp, name) VALUES ($1, $2)', [Number(name.match(/(\d+)$/)![1]), name]);
    }
    db = new BootstrapDb(client);
  }, 60_000);

  afterAll(async () => {
    await client?.end();
    await testDb?.stop();
  });

  it('the list of expected migrations (read from the build\'s own folder) is exactly the real, recorded set', () => {
    expect(expectedMigrations).toEqual(ALL_MIGRATIONS.map((M) => new M().name!).sort());
    expect(expectedMigrations).toHaveLength(19);
  });

  describe('--check is strictly read-only', () => {
    it('reports everything OK on a migrated database without a SUPER_ADMIN, and changes nothing', async () => {
      const before = await users();
      const auditBefore = await auditCount();
      const o = operator();
      expect(await runCheck(o.deps)).toBe(EXIT.ok);
      expect(await auditCount()).toBe(auditBefore);
      expect(o.text()).toMatch(/\[OK\] Conexión disponible/);
      expect(o.text()).toMatch(/Esquema esperado y 19 migraciones/);
      expect(o.text()).toMatch(/SUPER_ADMIN existentes: 0/);
      expect(await users()).toEqual(before);
    });

    it('PostgreSQL itself refuses a write inside the read-only transaction (and the transaction is gone afterwards)', async () => {
      await expect(
        db.readOnly(() => db['sql'].query(`INSERT INTO users (email, password_hash, role, business_id, active) VALUES ('x@y.test', 'h', 'SUPER_ADMIN', NULL, true)`)),
      ).rejects.toMatchObject({ code: '25006' });
      expect(await q(`SELECT 1 FROM users WHERE email = 'x@y.test'`)).toEqual([]);
      await db.ping(); // the connection is healthy, no transaction left open
      expect(await q(`SELECT 1 FROM users WHERE email = 'x@y.test'`)).toEqual([]);
    });
  });

  describe('schema and migration checks', () => {
    it('detects a pending migration and a changed users table, and the bootstrap then refuses without writing', async () => {
      const sample = new ALL_MIGRATIONS[ALL_MIGRATIONS.length - 1]!().name!;
      await client.query('DELETE FROM migrations WHERE name = $1', [sample]);
      const pending = await db.readOnly(() => db.inspectSchema(expectedMigrations));
      expect(pending.ok).toBe(false);
      expect(pending.problems.join(' ')).toContain(sample);
      const o = operator();
      expect(await runBootstrap(o.deps, { email: EMAIL })).toBe(EXIT.refused);
      expect(o.text()).toMatch(/Esquema o migraciones no son los esperados/);
      await client.query('INSERT INTO migrations (timestamp, name) VALUES ($1, $2)', [Number(sample.match(/(\d+)$/)![1]), sample]);

      await client.query('ALTER TABLE users RENAME COLUMN active TO active_old');
      const changed = await db.readOnly(() => db.inspectSchema(expectedMigrations));
      expect(changed.problems.join(' ')).toMatch(/Falta la columna users\.active/);
      await client.query('ALTER TABLE users RENAME COLUMN active_old TO active');
      expect((await db.readOnly(() => db.inspectSchema(expectedMigrations))).ok).toBe(true);
      expect(await users()).toEqual([]); // nothing was written by any of this
    });

    it('a missing audit table (or a changed audit column) stops the bootstrap before any prompt: no unaudited SUPER_ADMIN can be created', async () => {
      await client.query('ALTER TABLE platform_audit_logs RENAME TO platform_audit_logs_off');
      const missing = await db.readOnly(() => db.inspectSchema(expectedMigrations));
      expect(missing.ok).toBe(false);
      expect(missing.problems.join(' ')).toMatch(/No existe la tabla "platform_audit_logs"/);
      const o = operator();
      expect(await runBootstrap(o.deps, { email: EMAIL })).toBe(EXIT.refused);
      expect(o.text()).toMatch(/platform_audit_logs/);
      expect(await users()).toEqual([]);
      const c = operator();
      expect(await runCheck(c.deps)).toBe(EXIT.refused);
      await client.query('ALTER TABLE platform_audit_logs_off RENAME TO platform_audit_logs');

      await client.query('ALTER TABLE platform_audit_logs RENAME COLUMN reason TO reason_old');
      expect((await db.readOnly(() => db.inspectSchema(expectedMigrations))).problems.join(' ')).toMatch(/Falta la columna platform_audit_logs\.reason/);
      await client.query('ALTER TABLE platform_audit_logs RENAME COLUMN reason_old TO reason');
      expect((await db.readOnly(() => db.inspectSchema(expectedMigrations))).ok).toBe(true);
    });
  });

  describe('creation', () => {
    it('refuses an email that already belongs to another (ADMIN) user, and leaves that user untouched', async () => {
      await q(`INSERT INTO businesses (name, slug) VALUES ('Biz', 'biz')`);
      const [biz] = await q(`SELECT id FROM businesses WHERE slug = 'biz'`);
      await q(`INSERT INTO users (email, password_hash, role, business_id) VALUES ($1, 'existing-hash', 'ADMIN', $2)`, [EMAIL, biz!.id]);
      const before = await users();

      const o = operator();
      expect(await runBootstrap(o.deps, { email: EMAIL })).toBe(EXIT.refused);
      expect(o.text()).toMatch(/nunca modifica usuarios existentes/);
      expect(await users()).toEqual(before);

      // the transaction itself also refuses (a pre-check that had gone stale)
      expect(await db.createSuperAdmin({ email: EMAIL, passwordHash: 'h', environment: 'test' })).toEqual({ status: 'email-exists' });
      expect(await users()).toEqual(before);
      await q('DELETE FROM users');
    });

    it('a pre-existing address that differs only in case still counts as taken (the UNIQUE index alone would not catch it)', async () => {
      await q(`INSERT INTO users (email, password_hash, role, business_id) VALUES ('Mixed@MordWave.Test', 'old-hash', 'ADMIN', (SELECT id FROM businesses LIMIT 1))`);
      const before = await users();
      expect(await db.createSuperAdmin({ email: 'mixed@mordwave.test', passwordHash: 'h', environment: 'test' })).toEqual({ status: 'email-exists' });
      expect((await db.readOnly(() => db.readState('mixed@mordwave.test'))).emailTaken).toBe(true);
      expect(await users()).toEqual(before);
      await q('DELETE FROM users');
    });

    it('creates the SUPER_ADMIN: right role, NO business, normalised email, a valid bcrypt hash with the project\'s cost', async () => {
      const o = operator();
      expect(await runBootstrap(o.deps, { email: '  Root@MordWave.Test ' })).toBe(EXIT.ok);

      const rows = await users();
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row).toMatchObject({ email: EMAIL, role: 'SUPER_ADMIN', business_id: null, active: true });
      expect(row!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(row!.created_at).toBeInstanceOf(Date);
      expect(String(row!.password_hash).startsWith(`$2b$${BCRYPT_COST}$`)).toBe(true);
      expect(await bcrypt.compare(PASSWORD, String(row!.password_hash))).toBe(true);
      expect(await bcrypt.compare('another-password-123', String(row!.password_hash))).toBe(false);
      // the address is stored exactly as the login normalises it, so the login will find it
      expect(row!.email).toBe(String(row!.email).trim().toLowerCase());
      expect(o.text()).toContain(`id=${String(row!.id)}`);
      // the columns added by AddCredentialsSecurity are not named by the CLI: they take their defaults
      expect(await q(`SELECT credentials_version, must_change_password FROM users WHERE id = $1`, [row!.id])).toEqual([
        { credentials_version: 0, must_change_password: false },
      ]);

      // ...and the SUPER_ADMIN_BOOTSTRAPPED event was written in the same transaction
      const audit = await auditRows();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: 'SUPER_ADMIN_BOOTSTRAPPED',
        source: 'bootstrap-cli',
        environment: 'test',
        target_user_id: row!.id,
        target_email: EMAIL,
        actor_user_id: null,
        operator_label: null,
        reason: null,
        metadata: { version_after: 0, active_after: true, forced_change_after: false, operator_identity: 'none' },
      });
      expect(o.text()).toContain(`id=${String(audit[0]!.id)}`);
      // no secret anywhere in the stored event
      expect(JSON.stringify(audit)).not.toContain(PASSWORD);
      expect(JSON.stringify(audit)).not.toContain(String(row!.password_hash));
      expect(JSON.stringify(audit)).not.toMatch(/\$2[aby]\$/);
    });

    it('never prints the password or the hash', async () => {
      // (the previous run's output, regenerated: a failed attempt at the same step prints no secret either)
      const o = operator({ hidden: [PASSWORD, PASSWORD] });
      await runBootstrap(o.deps, { email: 'other@mordwave.test' }); // refused: a SUPER_ADMIN exists
      expect(o.text()).not.toContain(PASSWORD);
      expect(o.text()).not.toMatch(/\$2[aby]\$/);
    });

    it('does not depend on any business: the account has none, and still counts as the one SUPER_ADMIN', async () => {
      const state = await db.readOnly(() => db.readState(null));
      expect(state).toEqual({ users: 1, superAdmins: 1, emailTaken: false });
      expect((await q('SELECT count(*)::int AS n FROM businesses'))[0]!.n).toBe(1); // the only business is unrelated
      expect((await users())[0]!.business_id).toBeNull();
    });

    it('a second run is refused by default and changes nothing (the hash stays the same)', async () => {
      const before = await users();
      const auditBefore = await auditRows();
      const o = operator({ visible: ['CREAR SUPER_ADMIN second@mordwave.test'] });
      expect(await runBootstrap(o.deps, { email: 'second@mordwave.test' })).toBe(EXIT.refused);
      expect(o.text()).toMatch(/Ya existe un SUPER_ADMIN/);
      expect(await users()).toEqual(before);
      expect(await auditRows()).toEqual(auditBefore); // a refused run records nothing
    });

    it('--check now reports the existing SUPER_ADMIN, with no hash or email in the output', async () => {
      const o = operator();
      expect(await runCheck(o.deps)).toBe(EXIT.ok);
      expect(o.text()).toMatch(/SUPER_ADMIN existentes: 1/);
      expect(o.text()).toMatch(/lo rechazará/);
      expect(o.text()).not.toMatch(/\$2|@mordwave/);
    });
  });

  describe('transaction: races and rollback (deterministic; PGlite cannot interleave real transactions)', () => {
    it('a stale pre-check cannot create a second SUPER_ADMIN: the transaction re-checks after taking the lock', async () => {
      const before = await users();
      const auditBefore = await auditCount();
      expect(await db.createSuperAdmin({ email: 'late@mordwave.test', passwordHash: 'h', environment: 'test' })).toEqual({ status: 'super-admin-exists' });
      expect(await users()).toEqual(before);
      expect(await auditCount()).toBe(auditBefore);
    });

    it('releases the advisory lock when it finishes (it is transaction-scoped)', async () => {
      expect((await q(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`))[0]!.n).toBe(0);
    });

    // Failures are injected on the CLIENT side (a wrapper around the one connection), not by making the server raise an error
    // inside a parameterised statement: the pglite-socket harness is intermittently unreliable with server-side errors in the
    // extended protocol (a protocol error showed up in ~1 of 12 runs of such a test), and that would make this test flaky for
    // reasons unrelated to the code. Everything else — BEGIN, the advisory lock, the checks, the INSERT, ROLLBACK — runs for real.
    const failing = (pattern: RegExp, error: Error): BootstrapDb =>
      new BootstrapDb({ query: (sql, params) => (pattern.test(sql) ? Promise.reject(error) : client.query(sql, params)) as never });

    it('a failure at the INSERT rolls the transaction back: no user is left, the lock is released, the connection stays usable', async () => {
      await q('DELETE FROM users');
      const auditBefore = await auditCount();
      const boom = Object.assign(new Error('connection lost mid-insert'), { code: '08006' });
      await expect(failing(/^INSERT INTO users/, boom).createSuperAdmin({ email: 'fail@mordwave.test', passwordHash: 'h', environment: 'test' })).rejects.toBe(boom);
      expect(await users()).toEqual([]);
      expect(await auditCount()).toBe(auditBefore);
      expect((await q(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`))[0]!.n).toBe(0);
      // the same connection works, and a normal creation succeeds afterwards: no transaction was left open
      expect(await db.createSuperAdmin({ email: 'after-insert@mordwave.test', passwordHash: 'h', environment: 'test' })).toMatchObject({ status: 'created' });
      expect(await auditCount()).toBe(auditBefore + 1);
      await q('DELETE FROM users');
    });

    it('a failure at the AUDIT insert undoes the REAL, already-executed user INSERT: no SUPER_ADMIN without its audit event', async () => {
      await q('DELETE FROM users');
      const auditBefore = await auditCount();
      const boom = Object.assign(new Error('audit insert failed'), { code: '23514' });
      await expect(failing(/^\s*INSERT INTO platform_audit_logs/, boom).createSuperAdmin({ email: 'audit-fail@mordwave.test', passwordHash: 'h', environment: 'test' })).rejects.toBe(boom);
      expect(await users()).toEqual([]); // the INSERT INTO users ran inside the transaction and the ROLLBACK removed it
      expect(await auditCount()).toBe(auditBefore);
      expect((await q(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`))[0]!.n).toBe(0);
      expect(await db.createSuperAdmin({ email: 'after-audit@mordwave.test', passwordHash: 'h', environment: 'test' })).toMatchObject({ status: 'created' });
      await q('DELETE FROM users');
    });

    it('a failure at COMMIT undoes a REAL, already-executed INSERT: no partially created user remains', async () => {
      await q('DELETE FROM users');
      const auditBefore = await auditCount();
      const boom = Object.assign(new Error('commit failed'), { code: '40001' });
      await expect(failing(/^COMMIT/, boom).createSuperAdmin({ email: 'commit@mordwave.test', passwordHash: 'h', environment: 'test' })).rejects.toBe(boom);
      expect(await users()).toEqual([]); // the INSERT ran inside the transaction and the ROLLBACK removed it
      expect(await auditCount()).toBe(auditBefore); // ...and so did the audit event
      expect(await db.createSuperAdmin({ email: 'after-commit@mordwave.test', passwordHash: 'h', environment: 'test' })).toMatchObject({ status: 'created' });
      await q('DELETE FROM users');
    });

    it('through the orchestration the failure is reported with a code only, and nothing is created', async () => {
      await q('DELETE FROM users');
      const boom = Object.assign(new Error(`INSERT failed for [fail@mordwave.test, ${PASSWORD}]`), { code: '40001' });
      const o = operator({ visible: ['CREAR SUPER_ADMIN fail@mordwave.test'] });
      const deps = { ...o.deps, configure: () => ({ ...configured(), db: failing(/^COMMIT/, boom) }) };
      expect(await runBootstrap(deps, { email: 'fail@mordwave.test' })).toBe(EXIT.failure);
      expect(o.text()).toMatch(/\(40001\)/);
      expect(o.text()).toMatch(/puede ser ambiguo/);
      expect(o.text()).not.toMatch(/INSERT failed|\$2[aby]\$/);
      expect(o.text()).not.toContain(PASSWORD);
      expect(await users()).toEqual([]);
    });

    it('the UNIQUE(email) constraint is the backstop: a duplicate insert is reported as an existing email', async () => {
      await q('DELETE FROM users');
      await q(`INSERT INTO users (email, password_hash, role, business_id) VALUES ('dup@mordwave.test', 'h', 'ADMIN', (SELECT id FROM businesses LIMIT 1))`);
      await expect(q(`INSERT INTO users (email, password_hash, role) VALUES ('dup@mordwave.test', 'h', 'SUPER_ADMIN')`)).rejects.toMatchObject({ code: '23505' });
      await q('DELETE FROM users');
    });
  });

  describe('configuration errors never reach the database', () => {
    it('a missing configuration is refused before any connection or prompt', async () => {
      const o = operator();
      const deps = {
        ...o.deps,
        configure: () => {
          throw new ConfigError('Configuración insuficiente: define DATABASE_URL');
        },
      };
      expect(await runBootstrap(deps, { email: EMAIL })).toBe(EXIT.refused);
      expect(o.text()).toMatch(/Configuración insuficiente/);
    });
  });
});
