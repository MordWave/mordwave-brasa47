import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SqlExecutor } from '../bootstrap-super-admin/bootstrap-db.js';
import {
  AUDIT_ACTION,
  AUDIT_METADATA_KEYS,
  AUDIT_SOURCE,
  auditEnvironment,
  buildAuditMetadata,
  insertPlatformAudit,
  PLATFORM_ADMIN_LOCK_KEY,
  validateFreeText,
} from './platform-audit.js';

const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const cliRoot = new URL('../', import.meta.url);
const walk = (dir: URL): URL[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(new URL(`${e.name}/`, dir)) : [new URL(e.name, dir)]));
const sources = () => walk(cliRoot).filter((u) => u.pathname.endsWith('.ts') && !u.pathname.endsWith('.spec.ts') && !u.pathname.endsWith('.d.ts'));

describe('platform audit: vocabulary', () => {
  it('uses the exact action and source names of the contract', () => {
    expect(AUDIT_ACTION).toEqual({
      bootstrapped: 'SUPER_ADMIN_BOOTSTRAPPED',
      passwordReset: 'SUPER_ADMIN_PASSWORD_RESET',
      reactivated: 'SUPER_ADMIN_REACTIVATED',
      sessionsRevoked: 'SUPER_ADMIN_SESSIONS_REVOKED',
    });
    expect(AUDIT_SOURCE).toEqual({ bootstrap: 'bootstrap-cli', recovery: 'recovery-cli' });
    // the table's own CHECKs (action ~ ^[A-Z][A-Z0-9_]{2,79}$, source ~ ^[a-z][a-z0-9-]{1,39}$)
    for (const action of Object.values(AUDIT_ACTION)) expect(action).toMatch(/^[A-Z][A-Z0-9_]{2,79}$/);
    for (const source of Object.values(AUDIT_SOURCE)) expect(source).toMatch(/^[a-z][a-z0-9-]{1,39}$/);
  });

  it('no allowed metadata key could trip the table\'s "no secret-named keys" CHECK', () => {
    const forbidden = /password|passwd|secret|token|jwt|authorization|api[-_]?key|hash|private|ssh|credential/i; // same list as the migration
    expect(AUDIT_METADATA_KEYS.length).toBeGreaterThan(0);
    for (const key of AUDIT_METADATA_KEYS) expect(key).not.toMatch(forbidden);
  });
});

describe('platform audit: metadata is a CLOSED list', () => {
  it('passes the allowed, correctly typed fields and nothing else', () => {
    expect(buildAuditMetadata({ version_before: 3, version_after: 4, active_before: false, active_after: true, forced_change_before: false, forced_change_after: true, operator_identity: 'declared-unverified' })).toEqual({
      version_before: 3,
      version_after: 4,
      active_before: false,
      active_after: true,
      forced_change_before: false,
      forced_change_after: true,
      operator_identity: 'declared-unverified',
    });
    expect(buildAuditMetadata({ version_after: undefined })).toEqual({});
  });

  it.each([
    ['an unknown key', { note: 'x' }],
    ['a secret-looking key', { password_hash: '$2b$12$x' }],
    ['a string where a count is expected', { version_before: '3' }],
    ['a negative count', { version_before: -1 }],
    ['a fractional count', { version_after: 1.5 }],
    ['a number where a boolean is expected', { active_before: 1 }],
    ['a free-text identity', { operator_identity: 'alice' }],
    ['an object value', { version_before: { a: 1 } }],
  ])('refuses %s (and never echoes the value in the error)', (_label, input) => {
    let message = '';
    try {
      buildAuditMetadata(input as Record<string, unknown>);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/Campo de auditoría no permitido/);
    expect(message).not.toMatch(/\$2b|alice/);
  });
});

describe('platform audit: free text (reason, operator) is untrusted', () => {
  const reason = { min: 10, max: 300, label: 'Motivo' };

  it('accepts a normal sentence, trimming and collapsing whitespace', () => {
    expect(validateFreeText('  Pérdida de acceso   del titular, ticket 1234  ', reason)).toEqual({ ok: true, value: 'Pérdida de acceso del titular, ticket 1234' });
  });

  it('enforces the length bounds (in characters) and refuses control characters', () => {
    expect(validateFreeText('corto', reason)).toMatchObject({ ok: false, problem: expect.stringContaining('al menos 10') });
    expect(validateFreeText('a b '.repeat(100), reason)).toMatchObject({ ok: false, problem: expect.stringContaining('máximo 300') });
    expect(validateFreeText('motivo con\u0007campana', reason)).toMatchObject({ ok: false });
    expect(validateFreeText('motivo con \u001b[31mcolor', reason)).toMatchObject({ ok: false });
    expect(validateFreeText('🔐'.repeat(10), reason)).toMatchObject({ ok: true }); // characters, not bytes
  });

  it.each([
    ['a bcrypt hash', 'cambio hecho con $2b$12$abcdefghijklmnopqrstuuVwxyz1234567890ABCDEFGHIJKLMNO'],
    ['a JWT', 'sesión eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.firma-de-ejemplo'],
    ['a private key', 'pegué -----BEGIN OPENSSH PRIVATE KEY----- por error'],
    ['a URL with credentials', 'conexión postgresql://usuario:clave@host.internal/db'],
    ['a credential assignment', 'la contraseña: hunter2hunter2'],
    ['an assignment in English', 'password=abc123abc123'],
    ['a long opaque string', 'token pegado AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'],
  ])('refuses text that looks like %s, without echoing it', (_label, text) => {
    const result = validateFreeText(text, reason);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/parece contener/);
    if (!result.ok) expect(result.problem).not.toContain(text);
  });
});

