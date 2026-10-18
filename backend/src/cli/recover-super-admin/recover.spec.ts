import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { SqlExecutor } from '../bootstrap-super-admin/bootstrap-db.js';
import { ConfigError, type TargetInfo } from '../bootstrap-super-admin/connection.js';
import { EXIT } from '../bootstrap-super-admin/core.js';
import { PromptAborted, type Prompter } from '../bootstrap-super-admin/prompter.js';
import { parseArgs, UsageError } from './args.js';
import { runCheck, runRecovery, type RecoveryConfigured } from './core.js';
import { CommitUncertainError, RecoveryDb, type ApplyOutcome, type RecoveryOperation, type TargetLookup, type TargetSnapshot } from './recovery-db.js';

const here = new URL('.', import.meta.url);
const read = (relative: string) => readFileSync(new URL(relative, here), 'utf8');
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PASSWORD = 'correct-horse-battery-staple';
const EMAIL = 'root@mordwave.test';
const REASON = 'Pérdida de acceso del titular, ticket 1234';
const TARGET: TargetInfo = { source: 'DATABASE_URL', host: 'db.internal', port: '5432', database: 'appdb', ssl: true, environment: 'production', service: 'backend' };
const SNAPSHOT: TargetSnapshot = { id: 'target-id', email: EMAIL, active: true, credentialsVersion: 3, mustChangePassword: false, createdAt: new Date('2026-10-01T10:00:00Z') };

