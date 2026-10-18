import bcrypt from 'bcrypt';
import pg from 'pg';
import type { QueryRunner } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BootstrapDb } from '../src/cli/bootstrap-super-admin/bootstrap-db.js';
import type { TargetInfo } from '../src/cli/bootstrap-super-admin/connection.js';
import { EXIT, runBootstrap, type Configured } from '../src/cli/bootstrap-super-admin/core.js';
import { listExpectedMigrations } from '../src/cli/bootstrap-super-admin/main.js';
import { PromptAborted, type Prompter } from '../src/cli/bootstrap-super-admin/prompter.js';
import { runCheck, runRecovery, type RecoveryConfigured } from '../src/cli/recover-super-admin/core.js';
import { RecoveryDb, type RecoveryOperation } from '../src/cli/recover-super-admin/recovery-db.js';
import { PLATFORM_ADMIN_LOCK_KEY } from '../src/cli/shared/platform-audit.js';
import { ALL_MIGRATIONS } from './support/run-all-migrations.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

// Integration of the SUPER_ADMIN recovery CLI against a real (ephemeral, local) PostgreSQL engine: the real migrations, the
// real SQL, the real bcrypt. The CLI's own `pg` client IS the one connection (pglite-socket tolerates a single connection
// per lifetime, see startTestDatabase).
//
// What this does NOT prove: genuine concurrency. PGlite is one Postgres session, so two transactions can never really
// interleave here. The races are covered deterministically instead — a change COMMITTED between the operator's read and the
// transaction's re-read must be refused, and the compare-and-set on credentials_version is the backstop — and the advisory
// lock is shown to be HELD during the transaction under the shared key. How two REAL sessions queue on that lock (and on the
// row lock) is NOT validated in this environment.
describe('recover-super-admin against a real local Postgres (PGlite)', () => {
  let testDb: TestDatabase;
  let client: pg.Client;
  let bootstrapDb: BootstrapDb;
  let recoveryDb: RecoveryDb;

  const PASSWORD = 'correct-horse-battery-staple';
  const NEW_PASSWORD = 'brand-new-Passw0rd-for-recovery';
  const EMAIL = 'root@mordwave.test';
  const ADMIN_EMAIL = 'admin@mordwave.test';
  const REASON = 'Pérdida de acceso del titular, ticket 1234';
  const TARGET: TargetInfo = { source: 'DB_*', host: '127.0.0.1', port: '0', database: 'postgres', ssl: false, environment: 'test', service: null };
  const expectedMigrations = listExpectedMigrations();
  const q = async (sql: string, params?: unknown[]) => (await client.query(sql, params)).rows as Array<Record<string, unknown>>;
  const userRow = async (email: string) => (await q('SELECT * FROM users WHERE email = $1', [email]))[0]!;
  const auditRows = () => q('SELECT * FROM platform_audit_logs ORDER BY created_at, id');
  const auditCount = async () => Number((await q('SELECT count(*)::int AS n FROM platform_audit_logs'))[0]!.n);
  const advisoryLocks = async () => Number((await q(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`))[0]!.n);
  const phraseFor = (operation: RecoveryOperation, email = EMAIL, env = 'test') =>
    operation === 'reset-password' ? `RESTABLECER CONTRASEÑA DE ${email} EN ${env}` : operation === 'reactivate' ? `REACTIVAR ${email} EN ${env}` : `REVOCAR SESIONES DE ${email} EN ${env}`;

  interface Run {
    email?: string;
    tty?: boolean;
    reason?: string;
    label?: string;
    hidden?: string[];
    confirm?: string[];
    db?: RecoveryDb;
    abort?: boolean;
    // runs while the operator is "typing" (at the first prompt): after the read-only pre-checks, before the transaction
    interfere?: () => Promise<void>;
  }
  function session(operation: RecoveryOperation, options: Run = {}) {
    const out: string[] = [];
    const calls: string[] = [];
    const hidden = [...(options.hidden ?? (operation === 'reset-password' ? [NEW_PASSWORD, NEW_PASSWORD] : []))];
    const visible = [options.reason ?? REASON, options.label ?? '', ...(options.confirm ?? [phraseFor(operation, options.email ?? EMAIL)])];
    const prompter: Prompter = {
      isInteractive: () => options.tty ?? true,
      ask: async () => {
        if (options.abort) throw new PromptAborted();
        if (calls.every((c) => c !== 'ask')) await options.interfere?.();
        calls.push('ask');
        return visible.shift() ?? '';
      },
      askHidden: async () => (options.abort ? Promise.reject(new PromptAborted()) : (calls.push('askHidden'), hidden.shift() ?? '')),
    };
    const configured: RecoveryConfigured = { target: TARGET, db: options.db ?? recoveryDb, connect: async () => void calls.push('connect'), close: async () => undefined };
    const deps = {
      configure: () => (calls.push('configure'), configured),
      expectedMigrations,
      out: (line: string) => void out.push(line),
      prompter,
      hashPassword: (password: string) => bcrypt.hash(password, 4), // cheap in tests; main.ts uses the project's cost (checked in the unit spec)
    };
    return { deps, out, calls, text: () => out.join('\n') };
  }
  const recover = async (operation: RecoveryOperation, options: Run = {}) => {
    const s = session(operation, options);
    const code = await runRecovery(s.deps, { operation, email: options.email ?? EMAIL });
    return { code, text: s.text(), calls: s.calls };
  };
  const check = async (email = EMAIL, db: RecoveryDb = recoveryDb) => {
    const s = session('revoke-sessions', { db });
    const code = await runCheck(s.deps, { email });
    return { code, text: s.text(), calls: s.calls };
  };
  const setActive = (active: boolean) => q('UPDATE users SET active = $1 WHERE email = $2', [active, EMAIL]);

  beforeAll(async () => {
    testDb = await startTestDatabase();
    client = new pg.Client({ host: testDb.host, port: testDb.port, user: 'postgres', password: 'postgres', database: 'postgres' });
    await client.connect();

    const runner = { query: async (sql: string, params?: unknown[]) => (await client.query(sql, params)).rows } as unknown as QueryRunner;
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    for (const Migration of ALL_MIGRATIONS) await new Migration().up(runner);
    await client.query('CREATE TABLE "migrations" ("id" SERIAL PRIMARY KEY, "timestamp" bigint NOT NULL, "name" character varying NOT NULL)');
    for (const Migration of ALL_MIGRATIONS) {
      const name = new Migration().name!;
      await client.query('INSERT INTO migrations (timestamp, name) VALUES ($1, $2)', [Number(name.match(/(\d+)$/)![1]), name]);
    }
    bootstrapDb = new BootstrapDb(client);
    recoveryDb = new RecoveryDb(client);

    // The accounts: an unrelated ADMIN (that must never be touched) and the SUPER_ADMIN, created by the REAL bootstrap flow.
    await q(`INSERT INTO businesses (name, slug) VALUES ('Biz', 'biz')`);
    await q(`INSERT INTO users (email, password_hash, role, business_id) VALUES ($1, $2, 'ADMIN', (SELECT id FROM businesses LIMIT 1))`, [ADMIN_EMAIL, await bcrypt.hash(PASSWORD, 4)]);
    const hidden = [PASSWORD, PASSWORD];
    const visible = [`CREAR SUPER_ADMIN ${EMAIL}`];
    const bootstrapped = await runBootstrap(
      {
        configure: (): Configured => ({ target: TARGET, db: bootstrapDb, connect: async () => undefined, close: async () => undefined }),
        expectedMigrations,
        out: () => undefined,
        prompter: { isInteractive: () => true, ask: async () => visible.shift() ?? '', askHidden: async () => hidden.shift() ?? '' },
        hashPassword: (p) => bcrypt.hash(p, 4),
      },
      { email: EMAIL },
    );
    expect(bootstrapped).toBe(EXIT.ok);
  }, 60_000);

  afterAll(async () => {
    await client?.end();
    await testDb?.stop();
  });

  describe('--check is strictly read-only', () => {
    it('reports the account, its version and flags, the effect of each operation and the audit trail — and changes nothing', async () => {
      const users = await q('SELECT * FROM users ORDER BY email');
      const audit = await auditRows();
      const r = await check();
      expect(r.code).toBe(EXIT.ok);
      expect(r.text).toMatch(/\[OK\] Esquema esperado, tabla platform_audit_logs presente y 18 migraciones/);
      expect(r.text).toMatch(/credentials_version: 0/);
      expect(r.text).toMatch(/activa: sí/);
      expect(r.text).toMatch(/must_change_password: no/);
      expect(r.text).toMatch(/SUPER_ADMIN_BOOTSTRAPPED {2}\(bootstrap-cli\)/);
      expect(r.text).not.toMatch(/\$2[aby]\$|password_hash/);
      expect(r.calls).not.toContain('ask'); // no prompt of any kind
      expect(r.calls).not.toContain('askHidden');
      expect(await q('SELECT * FROM users ORDER BY email')).toEqual(users); // not even updated_at moved
      expect(await auditRows()).toEqual(audit);
      expect(await advisoryLocks()).toBe(0);
    });

    it('PostgreSQL itself refuses a write inside its read-only transaction, and nothing is left open', async () => {
      await expect(recoveryDb.readOnly(() => client.query(`UPDATE users SET credentials_version = credentials_version + 1`))).rejects.toMatchObject({ code: '25006' });
      await expect(recoveryDb.readOnly(() => client.query(`SELECT pg_advisory_xact_lock(1)`))).resolves.toBeDefined(); // (a lock would be released by the rollback; --check does not even try)
      expect((await userRow(EMAIL)).credentials_version).toBe(0);
      expect(await advisoryLocks()).toBe(0);
    });

    it('is safe with bad input: invalid e-mail, unknown account, an ADMIN\'s e-mail — all without a single write, with the same answer for the last two', async () => {
      const users = await q('SELECT * FROM users ORDER BY email');
      const audit = await auditCount();
      expect((await check('not-an-email')).code).toBe(EXIT.refused);
      const unknown = await check('nobody@mordwave.test');
      const admin = await check(ADMIN_EMAIL);
      expect(unknown.code).toBe(EXIT.refused);
      expect(admin.code).toBe(EXIT.refused);
      const strip = (text: string) => text.replace(/\n.*\n/g, '\n');
      expect(strip(admin.text)).toEqual(strip(unknown.text)); // an ADMIN's existence is not revealed
      expect(admin.text).toMatch(/No existe ninguna cuenta SUPER_ADMIN con ese correo/);
      expect(await q('SELECT * FROM users ORDER BY email')).toEqual(users);
      expect(await auditCount()).toBe(audit);
    });

    it('detects a pending migration, a missing audit table and a changed credentials column — and still writes nothing', async () => {
      const sample = new ALL_MIGRATIONS[ALL_MIGRATIONS.length - 1]!().name!;
      await client.query('DELETE FROM migrations WHERE name = $1', [sample]);
      const pending = await check();
      expect(pending.code).toBe(EXIT.refused);
      expect(pending.text).toContain(sample);
      await client.query('INSERT INTO migrations (timestamp, name) VALUES ($1, $2)', [Number(sample.match(/(\d+)$/)![1]), sample]);

      await client.query('ALTER TABLE platform_audit_logs RENAME TO platform_audit_logs_off');
      const noAudit = await check();
      expect(noAudit.code).toBe(EXIT.refused);
      expect(noAudit.text).toMatch(/No existe la tabla "platform_audit_logs"/);
      await client.query('ALTER TABLE platform_audit_logs_off RENAME TO platform_audit_logs');

      await client.query('ALTER TABLE users RENAME COLUMN must_change_password TO must_change_old');
      expect((await check()).text).toMatch(/Falta la columna users\.must_change_password/);
      await client.query('ALTER TABLE users RENAME COLUMN must_change_old TO must_change_password');
      expect((await check()).code).toBe(EXIT.ok);
    });
  });

  describe('revoke-sessions', () => {
    it('increments credentials_version by exactly one and changes nothing else (password, activity, must-change, role, e-mail, business)', async () => {
      const before = await userRow(EMAIL);
      const adminBefore = await userRow(ADMIN_EMAIL);
      const r = await recover('revoke-sessions');
      expect(r.code).toBe(EXIT.ok);

      const after = await userRow(EMAIL);
      expect(after.credentials_version).toBe(Number(before.credentials_version) + 1);
      for (const column of ['id', 'email', 'password_hash', 'role', 'business_id', 'active', 'must_change_password', 'created_at']) expect(after[column], column).toEqual(before[column]);
      expect(await userRow(ADMIN_EMAIL)).toEqual(adminBefore); // ADMIN users are never touched

      const audit = (await auditRows()).at(-1)!;
      expect(audit).toMatchObject({
        action: 'SUPER_ADMIN_SESSIONS_REVOKED',
        source: 'recovery-cli',
        environment: 'test',
        target_user_id: before.id,
        target_email: EMAIL,
        actor_user_id: null,
        operator_label: null,
        reason: REASON,
        metadata: { version_before: 0, version_after: 1, active_before: true, active_after: true, forced_change_before: false, forced_change_after: false, operator_identity: 'none' },
      });
      expect(r.text).toContain(`id=${String(audit.id)}`);
      expect(await advisoryLocks()).toBe(0);
    });
  });

  describe('reset-password', () => {
    it('stores the new password (bcrypt), bumps the version, sets must_change_password, leaves `active` alone, records the declared operator', async () => {
      const before = await userRow(EMAIL);
      const r = await recover('reset-password', { label: 'Ana (soporte)' });
      expect(r.code).toBe(EXIT.ok);

      const after = await userRow(EMAIL);
      expect(after.credentials_version).toBe(Number(before.credentials_version) + 1);
      expect(after.must_change_password).toBe(true);
      expect(after.active).toBe(before.active);
      expect(after.password_hash).not.toBe(before.password_hash);
      expect(String(after.password_hash).startsWith('$2')).toBe(true);
      expect(await bcrypt.compare(NEW_PASSWORD, String(after.password_hash))).toBe(true);
      expect(await bcrypt.compare(PASSWORD, String(after.password_hash))).toBe(false);
      for (const column of ['id', 'email', 'role', 'business_id', 'created_at']) expect(after[column], column).toEqual(before[column]);

      const audit = (await auditRows()).at(-1)!;
      expect(audit).toMatchObject({
        action: 'SUPER_ADMIN_PASSWORD_RESET',
        source: 'recovery-cli',
        actor_user_id: null,
        operator_label: 'Ana (soporte)',
        reason: REASON,
        metadata: { version_before: 1, version_after: 2, active_before: true, active_after: true, forced_change_before: false, forced_change_after: true, operator_identity: 'declared-unverified' },
      });
    });

    it('never leaves the password or a hash in the output or in ANY audit row', async () => {
      const r = await recover('reset-password', { hidden: [NEW_PASSWORD, NEW_PASSWORD] });
      expect(r.code).toBe(EXIT.ok);
      const hash = String((await userRow(EMAIL)).password_hash);
      const everything = JSON.stringify(await auditRows()) + r.text;
      for (const secret of [NEW_PASSWORD, PASSWORD, hash]) expect(everything).not.toContain(secret);
      expect(everything).not.toMatch(/\$2[aby]\$/);
    });

    it('on an INACTIVE account the password changes but the account stays inactive (and the output says so)', async () => {
      await setActive(false);
      const r = await recover('reset-password');
      expect(r.code).toBe(EXIT.ok);
      expect(r.text).toMatch(/INACTIVA: seguirá inactiva/);
      const after = await userRow(EMAIL);
      expect(after.active).toBe(false);
      expect(after.must_change_password).toBe(true);
      await setActive(true);
    });

    it('does not change anything when the new password breaks the policy (short, over 72 bytes, equal to the e-mail) three times', async () => {
      const before = await userRow(EMAIL);
      const audit = await auditCount();
      const r = await recover('reset-password', { hidden: ['short', 'a'.repeat(73), EMAIL] });
      expect(r.code).toBe(EXIT.refused);
      expect(r.text).toMatch(/No se obtuvo una contraseña válida/);
      expect(await userRow(EMAIL)).toEqual(before);
      expect(await auditCount()).toBe(audit);
    });
  });

  describe('reactivate', () => {
    it('sets active = true and bumps the version, WITHOUT touching the password or clearing a pending temporary-password flag', async () => {
      await setActive(false);
      expect((await userRow(EMAIL)).must_change_password).toBe(true); // left pending by the previous reset
      const before = await userRow(EMAIL);

      const r = await recover('reactivate');
      expect(r.code).toBe(EXIT.ok);
      const after = await userRow(EMAIL);
      expect(after.active).toBe(true);
      expect(after.credentials_version).toBe(Number(before.credentials_version) + 1);
      expect(after.password_hash).toBe(before.password_hash);
      expect(after.must_change_password).toBe(true);
      expect((await auditRows()).at(-1)).toMatchObject({
        action: 'SUPER_ADMIN_REACTIVATED',
        metadata: { version_before: before.credentials_version, version_after: Number(before.credentials_version) + 1, active_before: false, active_after: true, forced_change_before: true, forced_change_after: true },
      });
    });

    it('refuses an account that is already active: nothing changes', async () => {
      const before = await userRow(EMAIL);
      const audit = await auditCount();
      const r = await recover('reactivate');
      expect(r.code).toBe(EXIT.refused);
      expect(r.text).toMatch(/ya está activa/);
      expect(await userRow(EMAIL)).toEqual(before);
      expect(await auditCount()).toBe(audit);
    });
  });

  describe('who can be operated on', () => {
    it.each(['reset-password', 'reactivate', 'revoke-sessions'] as const)('%s on an ADMIN\'s e-mail, an unknown e-mail or an invalid one: refused, nothing written', async (operation) => {
      const users = await q('SELECT * FROM users ORDER BY email');
      const audit = await auditCount();
      for (const email of [ADMIN_EMAIL, 'nobody@mordwave.test', 'not-an-email']) {
        const r = await recover(operation, { email, confirm: [phraseFor(operation, email)] });
        expect(r.code, email).toBe(EXIT.refused);
        expect(r.calls).not.toContain('askHidden');
      }
      expect(await q('SELECT * FROM users ORDER BY email')).toEqual(users);
      expect(await auditCount()).toBe(audit);
    });

    it('the e-mail is normalised like the login does (case and spaces)', async () => {
      const before = Number((await userRow(EMAIL)).credentials_version);
      expect((await recover('revoke-sessions', { email: '  Root@MordWave.Test ', confirm: [phraseFor('revoke-sessions')] })).code).toBe(EXIT.ok);
      expect((await userRow(EMAIL)).credentials_version).toBe(before + 1);
    });

    it('a second SUPER_ADMIN is never created: an unknown e-mail does not make an account', async () => {
      expect(Number((await q(`SELECT count(*)::int AS n FROM users WHERE role = 'SUPER_ADMIN'`))[0]!.n)).toBe(1);
    });
  });

  describe('terminal, confirmations and cancellation: nothing is written', () => {
    it.each(['reset-password', 'reactivate', 'revoke-sessions'] as const)('%s without a TTY is refused before anything else (no configuration, no connection)', async (operation) => {
      const before = await userRow(EMAIL);
      const r = await recover(operation, { tty: false });
      expect(r.code).toBe(EXIT.refused);
      expect(r.calls).toEqual([]);
      expect(r.text).toMatch(/terminal interactiva/);
      expect(await userRow(EMAIL)).toEqual(before);
    });

    it('wrong confirmations (another operation, another e-mail, another environment) and a missing reason', async () => {
      const before = await userRow(EMAIL);
      const audit = await auditCount();
      const wrong = await recover('revoke-sessions', { confirm: [phraseFor('reset-password'), phraseFor('revoke-sessions', 'other@mordwave.test'), phraseFor('revoke-sessions', EMAIL, 'production')] });
      expect(wrong.code).toBe(EXIT.refused);
      expect(wrong.text).toMatch(/Confirmación incorrecta\. No se modificó nada/);
      const noReason = await recover('revoke-sessions', { reason: 'corto' });
      expect(noReason.code).toBe(EXIT.refused);
      expect(await userRow(EMAIL)).toEqual(before);
      expect(await auditCount()).toBe(audit);
    });

    it('a reason that looks like a secret is refused, and the secret is not echoed', async () => {
      const r = await recover('revoke-sessions', { reason: `clave: ${NEW_PASSWORD}` });
      expect(r.code).toBe(EXIT.refused);
      expect(r.text).toMatch(/parece contener/);
      expect(r.text).not.toContain(NEW_PASSWORD);
    });

    it('Ctrl-C cancels without writing', async () => {
      const before = await userRow(EMAIL);
      const r = await recover('reset-password', { abort: true });
      expect(r.code).toBe(EXIT.refused);
      expect(r.text).toMatch(/CANCELADO/);
      expect(await userRow(EMAIL)).toEqual(before);
    });
  });

  describe('compare-and-set: a late operation never overwrites a more recent change', () => {
    // The change is COMMITTED while the operator is typing: after the read-only pre-checks, before the transaction starts —
    // the realistic race (another run, or the owner changing the password through the API).
    it('reset-password: a newer password chosen meanwhile (version moved) is NOT overwritten, and no audit row is written', async () => {
      const newerHash = await bcrypt.hash('the-newer-password-123', 4);
      const audit = await auditCount();
      const r = await recover('reset-password', {
        interfere: async () => void (await q('UPDATE users SET password_hash = $1, credentials_version = credentials_version + 1 WHERE email = $2', [newerHash, EMAIL])),
      });
      expect(r.code).toBe(EXIT.refused);
      expect(r.text).toMatch(/El estado de la cuenta cambió.*no se sobrescribió nada/);
      const after = await userRow(EMAIL);
      expect(after.password_hash).toBe(newerHash);
      expect(await auditCount()).toBe(audit);
      expect(await advisoryLocks()).toBe(0);
    });

    it('a change of `active` or of the temporary-password flag meanwhile is also refused', async () => {
      for (const change of ['active = NOT active', 'must_change_password = NOT must_change_password']) {
        const r = await recover('revoke-sessions', { interfere: async () => void (await q(`UPDATE users SET ${change} WHERE email = $1`, [EMAIL])) });
        const before = await userRow(EMAIL);
        expect(r.code, change).toBe(EXIT.refused);
        expect(r.text).toMatch(/cambió/);
        const after = await userRow(EMAIL);
        expect(after.credentials_version).toBe(before.credentials_version); // the revoke did not run on top of the change
        await q(`UPDATE users SET ${change} WHERE email = $1`, [EMAIL]); // undo
      }
    });

    it('two runs holding the same stale snapshot: exactly one takes effect, the version moves once', async () => {
      const lookup = await recoveryDb.readOnly(() => recoveryDb.findTarget(EMAIL));
      if (lookup.status !== 'found') throw new Error('expected the account');
      const before = Number(lookup.target.credentialsVersion);
      const input = { operation: 'revoke-sessions' as const, expected: lookup.target, passwordHash: null, environment: 'test', reason: REASON, operatorLabel: null };
      const audit = await auditCount();
      const first = await recoveryDb.apply(input);
      const second = await recoveryDb.apply(input);
      expect(first.status).toBe('applied');
      expect(second.status).toBe('state-changed');
      expect(Number((await userRow(EMAIL)).credentials_version)).toBe(before + 1);
      expect(await auditCount()).toBe(audit + 1);
      expect(await advisoryLocks()).toBe(0);
    });

    it('the account no longer being a SUPER_ADMIN (role changed meanwhile) is refused as gone', async () => {
      const lookup = await recoveryDb.readOnly(() => recoveryDb.findTarget(EMAIL));
      if (lookup.status !== 'found') throw new Error('expected the account');
      await q(`UPDATE users SET role = 'ADMIN', business_id = (SELECT id FROM businesses LIMIT 1) WHERE email = $1`, [EMAIL]);
      const outcome = await recoveryDb.apply({ operation: 'revoke-sessions', expected: lookup.target, passwordHash: null, environment: 'test', reason: REASON, operatorLabel: null });
      expect(outcome).toEqual({ status: 'target-gone' });
      await q(`UPDATE users SET role = 'SUPER_ADMIN', business_id = NULL WHERE email = $1`, [EMAIL]);
    });
  });

  describe('the shared platform advisory lock', () => {
    // Statement-spy wrapper around the one connection: runs a probe right before COMMIT, inside the transaction.
    const probing = (probe: () => Promise<void>) => ({
      query: async (sql: string, params?: unknown[]) => {
        if (sql.startsWith('COMMIT')) await probe();
        return client.query(sql, params) as never;
      },
    });
    const held = async () =>
      Number(
        (await q(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted AND objid::text::bigint = (hashtext($1)::bigint & 4294967295)`, [PLATFORM_ADMIN_LOCK_KEY]))[0]!.n,
      );

    it('recovery HOLDS the platform lock (the key the bootstrap uses) while it writes, and releases it at the end', async () => {
      let during = -1;
      const db = new RecoveryDb(probing(async () => void (during = await held())));
      expect((await recover('revoke-sessions', { db })).code).toBe(EXIT.ok);
      expect(during).toBe(1);
      expect(await held()).toBe(0);
    });

    it('the bootstrap holds the very same lock while it writes', async () => {
      let during = -1;
      const db = new BootstrapDb(probing(async () => void (during = await held())));
      await q(`UPDATE users SET role = 'ADMIN', business_id = (SELECT id FROM businesses LIMIT 1) WHERE email = $1`, [EMAIL]); // no SUPER_ADMIN, so the bootstrap proceeds
      expect(await db.createSuperAdmin({ email: 'second-root@mordwave.test', passwordHash: 'h', environment: 'test' })).toMatchObject({ status: 'created' });
      expect(during).toBe(1);
      await q(`DELETE FROM users WHERE email = 'second-root@mordwave.test'`);
      await q(`UPDATE users SET role = 'SUPER_ADMIN', business_id = NULL WHERE email = $1`, [EMAIL]);
      expect(await held()).toBe(0);
    });

    it('the bootstrap still refuses to create a second SUPER_ADMIN while the recovered one exists', async () => {
      const audit = await auditCount();
      expect(await bootstrapDb.createSuperAdmin({ email: 'another@mordwave.test', passwordHash: 'h', environment: 'test' })).toEqual({ status: 'super-admin-exists' });
      expect(await auditCount()).toBe(audit);
    });
  });

  describe('audit failure: everything rolls back', () => {
    // The failure is injected on the CLIENT side (a wrapper around the one connection), not by making the server raise an
    // error inside a parameterised statement: the pglite-socket harness corrupts the protocol stream after a server-side
    // error in the extended protocol (observed: ~40% of runs of such a test), which would make the suite flaky for reasons
    // unrelated to the code. Everything else — BEGIN, the locks, the real UPDATE, the ROLLBACK — runs for real, so the
    // statement that was already executed is genuinely undone.
    const failing = (pattern: RegExp, error: Error) => new RecoveryDb({ query: (sql, params) => (pattern.test(sql) ? Promise.reject(error) : client.query(sql, params)) as never });

    it.each(['reset-password', 'revoke-sessions'] as const)('%s: when the audit INSERT fails, the already-executed UPDATE is undone — password, version and flags are exactly as before', async (operation) => {
      const before = await userRow(EMAIL);
      const audit = await auditCount();
      const boom = Object.assign(new Error('audit insert failed'), { code: '23514' });
      const r = await recover(operation, { db: failing(/^\s*INSERT INTO platform_audit_logs/, boom) });
      expect(r.code).toBe(EXIT.failure);
      expect(r.text).toMatch(/\(23514\)/);
      expect(r.text).not.toMatch(/audit insert failed/);
      expect(await userRow(EMAIL)).toEqual(before); // including updated_at: the UPDATE never happened as far as anyone can tell
      expect(await auditCount()).toBe(audit);
      expect(await advisoryLocks()).toBe(0);
      await db_usable();
    });

    it('a failure at COMMIT is not retried: it is reported as ambiguous and the read-only check tells the real state', async () => {
      const before = await userRow(EMAIL);
      const boom = Object.assign(new Error(`commit failed password=${NEW_PASSWORD}`), { code: '08006' });
      const r = await recover('revoke-sessions', { db: failing(/^COMMIT/, boom) });
      expect(r.code).toBe(EXIT.failure);
      expect(r.text).toMatch(/\[AMBIGUO\]/);
      expect(r.text).toMatch(/--check --email/);
      expect(r.text).not.toContain(NEW_PASSWORD);
      expect(await userRow(EMAIL)).toEqual(before); // (here the wrapper never sent COMMIT; a real lost COMMIT could go either way — that is the point of the message)
      expect((await check()).code).toBe(EXIT.ok);
      await db_usable();
    });

    async function db_usable() {
      // the connection is healthy and no transaction is left open: a normal operation works right after
      await recoveryDb.ping();
      expect((await q('SELECT 1 AS ok'))[0]).toEqual({ ok: 1 });
    }
  });

  describe('the audit trail is queryable afterwards', () => {
    it('lists every bootstrap/recovery event of the account, newest first, each with exactly one row per operation', async () => {
      const rows = await q(
        `SELECT action, source, operator_label, reason, metadata->>'version_after' AS version_after
           FROM platform_audit_logs WHERE target_email = $1 ORDER BY created_at DESC, id DESC`,
        [EMAIL],
      );
      expect(rows.length).toBeGreaterThanOrEqual(5);
      expect(rows.at(-1)).toMatchObject({ action: 'SUPER_ADMIN_BOOTSTRAPPED', source: 'bootstrap-cli', reason: null });
      for (const row of rows.slice(0, -1)) expect(row.source).toBe('recovery-cli');
      // one audit row per successful operation: the version counter equals the number of recovery events
      const events = rows.filter((r) => r.source === 'recovery-cli').length;
      const successful = Number((await userRow(EMAIL)).credentials_version);
      // (interfering updates in the compare-and-set tests bumped the version by hand: events can only be fewer)
      expect(events).toBeLessThanOrEqual(successful);
      // the trail also holds no secret
      expect(JSON.stringify(await auditRows())).not.toMatch(/\$2[aby]\$/);
    });

    it('the table stays append-only: nothing the tools do can edit it, and the database refuses a manual edit', async () => {
      await expect(q(`UPDATE platform_audit_logs SET reason = 'edited'`)).rejects.toMatchObject({ code: '23001' });
      await expect(q(`DELETE FROM platform_audit_logs`)).rejects.toMatchObject({ code: '23001' });
    });
  });
});