describe('platform audit: environment name', () => {
  it('keeps a plain name and replaces anything else', () => {
    expect(auditEnvironment('production')).toBe('production');
    expect(auditEnvironment('staging-2')).toBe('staging-2');
    expect(auditEnvironment('desconocido')).toBe('desconocido');
    for (const bad of ['', '  x', 'a'.repeat(61), 'prod;DROP', 'línea\nnueva']) expect(auditEnvironment(bad)).toBe('desconocido');
  });
});

describe('platform audit: insert', () => {
  function recorder(rows: Array<Record<string, unknown>>) {
    const log: Array<{ sql: string; params?: unknown[] }> = [];
    const sql: SqlExecutor = { query: async (text, params) => (log.push({ sql: text, params }), { rows }) };
    return { sql, log };
  }
  const event = {
    action: AUDIT_ACTION.sessionsRevoked,
    source: AUDIT_SOURCE.recovery,
    environment: 'production',
    targetUserId: 'user-id',
    targetEmail: 'root@mordwave.test',
    reason: 'Revocación preventiva tras pérdida del portátil',
    operatorLabel: null,
    metadata: { version_before: 1, version_after: 2 },
  } as const;

  it('inserts exactly one row with the actor as the literal NULL and everything else bound', async () => {
    const r = recorder([{ id: 'audit-id' }]);
    await expect(insertPlatformAudit(r.sql, { ...event })).resolves.toBe('audit-id');
    expect(r.log).toHaveLength(1);
    expect(r.log[0]!.sql).toMatch(/INSERT INTO platform_audit_logs/);
    expect(r.log[0]!.sql).toMatch(/\$5, NULL, \$6/); // target_email, actor_user_id = NULL, operator_label
    expect(r.log[0]!.params).toEqual([
      'SUPER_ADMIN_SESSIONS_REVOKED',
      'recovery-cli',
      'production',
      'user-id',
      'root@mordwave.test',
      null,
      'Revocación preventiva tras pérdida del portátil',
      '{"version_before":1,"version_after":2}',
    ]);
  });

  it('fails (so the caller rolls back) when the row did not come back, and when the metadata is not allowed', async () => {
    await expect(insertPlatformAudit(recorder([]).sql, { ...event })).rejects.toThrow(/no se registró/);
    const r = recorder([{ id: 'x' }]);
    await expect(insertPlatformAudit(r.sql, { ...event, metadata: { password_hash: 'x' } as never })).rejects.toThrow(/no permitido/);
    expect(r.log).toEqual([]); // nothing was sent to the database
  });
});

describe('platform audit: wiring across the CLI sources', () => {
  it('the audit table is written in exactly one place', () => {
    const writers = sources()
      .filter((u) => /INSERT INTO platform_audit_logs|UPDATE platform_audit_logs|DELETE FROM platform_audit_logs/.test(code(readFileSync(u, 'utf8'))))
      .map((u) => u.pathname.split('/src/cli/')[1]);
    expect(writers).toEqual(['shared/platform-audit.ts']);
  });

  it('both tools use the one shared advisory lock key and no other', () => {
    const lockers = sources()
      .filter((u) => /pg_advisory/.test(code(readFileSync(u, 'utf8'))))
      .map((u) => u.pathname.split('/src/cli/')[1])
      .sort();
    expect(lockers).toEqual(['bootstrap-super-admin/bootstrap-db.ts', 'recover-super-admin/recovery-db.ts']);
    for (const file of lockers) {
      const text = code(readFileSync(new URL(file, cliRoot), 'utf8'));
      expect(text, file).toMatch(/pg_advisory_xact_lock\(hashtext\(\$1\)\)', \[PLATFORM_ADMIN_LOCK_KEY\]/);
      expect(text, file).not.toMatch(/pg_advisory_lock|pg_try_advisory|mordwave:/);
    }
    expect(PLATFORM_ADMIN_LOCK_KEY).toBe('mordwave:platform-super-admin');
  });

  it('no CLI source records a secret-shaped field: the insert has no password/hash/token column and actor_user_id is NULL', () => {
    const text = code(readFileSync(new URL('platform-audit.ts', import.meta.url), 'utf8'));
    expect(text).toMatch(/VALUES \(\$1, \$2, \$3, \$4, \$5, NULL, \$6, \$7, \$8::jsonb\)/);
  });
});