// ---------------------------------------------------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------------------------------------------------
describe('arguments', () => {
  it('parses the three operations and --check, with --email in both forms', () => {
    expect(parseArgs(['reset-password', '--email', EMAIL])).toEqual({ mode: 'operation', operation: 'reset-password', email: EMAIL });
    expect(parseArgs(['--email=' + EMAIL, 'reactivate'])).toEqual({ mode: 'operation', operation: 'reactivate', email: EMAIL });
    expect(parseArgs(['revoke-sessions', '--email', EMAIL]).operation).toBe('revoke-sessions');
    expect(parseArgs(['--check', '--email', EMAIL])).toEqual({ mode: 'check', operation: null, email: EMAIL });
    expect(parseArgs(['--help']).mode).toBe('help');
  });

  it.each(['--password', '--password=hunter2', '-p', '--new-password', '--pass', '--secret', '--token=abc'])('refuses %s: the password is never taken from arguments', (flag) => {
    expect(() => parseArgs(['reset-password', '--email', EMAIL, flag, 'x'])).toThrow(/prompt oculto/);
  });

  it.each(['--reason', '--reason=lost', '--motivo', '--operator', '--operator=ana', '--yes', '-y', '--force', '--confirm', '--no-confirm', '--non-interactive'])(
    'refuses %s: reason, operator and confirmations are only typed at the prompts',
    (flag) => {
      expect(() => parseArgs(['reset-password', '--email', EMAIL, flag])).toThrow(/prompts interactivos/);
    },
  );

  it('is strict about everything else', () => {
    expect(() => parseArgs([])).toThrow(/Indica una operación/);
    expect(() => parseArgs(['reset-password'])).toThrow(/necesita --email/);
    expect(() => parseArgs(['--check'])).toThrow(/necesita --email/);
    expect(() => parseArgs(['--check', 'reset-password', '--email', EMAIL])).toThrow(/solo de lectura/);
    expect(() => parseArgs(['reset-password', 'reactivate', '--email', EMAIL])).toThrow(/una sola operación/);
    expect(() => parseArgs(['delete-account', '--email', EMAIL])).toThrow(/Operación desconocida/);
    expect(() => parseArgs(['reactivate', '--email', EMAIL, '--role', 'ADMIN'])).toThrow(/Opción desconocida: --role/);
    expect(() => parseArgs(['reactivate', '--email'])).toThrow(/necesita un valor/);
    expect(() => parseArgs(['reactivate', '--email', EMAIL, '--new-email', 'x@y.cl'])).toThrow(UsageError); // no way to change the e-mail
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// RecoveryDb (scripted SQL: exact statements, order and parameters)
// ---------------------------------------------------------------------------------------------------------------------
function scriptedSql(handlers: (sql: string, params?: unknown[]) => Array<Record<string, unknown>> | Error | undefined = () => undefined) {
  const log: Array<{ sql: string; params?: unknown[] }> = [];
  const sql: SqlExecutor = {
    query: async (text, params) => {
      log.push({ sql: text, params });
      const result = handlers(text, params);
      if (result instanceof Error) throw result;
      return { rows: result ?? [] };
    },
  };
  return { sql, log, statements: () => log.map((l) => l.sql.split(/\s+/).slice(0, 3).join(' ')) };
}

const row = (s: TargetSnapshot) => ({ id: s.id, email: s.email, active: s.active, credentials_version: s.credentialsVersion, must_change_password: s.mustChangePassword, created_at: s.createdAt });

// A database whose only user is `current`; an UPDATE moves it the way the real statement does.
function happyHandlers(current: TargetSnapshot) {
  return (text: string): Array<Record<string, unknown>> | undefined => {
    if (/FOR UPDATE/.test(text)) return [row(current)];
    if (/^\s*UPDATE users/.test(text)) {
      return [{ active: /active = true/.test(text) ? true : current.active, credentials_version: current.credentialsVersion + 1, must_change_password: /must_change_password = true/.test(text) ? true : current.mustChangePassword }];
    }
    if (/INSERT INTO platform_audit_logs/.test(text)) return [{ id: 'audit-id' }];
    return [];
  };
}

const applyInput = (operation: RecoveryOperation, extra: Partial<Parameters<RecoveryDb['apply']>[0]> = {}) => ({
  operation,
  expected: SNAPSHOT,
  passwordHash: operation === 'reset-password' ? '$2b$12$HASHVALUE1234567890123' : null,
  environment: 'production',
  reason: REASON,
  operatorLabel: null,
  ...extra,
});

describe('RecoveryDb.apply: one transaction, in order', () => {
  it.each(['reset-password', 'reactivate', 'revoke-sessions'] as const)('%s: BEGIN -> bounded lock wait -> advisory lock -> lock+re-read -> UPDATE -> ONE audit insert -> COMMIT', async (operation) => {
    const expected = operation === 'reactivate' ? { ...SNAPSHOT, active: false } : SNAPSHOT;
    const s = scriptedSql(happyHandlers(expected));
    const outcome = await new RecoveryDb(s.sql).apply(applyInput(operation, { expected }));

    expect(outcome).toEqual({ status: 'applied', versionBefore: 3, versionAfter: 4, auditId: 'audit-id' });
    expect(s.statements()).toEqual(['BEGIN', 'SET LOCAL lock_timeout', 'SELECT pg_advisory_xact_lock(hashtext($1))', 'SELECT id, email,', 'UPDATE users SET', 'INSERT INTO platform_audit_logs', 'COMMIT']);
    expect(s.log.find((l) => /pg_advisory_xact_lock/.test(l.sql))!.params).toEqual(['mordwave:platform-super-admin']);
    const lock = s.log.find((l) => /FOR UPDATE/.test(l.sql))!;
    expect(lock.sql).toMatch(/WHERE id = \$1 AND role = \$2 FOR UPDATE/);
    expect(s.log.filter((l) => /INSERT INTO platform_audit_logs/.test(l.sql))).toHaveLength(1); // exactly one event
  });

  it('reset-password changes ONLY password, must-change and the version; the hash is a bound parameter', async () => {
    const s = scriptedSql(happyHandlers(SNAPSHOT));
    await new RecoveryDb(s.sql).apply(applyInput('reset-password'));
    const update = s.log.find((l) => /^\s*UPDATE users/.test(l.sql))!;
    expect(update.sql.replace(/\s+/g, ' ')).toBe(
      'UPDATE users SET password_hash = $4, must_change_password = true, credentials_version = credentials_version + 1, updated_at = now() WHERE id = $1 AND credentials_version = $2 AND role = $3 RETURNING active, credentials_version, must_change_password',
    );
    expect(update.sql).not.toMatch(/\bactive\s*=/); // does not touch `active`
    expect(update.params).toEqual(['target-id', 3, 'SUPER_ADMIN', '$2b$12$HASHVALUE1234567890123']);
    expect(s.log.map((l) => l.sql).join('\n')).not.toContain('HASHVALUE'); // never part of any SQL text
  });

  it('reactivate changes ONLY active and the version (no password, no must-change)', async () => {
    const expected = { ...SNAPSHOT, active: false, mustChangePassword: true };
    const s = scriptedSql(happyHandlers(expected));
    await new RecoveryDb(s.sql).apply(applyInput('reactivate', { expected }));
    const update = s.log.find((l) => /^\s*UPDATE users/.test(l.sql))!;
    expect(update.sql.replace(/\s+/g, ' ')).toBe(
      'UPDATE users SET active = true, credentials_version = credentials_version + 1, updated_at = now() WHERE id = $1 AND credentials_version = $2 AND role = $3 RETURNING active, credentials_version, must_change_password',
    );
    expect(update.sql).not.toMatch(/password_hash|must_change_password =/);
    expect(update.params).toEqual(['target-id', 3, 'SUPER_ADMIN']);
  });

  it('revoke-sessions changes ONLY the version', async () => {
    const s = scriptedSql(happyHandlers(SNAPSHOT));
    await new RecoveryDb(s.sql).apply(applyInput('revoke-sessions'));
    const update = s.log.find((l) => /^\s*UPDATE users/.test(l.sql))!;
    expect(update.sql.replace(/\s+/g, ' ')).toBe(
      'UPDATE users SET credentials_version = credentials_version + 1, updated_at = now() WHERE id = $1 AND credentials_version = $2 AND role = $3 RETURNING active, credentials_version, must_change_password',
    );
  });

  it('the audit event carries the allowed facts, source recovery-cli, no actor, the declared (unverified) operator', async () => {
    const s = scriptedSql(happyHandlers(SNAPSHOT));
    await new RecoveryDb(s.sql).apply(applyInput('reset-password', { operatorLabel: 'Ana (soporte)' }));
    const audit = s.log.find((l) => /INSERT INTO platform_audit_logs/.test(l.sql))!;
    expect(audit.sql).toMatch(/\$5, NULL, \$6/);
    expect(audit.params).toEqual([
      'SUPER_ADMIN_PASSWORD_RESET',
      'recovery-cli',
      'production',
      'target-id',
      EMAIL,
      'Ana (soporte)',
      REASON,
      '{"version_before":3,"version_after":4,"active_before":true,"active_after":true,"forced_change_before":false,"forced_change_after":true,"operator_identity":"declared-unverified"}',
    ]);
    expect(JSON.stringify(audit.params)).not.toMatch(/HASHVALUE|\$2b\$/);
  });

  it.each([
    ['reset-password', 'SUPER_ADMIN_PASSWORD_RESET'],
    ['reactivate', 'SUPER_ADMIN_REACTIVATED'],
    ['revoke-sessions', 'SUPER_ADMIN_SESSIONS_REVOKED'],
  ] as const)('%s records %s with operator_identity "none" when no label was given', async (operation, action) => {
    const expected = operation === 'reactivate' ? { ...SNAPSHOT, active: false } : SNAPSHOT;
    const s = scriptedSql(happyHandlers(expected));
    await new RecoveryDb(s.sql).apply(applyInput(operation, { expected }));
    const audit = s.log.find((l) => /INSERT INTO platform_audit_logs/.test(l.sql))!;
    expect(audit.params![0]).toBe(action);
    expect(audit.params![5]).toBeNull();
    expect(String(audit.params![7])).toContain('"operator_identity":"none"');
  });

  it('refuses a mismatch between the operation and the presence of a hash, before any SQL', async () => {
    const s = scriptedSql();
    await expect(new RecoveryDb(s.sql).apply(applyInput('reset-password', { passwordHash: null }))).rejects.toThrow();
    await expect(new RecoveryDb(s.sql).apply(applyInput('revoke-sessions', { passwordHash: '$2b$x' }))).rejects.toThrow();
    expect(s.log).toEqual([]);
  });
});

describe('RecoveryDb.apply: compare-and-set and refusals (rollback, no UPDATE, no audit)', () => {
  const refused = async (op: RecoveryOperation, handlers: Parameters<typeof scriptedSql>[0], expected = SNAPSHOT) => {
    const s = scriptedSql(handlers);
    const outcome = await new RecoveryDb(s.sql).apply(applyInput(op, { expected }));
    expect(s.statements().at(-1)).toBe('ROLLBACK');
    expect(s.log.some((l) => /^\s*UPDATE users|INSERT INTO platform_audit_logs|COMMIT/.test(l.sql))).toBe(false);
    return outcome;
  };

  it('the row changed after the operator confirmed — a NEWER password (higher version) is never overwritten', async () => {
    const newer = { ...SNAPSHOT, credentialsVersion: 4 };
    expect(await refused('reset-password', (t) => (/FOR UPDATE/.test(t) ? [row(newer)] : []))).toEqual({ status: 'state-changed' });
  });

  it.each([
    ['active', { ...SNAPSHOT, active: false }],
    ['must_change_password', { ...SNAPSHOT, mustChangePassword: true }],
    ['email', { ...SNAPSHOT, email: 'other@mordwave.test' }],
    ['id', { ...SNAPSHOT, id: 'another-id' }],
  ])('any difference in %s since the confirmation is refused', async (_field, changed) => {
    expect(await refused('revoke-sessions', (t) => (/FOR UPDATE/.test(t) ? [row(changed)] : []))).toEqual({ status: 'state-changed' });
  });

  it('the account vanished or stopped being a SUPER_ADMIN', async () => {
    expect(await refused('revoke-sessions', () => [])).toEqual({ status: 'target-gone' });
  });

  it('reactivate on an account that is already active', async () => {
    expect(await refused('reactivate', (t) => (/FOR UPDATE/.test(t) ? [row(SNAPSHOT)] : []))).toEqual({ status: 'already-active' });
  });

  it('the UPDATE\'s own compare-and-set matching no row is a refusal too (defence in depth)', async () => {
    const s = scriptedSql((t) => (/FOR UPDATE/.test(t) ? [row(SNAPSHOT)] : /^\s*UPDATE users/.test(t) ? [] : []));
    expect(await new RecoveryDb(s.sql).apply(applyInput('revoke-sessions'))).toEqual({ status: 'state-changed' });
    expect(s.statements().at(-1)).toBe('ROLLBACK');
    expect(s.log.some((l) => /INSERT INTO platform_audit_logs|COMMIT/.test(l.sql))).toBe(false);
  });
});

describe('RecoveryDb.apply: failures', () => {
  it('an audit failure rolls EVERYTHING back and is rethrown — no COMMIT ever', async () => {
    const boom = Object.assign(new Error('check constraint violated'), { code: '23514' });
    const s = scriptedSql((t) => (/INSERT INTO platform_audit_logs/.test(t) ? boom : happyHandlers(SNAPSHOT)(t)));
    await expect(new RecoveryDb(s.sql).apply(applyInput('reset-password'))).rejects.toBe(boom);
    expect(s.statements().at(-1)).toBe('ROLLBACK');
    expect(s.log.some((l) => /COMMIT/.test(l.sql))).toBe(false);
  });

  it('a failure of the audit row count (not exactly one) also rolls back', async () => {
    const s = scriptedSql((t) => (/INSERT INTO platform_audit_logs/.test(t) ? [] : happyHandlers(SNAPSHOT)(t)));
    await expect(new RecoveryDb(s.sql).apply(applyInput('revoke-sessions'))).rejects.toThrow(/no se registró/);
    expect(s.statements().at(-1)).toBe('ROLLBACK');
  });

  it('a failure at COMMIT is NOT retried: it is reported as uncertain, after a best-effort ROLLBACK', async () => {
    const boom = Object.assign(new Error('connection terminated'), { code: '08006' });
    const s = scriptedSql((t) => (t.startsWith('COMMIT') ? boom : happyHandlers(SNAPSHOT)(t)));
    const error = await new RecoveryDb(s.sql).apply(applyInput('revoke-sessions')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommitUncertainError);
    expect((error as CommitUncertainError).cause).toBe(boom);
    expect(s.log.filter((l) => l.sql.startsWith('COMMIT'))).toHaveLength(1); // one attempt only
    expect(s.log.filter((l) => /^\s*UPDATE users/.test(l.sql))).toHaveLength(1); // the UPDATE is not re-sent
  });

  it('an error before COMMIT is rethrown as is (definite rollback); a failing ROLLBACK does not hide it', async () => {
    const boom = Object.assign(new Error('lock timeout'), { code: '55P03' });
    const s = scriptedSql((t) => (/pg_advisory_xact_lock/.test(t) ? boom : t === 'ROLLBACK' ? new Error('gone') : []));
    const error = await new RecoveryDb(s.sql).apply(applyInput('revoke-sessions')).catch((e: unknown) => e);
    expect(error).toBe(boom);
    expect(error).not.toBeInstanceOf(CommitUncertainError);
  });
});

describe('RecoveryDb read-only helpers', () => {
  it('findTarget reads ONLY SUPER_ADMIN rows, by e-mail, never the hash, and never lists', async () => {
    const s = scriptedSql(() => [row(SNAPSHOT)]);
    expect(await new RecoveryDb(s.sql).findTarget(EMAIL)).toEqual({ status: 'found', target: SNAPSHOT });
    expect(s.log[0]!.sql).toMatch(/WHERE role = \$1 AND lower\(email\) = \$2 LIMIT 2/);
    expect(s.log[0]!.sql).not.toMatch(/password_hash/);
    expect(s.log[0]!.params).toEqual(['SUPER_ADMIN', EMAIL]);
  });

  it('answers not-found the same for "no such e-mail" and "not a SUPER_ADMIN" (the query never sees other roles) and flags duplicates', async () => {
    expect(await new RecoveryDb(scriptedSql(() => []).sql).findTarget(EMAIL)).toEqual({ status: 'not-found' });
    expect(await new RecoveryDb(scriptedSql(() => [row(SNAPSHOT), row({ ...SNAPSHOT, id: 'b' })]).sql).findTarget(EMAIL)).toEqual({ status: 'ambiguous' });
  });

  it('recentAudit returns action, source and time only (no reason, no operator label)', async () => {
    const s = scriptedSql(() => [{ action: 'SUPER_ADMIN_SESSIONS_REVOKED', source: 'recovery-cli', created_at: new Date('2026-10-02T00:00:00Z') }]);
    const trail = await new RecoveryDb(s.sql).recentAudit('target-id');
    expect(trail).toEqual([{ action: 'SUPER_ADMIN_SESSIONS_REVOKED', source: 'recovery-cli', createdAt: new Date('2026-10-02T00:00:00Z') }]);
    expect(s.log[0]!.sql).not.toMatch(/reason|operator_label|metadata/);
  });

  it('readOnly is a READ ONLY transaction, always rolled back', async () => {
    const s = scriptedSql();
    await new RecoveryDb(s.sql).readOnly(async () => 'x');
    expect(s.statements()).toEqual(['BEGIN TRANSACTION READ', 'ROLLBACK']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// the orchestration, with a fake database and a scripted operator
// ---------------------------------------------------------------------------------------------------------------------
interface World {
  lookup?: TargetLookup;
  target?: TargetSnapshot;
  schemaProblems?: string[];
  connectError?: Error;
  applyOutcome?: ApplyOutcome | Error;
  configError?: ConfigError;
  hidden?: string[];
  visible?: string[];
  interactive?: boolean;
  abort?: boolean;
  environment?: string;
}

function world(operation: RecoveryOperation, w: World = {}) {
  const out: string[] = [];
  const calls: string[] = [];
  const applied: Array<Parameters<RecoveryDb['apply']>[0]> = [];
  const target = w.target ?? (operation === 'reactivate' ? { ...SNAPSHOT, active: false } : SNAPSHOT);
  const environment = w.environment ?? 'production';
  const phrase =
    operation === 'reset-password' ? `RESTABLECER CONTRASEÑA DE ${EMAIL} EN ${environment}` : operation === 'reactivate' ? `REACTIVAR ${EMAIL} EN ${environment}` : `REVOCAR SESIONES DE ${EMAIL} EN ${environment}`;
  const hidden = [...(w.hidden ?? [PASSWORD, PASSWORD])];
  const visible = [...(w.visible ?? [REASON, '', phrase])];
  const db = {
    ping: async () => void calls.push('ping'),
    readOnly: async <T>(work: () => Promise<T>) => {
      calls.push('readOnly:begin');
      try {
        return await work();
      } finally {
        calls.push('readOnly:end');
      }
    },
    inspectSchema: async () => (calls.push('inspectSchema'), { ok: !(w.schemaProblems?.length), problems: w.schemaProblems ?? [], appliedMigrations: 18 }),
    findTarget: async (email: string) => (calls.push(`findTarget:${email}`), w.lookup ?? { status: 'found' as const, target }),
    recentAudit: async () => (calls.push('recentAudit'), [{ action: 'SUPER_ADMIN_BOOTSTRAPPED', source: 'bootstrap-cli', createdAt: new Date('2026-10-01T10:00:00Z') }]),
    apply: async (input: Parameters<RecoveryDb['apply']>[0]) => {
      calls.push('apply');
      applied.push(input);
      if (w.applyOutcome instanceof Error) throw w.applyOutcome;
      return w.applyOutcome ?? { status: 'applied' as const, versionBefore: 3, versionAfter: 4, auditId: '33333333-3333-4333-8333-333333333333' };
    },
  } as unknown as RecoveryDb;
  const configured: RecoveryConfigured = {
    target: { ...TARGET, environment },
    db,
    connect: async () => {
      calls.push('connect');
      if (w.connectError) throw w.connectError;
    },
    close: async () => void calls.push('close'),
  };
  const prompter: Prompter = {
    isInteractive: () => w.interactive ?? true,
    ask: async () => {
      calls.push('ask');
      if (w.abort) throw new PromptAborted();
      return visible.shift() ?? '';
    },
    askHidden: async () => {
      calls.push('askHidden');
      if (w.abort) throw new PromptAborted();
      return hidden.shift() ?? '';
    },
  };
  const deps = {
    configure: () => {
      calls.push('configure');
      if (w.configError) throw w.configError;
      return configured;
    },
    expectedMigrations: ['AddUsers1789679086923'],
    out: (line: string) => void out.push(line),
    prompter,
    hashPassword: async (p: string) => (calls.push('hash'), `$2b$12$HASHOF(${p.length})`),
  };
  return { deps, out, calls, applied, phrase, text: () => out.join('\n') };
}

describe('recovery: successful operations', () => {
  it('reset-password: read-only pre-checks BEFORE any prompt, hash only after the confirmation, ONE apply with the right input', async () => {
    const w = world('reset-password');
    expect(await runRecovery(w.deps, { operation: 'reset-password', email: '  Root@MordWave.Test ' })).toBe(EXIT.ok);

    expect(w.applied).toEqual([
      { operation: 'reset-password', expected: SNAPSHOT, passwordHash: '$2b$12$HASHOF(28)', environment: 'production', reason: REASON, operatorLabel: null },
    ]);
    const firstPrompt = Math.min(w.calls.indexOf('ask'), w.calls.indexOf('askHidden'));
    for (const step of ['readOnly:begin', 'inspectSchema', `findTarget:${EMAIL}`, 'readOnly:end']) expect(w.calls.indexOf(step), step).toBeLessThan(firstPrompt);
    expect(w.calls.indexOf('hash')).toBeGreaterThan(w.calls.lastIndexOf('ask')); // hashing happens after the confirmation
    expect(w.calls.indexOf('apply')).toBeGreaterThan(w.calls.indexOf('hash'));
    expect(w.calls.at(-1)).toBe('close');
    expect(w.text()).toMatch(/credentials_version 3 -> 4/);
    expect(w.text()).toMatch(/deberá cambiarla|debe cambiar la contraseña/);
    expect(w.text()).toMatch(/Evento de auditoría registrado en platform_audit_logs \(id=33333333-3333-4333-8333-333333333333\), en la misma transacción/);
  });

  it('reactivate and revoke-sessions apply without a password (no hidden prompt, no hash)', async () => {
    for (const operation of ['reactivate', 'revoke-sessions'] as const) {
      const w = world(operation);
      expect(await runRecovery(w.deps, { operation, email: EMAIL })).toBe(EXIT.ok);
      expect(w.calls).not.toContain('askHidden');
      expect(w.calls).not.toContain('hash');
      expect(w.applied).toHaveLength(1);
      expect(w.applied[0]).toMatchObject({ operation, passwordHash: null, reason: REASON });
    }
  });

  it('shows the destination, the account and the EXACT effect before asking anything', async () => {
    const w = world('reset-password');
    await runRecovery(w.deps, { operation: 'reset-password', email: EMAIL });
    const text = w.text();
    expect(text).toMatch(/host: db\.internal/);
    expect(text).toMatch(/entorno: production/);
    expect(text).toMatch(/id: target-id/);
    expect(text).toMatch(/credentials_version: 3/);
    expect(text).toMatch(/must_change_password: no -> sí/);
    expect(text).toMatch(/active: sin cambios \(activa\)/);
    expect(text.indexOf('Efecto exacto')).toBeLessThan(text.indexOf('Resumen a confirmar'));
  });

  it('warns that reset-password leaves an INACTIVE account inactive', async () => {
    const w = world('reset-password', { target: { ...SNAPSHOT, active: false } });
    await runRecovery(w.deps, { operation: 'reset-password', email: EMAIL });
    expect(w.text()).toMatch(/INACTIVA: seguirá inactiva; usa también reactivate/);
  });

  it('shows that reactivate keeps a pending temporary-password flag', async () => {
    const w = world('reactivate', { target: { ...SNAPSHOT, active: false, mustChangePassword: true } });
    await runRecovery(w.deps, { operation: 'reactivate', email: EMAIL });
    expect(w.text()).toMatch(/must_change_password: sin cambios \(sí\)/);
    expect(w.text()).toMatch(/contraseña: sin cambios/);
  });

  it('records the operator label as a declaration, escaped, and keeps the reason escaped in the summary', async () => {
    const w = world('revoke-sessions', { visible: [REASON, 'Ana (soporte)', 'REVOCAR SESIONES DE root@mordwave.test EN production'] });
    expect(await runRecovery(w.deps, { operation: 'revoke-sessions', email: EMAIL })).toBe(EXIT.ok);
    expect(w.applied[0]).toMatchObject({ operatorLabel: 'Ana (soporte)' });
    expect(w.text()).toMatch(/operador: "Ana \(soporte\)" \(declarado, NO verificado\)/);
    expect(w.text()).toContain(`motivo: ${JSON.stringify(REASON)}`);
  });

  it('never prints the password or a hash', async () => {
    const w = world('reset-password');
    await runRecovery(w.deps, { operation: 'reset-password', email: EMAIL });
    expect(w.text()).not.toContain(PASSWORD);
    expect(w.text()).not.toMatch(/\$2[aby]\$|HASHOF/);
  });
});

describe('recovery: refusals (nothing is written)', () => {
  const untouched = (w: ReturnType<typeof world>) => expect(w.applied).toEqual([]);

  it('without a terminal: refused first — not even a configuration or connection is attempted', async () => {
    const w = world('reset-password', { interactive: false });
    expect(await runRecovery(w.deps, { operation: 'reset-password', email: EMAIL })).toBe(EXIT.refused);
    expect(w.calls).toEqual([]);
    expect(w.text()).toMatch(/terminal interactiva/);
  });

  it('missing configuration, invalid e-mail and connection errors', async () => {
    const noConfig = world('revoke-sessions', { configError: new ConfigError('Configuración insuficiente: define DATABASE_URL') });
    expect(await runRecovery(noConfig.deps, { operation: 'revoke-sessions', email: EMAIL })).toBe(EXIT.refused);
    expect(noConfig.calls).toEqual(['configure']);

    const badEmail = world('revoke-sessions');
    expect(await runRecovery(badEmail.deps, { operation: 'revoke-sessions', email: 'not-an-email' })).toBe(EXIT.refused);
    expect(badEmail.calls).toEqual([]);

    const down = world('revoke-sessions', { connectError: Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'), { code: 'ECONNREFUSED' }) });
    expect(await runRecovery(down.deps, { operation: 'revoke-sessions', email: EMAIL })).toBe(EXIT.refused);
    expect(down.text()).toMatch(/\(ECONNREFUSED\)/);
    expect(down.text()).not.toMatch(/hunter2|10\.0\.0\.5/);
    expect(down.calls).not.toContain('ask');
    for (const w of [noConfig, badEmail, down]) untouched(w);
  });

  it('unexpected schema, pending migrations or a missing audit table: refused before any prompt', async () => {
    const w = world('revoke-sessions', { schemaProblems: ['No existe la tabla "platform_audit_logs"'] });
    expect(await runRecovery(w.deps, { operation: 'revoke-sessions', email: EMAIL })).toBe(EXIT.refused);
    expect(w.text()).toMatch(/platform_audit_logs/);
    expect(w.text()).toMatch(/no se ejecutan migraciones desde esta herramienta/);
    expect(w.calls).not.toContain('ask');
    expect(w.calls).not.toContain('findTarget:' + EMAIL); // not even looked up
    untouched(w);
  });

  it('no SUPER_ADMIN with that e-mail (a nonexistent account, an ADMIN or a wrong address are indistinguishable): refused', async () => {
    const w = world('reset-password', { lookup: { status: 'not-found' } });
    expect(await runRecovery(w.deps, { operation: 'reset-password', email: EMAIL })).toBe(EXIT.refused);
    expect(w.text()).toMatch(/No existe ninguna cuenta SUPER_ADMIN con ese correo/);
    expect(w.text()).not.toMatch(/es un ADMIN|usuario ADMIN/); // never says whether an ADMIN account exists
    expect(w.calls).not.toContain('ask');
    untouched(w);
  });

  it('two SUPER_ADMIN rows for one e-mail: refused', async () => {
    const w = world('reset-password', { lookup: { status: 'ambiguous' } });
    expect(await runRecovery(w.deps, { operation: 'reset-password', email: EMAIL })).toBe(EXIT.refused);
    expect(w.text()).toMatch(/más de una cuenta/);
    untouched(w);
  });

  it('reactivate on an active account: refused up front', async () => {
    const w = world('reactivate', { target: SNAPSHOT });
    expect(await runRecovery(w.deps, { operation: 'reactivate', email: EMAIL })).toBe(EXIT.refused);
    expect(w.text()).toMatch(/ya está activa/);
    expect(w.calls).not.toContain('ask');
    untouched(w);
  });

  it('reason: mandatory, length-checked and screened for secrets — three failures give up', async () => {
    const w = world('revoke-sessions', { visible: ['corto', 'token=abcdef123456abcdef', 'x'.repeat(400)] });
    expect(await runRecovery(w.deps, { operation: 'revoke-sessions', email: EMAIL })).toBe(EXIT.refused);
    expect(w.text()).toMatch(/al menos 10/);
    expect(w.text()).toMatch(/parece contener una asignación de credencial/);
    expect(w.text()).toMatch(/No se obtuvo un motivo válido/);
    expect(w.text()).not.toContain('abcdef123456abcdef');
    untouched(w);
  });

  it('operator label: invalid text (a secret-looking one) is refused', async () => {
    const w = world('revoke-sessions', { visible: [REASON, 'password: abc', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', 'otra-cosa-larga-larga-larga-larga-larga-largaaa'] });
    expect(await runRecovery(w.deps, { operation: 'revoke-sessions', email: EMAIL })).toBe(EXIT.refused);
    expect(w.text()).toMatch(/La etiqueta del operador no es válida/);
    untouched(w);
  });

  it('password: policy violations are explained and retried; three failures give up with nothing written', async () => {
    const w = world('reset-password', { hidden: ['short', 'a'.repeat(73), EMAIL] });
    expect(await runRecovery(w.deps, { operation: 'reset-password', email: EMAIL })).toBe(EXIT.refused);
    expect(w.text()).toMatch(/al menos 12/);
    expect(w.text()).toMatch(/72 bytes/);
    expect(w.text()).toMatch(/igual al correo/);
    expect(w.text()).toMatch(/No se obtuvo una contraseña válida/);
    expect(w.text()).not.toContain('a'.repeat(73));
    expect(w.calls).not.toContain('hash');
    untouched(w);
  });

  it('password: a mismatching confirmation is retried and a later matching pair succeeds', async () => {
    const w = world('reset-password', { hidden: [PASSWORD, 'different-password-123', PASSWORD, PASSWORD] });
    expect(await runRecovery(w.deps, { operation: 'reset-password', email: EMAIL })).toBe(EXIT.ok);
    expect(w.text()).toMatch(/no coinciden/);
    expect(w.applied).toHaveLength(1);
  });

  it('a password that appears inside the reason (or the operator label) is refused — those texts land in the audit table', async () => {
    const reasonWithPassword = `Contraseña nueva elegida ${PASSWORD} para el titular`;
    // (the reason itself passes the screening: it is the combination with the password that is caught)
    const w = world('reset-password', {
      visible: [reasonWithPassword, '', reasonWithPassword, '', reasonWithPassword, ''],
      hidden: [PASSWORD, PASSWORD, PASSWORD, PASSWORD, PASSWORD, PASSWORD],
    });
    expect(await runRecovery(w.deps, { operation: 'reset-password', email: EMAIL })).toBe(EXIT.refused);
    expect(w.text()).toMatch(/aparece dentro del motivo o del operador/);
    untouched(w);
  });

  it('confirmation: a wrong phrase, another operation\'s phrase, another account or another environment are all wrong; three misses give up', async () => {
    const w = world('reset-password', {
      visible: [
        REASON,
        '',
        `REVOCAR SESIONES DE ${EMAIL} EN production`, // another operation
        `RESTABLECER CONTRASEÑA DE other@mordwave.test EN production`, // another account
        `RESTABLECER CONTRASEÑA DE ${EMAIL} EN staging`, // another environment
        `RESTABLECER CONTRASEÑA DE ${EMAIL} EN production`, // would be right, but the attempts are gone
      ],
    });
    expect(await runRecovery(w.deps, { operation: 'reset-password', email: EMAIL })).toBe(EXIT.refused);
    expect(w.text()).toMatch(/Confirmación incorrecta\. No se modificó nada/);
    expect(w.calls).not.toContain('hash');
    untouched(w);
  });

  it('a confirmation that is right on the second try is accepted', async () => {
    const w = world('revoke-sessions');
    w.deps.prompter.ask = vi.fn().mockResolvedValueOnce(REASON).mockResolvedValueOnce('').mockResolvedValueOnce('si').mockResolvedValueOnce(w.phrase);
    expect(await runRecovery(w.deps, { operation: 'revoke-sessions', email: EMAIL })).toBe(EXIT.ok);
    expect(w.text()).toMatch(/Confirmación incorrecta\./);
  });

  it('the confirmation names the environment of THIS connection (a different configured environment changes the phrase)', async () => {
    const w = world('revoke-sessions', { environment: 'staging' });
    expect(w.phrase).toBe(`REVOCAR SESIONES DE ${EMAIL} EN staging`);
    expect(await runRecovery(w.deps, { operation: 'revoke-sessions', email: EMAIL })).toBe(EXIT.ok);
    expect(w.applied[0]!.environment).toBe('staging');
  });

  it('Ctrl-C at any prompt cancels with nothing written', async () => {
    const w = world('reset-password', { abort: true });
    expect(await runRecovery(w.deps, { operation: 'reset-password', email: EMAIL })).toBe(EXIT.refused);
    expect(w.text()).toMatch(/CANCELADO/);
    untouched(w);
  });
});

describe('recovery: races and failures', () => {
  it.each([
    ['state-changed', /El estado de la cuenta cambió.*no se sobrescribió nada/],
    ['target-gone', /ya no existe como SUPER_ADMIN/],
    ['already-active', /quedó activa/],
  ] as const)('the transaction\'s refusal "%s" is reported as a refusal, not as success', async (status, pattern) => {
    const w = world('revoke-sessions', { applyOutcome: { status } });
    expect(await runRecovery(w.deps, { operation: 'revoke-sessions', email: EMAIL })).toBe(EXIT.refused);
    expect(w.text()).toMatch(pattern);
    expect(w.text()).not.toMatch(/\[OK\]/);
  });

  it('an unexpected error prints only its code (never the message, which could carry data)', async () => {
    const error = Object.assign(new Error(`UPDATE failed for [${EMAIL}, $2b$12$secrethash, ${PASSWORD}]`), { code: '40001' });
    const w = world('reset-password', { applyOutcome: error });
    expect(await runRecovery(w.deps, { operation: 'reset-password', email: EMAIL })).toBe(EXIT.failure);
    expect(w.text()).toMatch(/\(40001\)/);
    expect(w.text()).toMatch(/o se guardan los dos o ninguno/);
    expect(w.text()).not.toMatch(/secrethash|UPDATE failed/);
    expect(w.text()).not.toContain(PASSWORD);
    expect(w.applied).toHaveLength(1); // no automatic retry
    expect(w.calls.at(-1)).toBe('close');
  });

  it('an uncertain COMMIT is reported as ambiguous, with the read-only way to find out, and is not retried', async () => {
    const w = world('reset-password', { applyOutcome: new CommitUncertainError(Object.assign(new Error('terminated, password=abc'), { code: '08006' })) });
    expect(await runRecovery(w.deps, { operation: 'reset-password', email: EMAIL })).toBe(EXIT.failure);
    expect(w.text()).toMatch(/\[AMBIGUO\].*\(08006\)/);
    expect(w.text()).toMatch(/NO lo reintentes.*--check --email/);
    expect(w.text()).not.toMatch(/password=abc|\[OK\]/);
    expect(w.applied).toHaveLength(1);
  });
});

describe('--check', () => {
  it('is read-only: connects and inspects inside readOnly; never prompts, hashes or applies; shows the account and the effects', async () => {
    const w = world('reset-password');
    expect(await runCheck(w.deps, { email: EMAIL })).toBe(EXIT.ok);
    expect(w.calls).toEqual(['configure', 'connect', 'ping', 'readOnly:begin', 'inspectSchema', `findTarget:${EMAIL}`, 'recentAudit', 'readOnly:end', 'close']);
    expect(w.applied).toEqual([]);
    const text = w.text();
    expect(text).toMatch(/\[check\] resultado: OK \(nada fue modificado\)/);
    expect(text).toMatch(/tabla platform_audit_logs presente/);
    expect(text).toMatch(/credentials_version: 3/);
    expect(text).toMatch(/must_change_password: no/);
    for (const operation of ['reset-password', 'reactivate', 'revoke-sessions']) expect(text).toContain(`${operation} haría:`);
    expect(text).toMatch(/SUPER_ADMIN_BOOTSTRAPPED {2}\(bootstrap-cli\)/);
    expect(text).not.toMatch(/\$2|password_hash/);
  });

  it('works without a terminal (it needs no secret)', async () => {
    const w = world('reset-password', { interactive: false });
    expect(await runCheck(w.deps, { email: EMAIL })).toBe(EXIT.ok);
  });

  it('is safe with bad input: an invalid e-mail does not even configure; missing account, schema problems and connection errors fail without writing', async () => {
    const invalid = world('reset-password');
    expect(await runCheck(invalid.deps, { email: 'nope' })).toBe(EXIT.refused);
    expect(invalid.calls).toEqual([]);

    const missing = world('reset-password', { lookup: { status: 'not-found' } });
    expect(await runCheck(missing.deps, { email: EMAIL })).toBe(EXIT.refused);
    expect(missing.text()).toMatch(/No existe ninguna cuenta SUPER_ADMIN con ese correo/);

    const ambiguous = world('reset-password', { lookup: { status: 'ambiguous' } });
    expect(await runCheck(ambiguous.deps, { email: EMAIL })).toBe(EXIT.refused);

    const badSchema = world('reset-password', { schemaProblems: ['No existe la tabla "platform_audit_logs"'] });
    expect(await runCheck(badSchema.deps, { email: EMAIL })).toBe(EXIT.refused);
    expect(badSchema.text()).toMatch(/platform_audit_logs/);
    expect(badSchema.calls).not.toContain(`findTarget:${EMAIL}`);

    const noConfig = world('reset-password', { configError: new ConfigError('Configuración insuficiente') });
    expect(await runCheck(noConfig.deps, { email: EMAIL })).toBe(EXIT.refused);

    const down = world('reset-password', { connectError: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) });
    expect(await runCheck(down.deps, { email: EMAIL })).toBe(EXIT.refused);
    expect(down.text()).toMatch(/\(ENOTFOUND\)/);

    for (const w of [invalid, missing, ambiguous, badSchema, noConfig, down]) expect(w.applied).toEqual([]);
  });

  it('an unexpected error is reported as a code and says nothing was modified', async () => {
    const w = world('reset-password');
    (w.deps.configure() as RecoveryConfigured).db.findTarget = async () => {
      throw Object.assign(new Error('boom with secret'), { code: 'XX000' });
    };
    expect(await runCheck(w.deps, { email: EMAIL })).toBe(EXIT.failure);
    expect(w.text()).toMatch(/\(XX000\).*No se modificó nada/);
    expect(w.text()).not.toMatch(/secret/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// the tool is never started by the application, and cannot take secrets from anywhere but the prompts
// ---------------------------------------------------------------------------------------------------------------------
describe('no automatic execution, no secret inputs', () => {
  const walk = (dir: URL): URL[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(new URL(`${e.name}/`, dir)) : [new URL(e.name, dir)]));
  const files = readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));

  it('nothing outside src/cli imports it (no module, controller, seed or main references it)', () => {
    const srcRoot = new URL('../../', import.meta.url);
    const offenders = walk(srcRoot)
      .filter((u) => u.pathname.endsWith('.ts') && !u.pathname.includes('/src/cli/'))
      .filter((u) => /recover-super-admin|platform-audit\.js/.test(code(readFileSync(u, 'utf8'))))
      .map((u) => u.pathname.split('/src/')[1]);
    expect(offenders).toEqual([]);
  });

  it('no npm script, start command or seed runs it', () => {
    const scripts = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).scripts as Record<string, string>;
    expect(Object.values(scripts).filter((s) => /recover-super-admin|cli\//.test(s))).toEqual([]);
    expect(code(read('../../seed.ts'))).not.toMatch(/recover|SUPER_ADMIN/);
  });

  it('importing the entry module does not run anything (it only runs when invoked directly)', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const module = await import('./main.js');
      expect(typeof module.main).toBe('function');
      expect(exit).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      write.mockRestore();
    }
  });

  it('the code has no HTTP, no Nest, no ORM, no migration runner, no seed and no env/file input for secrets', () => {
    for (const file of files) {
      const source = code(read(file));
      expect(source, file).not.toMatch(/@nestjs|from 'typeorm'|express|listen\(|runMigrations|migration:run|synchronize|dotenv/);
      expect(source, file).not.toMatch(/readFile|--password-stdin|RECOVER_PASSWORD/i);
      if (file !== 'main.ts') expect(source, file).not.toMatch(/process\.env/);
    }
    // the only environment the tool reads is the connection's, in main.ts (passed down as `env`), never a password
    expect(code(read('main.ts'))).toMatch(/process\.env/);
    expect(code(read('main.ts'))).not.toMatch(/process\.env\.[A-Z_]*(PASS|REASON|OPERATOR|CONFIRM)/i);
  });

  it('hashes with the project\'s bcrypt cost (the same constant as the bootstrap, the seed and the login)', () => {
    expect(code(read('main.ts'))).toMatch(/bcrypt\.hash\(password, BCRYPT_COST\)/);
    expect(code(read('main.ts'))).toMatch(/import \{ BCRYPT_COST \} from '\.\.\/bootstrap-super-admin\/constants\.js'/);
  });

  it('database writes live in one file: exactly one UPDATE of users, no DELETE, no user INSERT, no DDL', () => {
    const writers = files.filter((f) => /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/.test(code(read(f))));
    expect(writers).toEqual(['recovery-db.ts']);
    const db = code(read('recovery-db.ts'));
    expect((db.match(/\bUPDATE users\b/g) ?? []).length).toBe(1);
    expect(db).not.toMatch(/\bDELETE\b|INSERT INTO users|ALTER|DROP|TRUNCATE|CREATE /);
    expect(db).not.toMatch(/SELECT[^;`]*password_hash/); // the hash is only ever written
    expect(db).not.toMatch(/\brole\s*=\s*'|SET[^`]*\brole\b|SET[^`]*\bemail\b|SET[^`]*business_id/); // never changes role, e-mail or business
  });
});
