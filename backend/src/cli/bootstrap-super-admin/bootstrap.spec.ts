import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parseArgs, UsageError } from './args.js';
import { BootstrapDb, migrationNameFromFile, type SqlExecutor } from './bootstrap-db.js';
import { BCRYPT_COST, PASSWORD_MAX_BYTES } from './constants.js';
import { ConfigError, resolveConnection, type TargetInfo } from './connection.js';
import { EXIT, runBootstrap, runCheck, type Configured } from './core.js';
import { normalizeEmail, validateEmail } from './email.js';
import { validateBootstrapPassword } from './password-policy.js';
import { createTtyPrompter, PromptAborted, type Prompter, type TtyInput, type TtyOutput } from './prompter.js';
import { PLATFORM_ADMIN_LOCK_KEY } from '../shared/platform-audit.js';

const here = new URL('.', import.meta.url);
const read = (relative: string) => readFileSync(new URL(relative, here), 'utf8');
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PASSWORD = 'correct-horse-battery-staple';
const EMAIL = 'root@mordwave.test';
const TARGET: TargetInfo = { source: 'DATABASE_URL', host: 'db.internal', port: '5432', database: 'appdb', ssl: true, environment: 'production', service: 'backend' };

// ---------------------------------------------------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------------------------------------------------
describe('arguments', () => {
  it('parses --check, --email (both forms) and --help', () => {
    expect(parseArgs([])).toEqual({ mode: 'bootstrap', email: null });
    expect(parseArgs(['--check'])).toEqual({ mode: 'check', email: null });
    expect(parseArgs(['--email', 'a@b.cl'])).toEqual({ mode: 'bootstrap', email: 'a@b.cl' });
    expect(parseArgs(['--email=a@b.cl'])).toEqual({ mode: 'bootstrap', email: 'a@b.cl' });
    expect(parseArgs(['--help']).mode).toBe('help');
  });

  it.each(['--password', '--password=hunter2', '-p', '--pass', '--passwd=x', '--secret', '--token=abc'])('refuses %s: the password is never taken from arguments', (flag) => {
    expect(() => parseArgs([flag])).toThrow(UsageError);
    expect(() => parseArgs(['--email', 'a@b.cl', flag, 'x'])).toThrow(/prompt oculto/);
  });

  it('refuses unknown options without echoing their value, a missing --email value, and --check with --email', () => {
    expect(() => parseArgs(['--force'])).toThrow(/Opción desconocida: --force/);
    expect(() => parseArgs(['--yes'])).toThrow(UsageError); // there is no way to skip the confirmation
    expect(() => parseArgs(['--email'])).toThrow(/necesita un valor/);
    expect(() => parseArgs(['--email', '--check'])).toThrow(/necesita un valor/);
    expect(() => parseArgs(['--check', '--email', 'a@b.cl'])).toThrow(/solo de lectura/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// email and password rules
// ---------------------------------------------------------------------------------------------------------------------
describe('email', () => {
  it('normalises like the login (trim + lowercase) and validates', () => {
    expect(normalizeEmail('  Root@MordWave.Test ')).toBe('root@mordwave.test');
    expect(validateEmail('  Root@MordWave.Test ')).toBe('root@mordwave.test');
    for (const bad of ['', '   ', 'no-at-sign', 'a@', '@b.cl', 'a b@c.cl', `${'x'.repeat(250)}@b.cl`]) expect(validateEmail(bad)).toBeNull();
  });
});

describe('password policy', () => {
  it('accepts a good password and the exact boundaries (12 characters, 72 bytes)', () => {
    expect(validateBootstrapPassword(PASSWORD, EMAIL)).toEqual([]);
    expect(validateBootstrapPassword('a'.repeat(12), EMAIL)).toEqual([]);
    expect(validateBootstrapPassword('a'.repeat(72), EMAIL)).toEqual([]);
    expect(validateBootstrapPassword('🔐'.repeat(12), EMAIL)).toEqual([]); // 12 characters, 48 bytes
  });

  it('refuses empty / blank, too short, over 72 BYTES (not characters) and equal to the email', () => {
    expect(validateBootstrapPassword('', EMAIL)[0]).toMatch(/vacía/);
    expect(validateBootstrapPassword('            ', EMAIL)[0]).toMatch(/vacía/);
    expect(validateBootstrapPassword('a'.repeat(11), EMAIL).join()).toMatch(/al menos 12/);
    expect(validateBootstrapPassword('a'.repeat(73), EMAIL).join()).toMatch(/72 bytes/);
    expect(validateBootstrapPassword('é'.repeat(40), EMAIL).join()).toMatch(/72 bytes/); // 40 characters but 80 bytes
    expect(validateBootstrapPassword('🔐'.repeat(19), EMAIL).join()).toMatch(/72 bytes/); // 19 characters, 76 bytes
    expect(validateBootstrapPassword('ROOT@mordwave.test', EMAIL).join()).toMatch(/igual al correo/);
    expect(PASSWORD_MAX_BYTES).toBe(72);
  });

  it('its messages never contain the password', () => {
    const secret = 'tiny-pw';
    expect(validateBootstrapPassword(secret, EMAIL).join(' ')).not.toContain(secret);
  });
});

describe('constants', () => {
  it('uses the same bcrypt cost as the seed and the login dummy hash', () => {
    expect(BCRYPT_COST).toBe(12);
    expect(read('../../seed.ts')).toMatch(/BCRYPT_COST = 12/);
    expect(read('../../auth/auth.service.ts')).toMatch(/bcrypt\.hashSync\([^)]*, 12\)/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// connection settings
// ---------------------------------------------------------------------------------------------------------------------
describe('connection settings', () => {
  it('has NO defaults: names the missing variables (never values) and refuses', () => {
    expect(() => resolveConnection({})).toThrow(ConfigError);
    expect(() => resolveConnection({})).toThrow(/DATABASE_URL.*DB_HOST, DB_NAME, DB_USERNAME, DB_PASSWORD/);
    expect(() => resolveConnection({ DB_HOST: 'h', DB_NAME: 'd' })).toThrow(/DB_USERNAME, DB_PASSWORD/);
  });

  it('describes the target without credentials (host, port, database, ssl, environment)', () => {
    const r = resolveConnection({ DATABASE_URL: 'postgresql://app_user:s3cr3t-pass@postgres.railway.internal:5433/railway', RAILWAY_ENVIRONMENT_NAME: 'production', RAILWAY_SERVICE_NAME: 'mordwave-brasa47' });
    expect(r.target).toEqual({ source: 'DATABASE_URL', host: 'postgres.railway.internal', port: '5433', database: 'railway', ssl: true, environment: 'production', service: 'mordwave-brasa47' });
    expect(JSON.stringify(r.target)).not.toMatch(/app_user|s3cr3t/);
  });

  it('rejects an invalid DATABASE_URL without echoing it', () => {
    let message = '';
    try {
      resolveConnection({ DATABASE_URL: 'not a url with secret-token' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/no es una URL de PostgreSQL válida/);
    expect(message).not.toContain('secret-token');
    expect(() => resolveConnection({ DATABASE_URL: 'mysql://u:p@h/db' })).toThrow(ConfigError);
  });

  it('supports the DB_* set (no ssl) with an explicit port default only for DB_PORT', () => {
    const r = resolveConnection({ DB_HOST: 'localhost', DB_NAME: 'x', DB_USERNAME: 'u', DB_PASSWORD: 'p' });
    expect(r.target).toMatchObject({ source: 'DB_*', host: 'localhost', port: '5432', database: 'x', ssl: false });
    expect(r.clientConfig).toMatchObject({ host: 'localhost', port: 5432, user: 'u', database: 'x', application_name: 'mordwave-bootstrap-super-admin' });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// the hidden prompt
// ---------------------------------------------------------------------------------------------------------------------
function fakeTerminal(options: { tty?: boolean; raw?: boolean } = {}) {
  const listeners = new Map<string, Array<(chunk?: Buffer | string) => void>>();
  const written: string[] = [];
  const rawCalls: boolean[] = [];
  const input: TtyInput = {
    isTTY: options.tty ?? true,
    ...(options.raw === false ? {} : { setRawMode: (mode: boolean) => void rawCalls.push(mode) }),
    resume: () => undefined,
    pause: () => undefined,
    on: (event, listener) => void listeners.set(event, [...(listeners.get(event) ?? []), listener]),
    off: (event, listener) => void listeners.set(event, (listeners.get(event) ?? []).filter((l) => l !== listener)),
  };
  const output: TtyOutput = { isTTY: options.tty ?? true, write: (text) => void written.push(text) };
  const emit = (event: 'data' | 'end', chunk?: Buffer | string) => [...(listeners.get(event) ?? [])].forEach((l) => l(chunk));
  return { input, output, emit, written, rawCalls, listeners };
}

describe('hidden prompt', () => {
  it('reads without echoing anything, supports Backspace, ignores arrow keys, and restores the terminal', async () => {
    const t = fakeTerminal();
    const prompter = createTtyPrompter(t.input, t.output);
    const answer = prompter.askHidden('Contraseña: ');
    t.emit('data', Buffer.from('abcX'));
    t.emit('data', Buffer.from([0x7f])); // Backspace removes X
    t.emit('data', Buffer.from('\u001b[A\u001b[D')); // arrow keys: ignored
    t.emit('data', Buffer.from('d\r'));
    await expect(answer).resolves.toBe('abcd');
    expect(t.written.join('')).toBe('Contraseña: \n'); // the question and the final newline: NO secret character was written
    expect(t.rawCalls).toEqual([true, false]);
    expect(t.listeners.get('data')).toEqual([]);
  });

  it('handles multi-byte characters split across chunks, and pasted text with a trailing newline', async () => {
    const t = fakeTerminal();
    const answer = createTtyPrompter(t.input, t.output).askHidden('> ');
    const bytes = Buffer.from('clave-é🔐', 'utf8');
    t.emit('data', bytes.subarray(0, 7)); // cuts the é in half
    t.emit('data', bytes.subarray(7, 9));
    t.emit('data', Buffer.concat([bytes.subarray(9), Buffer.from('\n')]));
    await expect(answer).resolves.toBe('clave-é🔐');
  });

  it('a visible question echoes what is typed', async () => {
    const t = fakeTerminal();
    const answer = createTtyPrompter(t.input, t.output).ask('? ');
    t.emit('data', Buffer.from('si\r'));
    await expect(answer).resolves.toBe('si');
    expect(t.written.join('')).toContain('si');
  });

  it('Ctrl-C aborts, Ctrl-D aborts only on an empty line, and the terminal is restored', async () => {
    const t = fakeTerminal();
    const prompter = createTtyPrompter(t.input, t.output);
    const first = prompter.askHidden('> ');
    t.emit('data', Buffer.from([0x03]));
    await expect(first).rejects.toBeInstanceOf(PromptAborted);
    expect(t.rawCalls).toEqual([true, false]);

    const second = prompter.askHidden('> ');
    t.emit('data', Buffer.from('ab'));
    t.emit('data', Buffer.from([0x04])); // not empty: ignored
    t.emit('data', Buffer.from('\r'));
    await expect(second).resolves.toBe('ab');
    const third = prompter.askHidden('> ');
    t.emit('data', Buffer.from([0x04]));
    await expect(third).rejects.toBeInstanceOf(PromptAborted);
  });

  it('a closed stream aborts', async () => {
    const t = fakeTerminal();
    const answer = createTtyPrompter(t.input, t.output).askHidden('> ');
    t.emit('end');
    await expect(answer).rejects.toBeInstanceOf(PromptAborted);
  });

  it('is NOT interactive without a TTY on both ends or without raw mode, and then refuses to read at all', async () => {
    for (const options of [{ tty: false }, { raw: false }]) {
      const t = fakeTerminal(options);
      const prompter = createTtyPrompter(t.input, t.output);
      expect(prompter.isInteractive()).toBe(false);
      await expect(prompter.askHidden('> ')).rejects.toBeInstanceOf(PromptAborted);
      expect(t.written).toEqual([]);
    }
    const half = fakeTerminal();
    half.output.isTTY = false; // e.g. stdout redirected to a file while stdin is a terminal
    expect(createTtyPrompter(half.input, half.output).isInteractive()).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// the database layer (scripted SQL, exact statements and order)
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
  return { sql, log, statements: () => log.map((l) => l.sql.split(/\s+/).slice(0, 4).join(' ')) };
}

describe('BootstrapDb.createSuperAdmin', () => {
  it('BEGIN -> advisory lock -> re-check SUPER_ADMIN -> re-check email -> INSERT (NULL business, bound hash) -> COMMIT', async () => {
    const s = scriptedSql((text) => (/INSERT INTO users/.test(text) ? [{ id: 'new-id' }] : /INSERT INTO platform_audit_logs/.test(text) ? [{ id: 'audit-id' }] : []));
    const result = await new BootstrapDb(s.sql).createSuperAdmin({ email: EMAIL, passwordHash: '$2b$12$abcdefghijklmnopqrstuv', environment: 'production' });

    expect(result).toEqual({ status: 'created', id: 'new-id', auditId: 'audit-id' });
    // the user and its SUPER_ADMIN_BOOTSTRAPPED event are written in the SAME transaction, behind the platform advisory lock
    expect(s.statements()).toEqual([
      'BEGIN',
      'SET LOCAL lock_timeout =',
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      'SELECT 1 FROM users',
      'SELECT 1 FROM users',
      'INSERT INTO users (email,',
      'INSERT INTO platform_audit_logs (action,',
      'COMMIT',
    ]);
    expect(s.log.find((l) => /pg_advisory_xact_lock/.test(l.sql))!.params).toEqual([PLATFORM_ADMIN_LOCK_KEY]);
    const audit = s.log.find((l) => /INSERT INTO platform_audit_logs/.test(l.sql))!;
    expect(audit.sql).toMatch(/NULL, \$6, \$7/); // actor_user_id is the literal NULL
    expect(audit.params).toEqual([
      'SUPER_ADMIN_BOOTSTRAPPED',
      'bootstrap-cli',
      'production',
      'new-id',
      EMAIL,
      null,
      null,
      '{"version_after":0,"active_after":true,"forced_change_after":false,"operator_identity":"none"}',
    ]);
    expect(JSON.stringify(audit.params)).not.toMatch(/\$2b\$|abcdefghijklmnopqrstuv/); // the hash never reaches the audit row
    const insert = s.log.find((l) => /INSERT INTO users/.test(l.sql))!;
    expect(insert.sql).toMatch(/business_id.*NULL/s);
    expect(insert.params).toEqual([EMAIL, '$2b$12$abcdefghijklmnopqrstuv', 'SUPER_ADMIN']);
    expect(s.log.map((l) => l.sql).join('\n')).not.toContain('$2b$12$'); // the hash is a bound parameter, never part of the SQL text
  });

  it('refuses (and rolls back, no INSERT) when a SUPER_ADMIN appeared, and when the email appeared', async () => {
    const withSuper = scriptedSql((text) => (/role = \$1/.test(text) ? [{ '?column?': 1 }] : []));
    expect(await new BootstrapDb(withSuper.sql).createSuperAdmin({ email: EMAIL, passwordHash: 'h', environment: 'production' })).toEqual({ status: 'super-admin-exists' });
    expect(withSuper.statements().at(-1)).toBe('ROLLBACK');
    expect(withSuper.log.some((l) => /INSERT/.test(l.sql))).toBe(false);

    const withEmail = scriptedSql((text) => (/lower\(email\) = \$1/.test(text) ? [{ '?column?': 1 }] : []));
    expect(await new BootstrapDb(withEmail.sql).createSuperAdmin({ email: EMAIL, passwordHash: 'h', environment: 'production' })).toEqual({ status: 'email-exists' });
    expect(withEmail.statements().at(-1)).toBe('ROLLBACK');
    expect(withEmail.log.some((l) => /INSERT/.test(l.sql))).toBe(false);
  });

  it('a unique violation on the email (the last backstop) is "email-exists", after a ROLLBACK', async () => {
    const s = scriptedSql((text) => (/INSERT INTO users/.test(text) ? Object.assign(new Error('duplicate key'), { code: '23505' }) : []));
    expect(await new BootstrapDb(s.sql).createSuperAdmin({ email: EMAIL, passwordHash: 'h', environment: 'production' })).toEqual({ status: 'email-exists' });
    expect(s.statements().at(-1)).toBe('ROLLBACK');
  });

  it('a failure of the AUDIT insert rolls the whole creation back and is rethrown (no unaudited SUPER_ADMIN), even if it looks like a unique violation', async () => {
    const boom = Object.assign(new Error('audit insert failed'), { code: '23505' });
    const s = scriptedSql((text) => (/INSERT INTO users/.test(text) ? [{ id: 'new-id' }] : /INSERT INTO platform_audit_logs/.test(text) ? boom : []));
    await expect(new BootstrapDb(s.sql).createSuperAdmin({ email: EMAIL, passwordHash: 'h', environment: 'production' })).rejects.toBe(boom);
    expect(s.statements().at(-1)).toBe('ROLLBACK');
    expect(s.log.some((l) => /COMMIT/.test(l.sql))).toBe(false);
  });

  it('any other failure rolls back and is rethrown; a failing ROLLBACK does not hide the original error', async () => {
    const boom = Object.assign(new Error('connection lost'), { code: '08006' });
    const s = scriptedSql((text) => (/INSERT INTO users/.test(text) ? boom : []));
    await expect(new BootstrapDb(s.sql).createSuperAdmin({ email: EMAIL, passwordHash: 'h', environment: 'production' })).rejects.toBe(boom);
    expect(s.statements().at(-1)).toBe('ROLLBACK');

    const broken = scriptedSql((text) => (/INSERT INTO users/.test(text) ? boom : text === 'ROLLBACK' ? new Error('gone') : []));
    await expect(new BootstrapDb(broken.sql).createSuperAdmin({ email: EMAIL, passwordHash: 'h', environment: 'production' })).rejects.toBe(boom);
  });
});

describe('BootstrapDb read-only helpers', () => {
  it('readOnly wraps the work in a READ ONLY transaction that is always rolled back, even on error', async () => {
    const s = scriptedSql();
    const db = new BootstrapDb(s.sql);
    await expect(db.readOnly(async () => 'fine')).resolves.toBe('fine');
    expect(s.statements()).toEqual(['BEGIN TRANSACTION READ ONLY', 'ROLLBACK']);
    await expect(db.readOnly(async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(s.statements().slice(-2)).toEqual(['BEGIN TRANSACTION READ ONLY', 'ROLLBACK']);
    expect(s.log.some((l) => /COMMIT/.test(l.sql))).toBe(false);
  });

  it('readState returns counts only (no hashes, no other users\' emails)', async () => {
    const s = scriptedSql((text) => (/count\(\*\)/.test(text) ? [{ users: 3, super_admins: 1 }] : [{ '?column?': 1 }]));
    const state = await new BootstrapDb(s.sql).readState(EMAIL);
    expect(state).toEqual({ users: 3, superAdmins: 1, emailTaken: true });
    expect(s.log.map((l) => l.sql).join(' ')).not.toMatch(/password_hash/);
  });

  it('migration names are derived the way TypeORM records them', () => {
    expect(migrationNameFromFile('1789679086923-AddUsers.js')).toBe('AddUsers1789679086923');
    expect(migrationNameFromFile('1789679086923-AddUsers.ts')).toBe('AddUsers1789679086923');
    expect(migrationNameFromFile('1789679086923-AddUsers.d.ts')).toBeNull();
    expect(migrationNameFromFile('1789679086923-AddUsers.js.map')).toBeNull();
    expect(migrationNameFromFile('README.md')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// the orchestration, with a fake database and a scripted operator
// ---------------------------------------------------------------------------------------------------------------------
interface World {
  superAdmins?: number;
  emailTaken?: boolean;
  schemaProblems?: string[];
  connectError?: Error;
  createOutcome?: Awaited<ReturnType<BootstrapDb['createSuperAdmin']>> | Error;
  configError?: ConfigError;
  hidden?: string[];
  visible?: string[];
  interactive?: boolean;
  abort?: boolean;
}

function world(w: World = {}) {
  const out: string[] = [];
  const calls: string[] = [];
  const created: Array<{ email: string; passwordHash: string; environment: string }> = [];
  const hidden = [...(w.hidden ?? [PASSWORD, PASSWORD])];
  const visible = [...(w.visible ?? [`CREAR SUPER_ADMIN ${EMAIL}`])];
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
    inspectSchema: async () => (calls.push('inspectSchema'), { ok: !(w.schemaProblems?.length), problems: w.schemaProblems ?? [], appliedMigrations: 16 }),
    readState: async (email: string | null) => (calls.push(`readState:${email}`), { users: 2, superAdmins: w.superAdmins ?? 0, emailTaken: w.emailTaken ?? false }),
    createSuperAdmin: async (input: { email: string; passwordHash: string; environment: string }) => {
      calls.push('createSuperAdmin');
      created.push(input);
      if (w.createOutcome instanceof Error) throw w.createOutcome;
      return w.createOutcome ?? { status: 'created' as const, id: '11111111-1111-4111-8111-111111111111', auditId: '22222222-2222-4222-8222-222222222222' };
    },
  } as unknown as BootstrapDb;
  const configured: Configured = {
    target: TARGET,
    db,
    connect: async () => {
      calls.push('connect');
      if (w.connectError) throw w.connectError;
    },
    close: async () => void calls.push('close'),
  };
  const prompter: Prompter = {
    isInteractive: () => w.interactive ?? true,
    ask: async (q) => {
      calls.push('ask');
      if (w.abort) throw new PromptAborted();
      return visible.shift() ?? (q ? '' : '');
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
  return { deps, out, calls, created, text: () => out.join('\n') };
}

describe('bootstrap: successful creation', () => {
  it('pre-checks read-only BEFORE asking for any secret, then creates exactly one SUPER_ADMIN with a hash', async () => {
    const w = world();
    expect(await runBootstrap(w.deps, { email: '  Root@MordWave.Test ' })).toBe(EXIT.ok);

    expect(w.created).toEqual([{ email: EMAIL, passwordHash: '$2b$12$HASHOF(28)', environment: 'production' }]); // normalised email, hash only, and the environment for the audit event
    const firstSecret = w.calls.indexOf('askHidden');
    expect(w.calls.indexOf('readOnly:begin')).toBeLessThan(firstSecret);
    expect(w.calls.indexOf('inspectSchema')).toBeLessThan(firstSecret);
    expect(w.calls.indexOf('readState:' + EMAIL)).toBeLessThan(firstSecret);
    expect(w.calls.indexOf('hash')).toBeGreaterThan(w.calls.lastIndexOf('ask')); // hashing happens after the confirmation
    expect(w.calls.indexOf('createSuperAdmin')).toBeGreaterThan(w.calls.indexOf('hash'));
    expect(w.calls.at(-1)).toBe('close');
    expect(w.text()).toMatch(/\[OK\] SUPER_ADMIN creado \(id=11111111-1111-4111-8111-111111111111\)/);
    expect(w.text()).toMatch(/SUPER_ADMIN_BOOTSTRAPPED registrado en platform_audit_logs \(id=22222222-2222-4222-8222-222222222222\), en la misma transacción/);
  });

  it('shows the non-sensitive target and what will be created before asking for the password', async () => {
    const w = world();
    await runBootstrap(w.deps, { email: EMAIL });
    const text = w.text();
    expect(text).toMatch(/host: db\.internal/);
    expect(text).toMatch(/base de datos: appdb/);
    expect(text).toMatch(/entorno: production/);
    expect(text).toMatch(/rol SUPER_ADMIN, correo root@mordwave\.test, sin negocio asociado/);
    expect(text).toMatch(/usuarios existentes: 2, SUPER_ADMIN existentes: 0/);
  });

  it('asks for the email when it was not given on the command line', async () => {
    const w = world({ visible: [EMAIL, `CREAR SUPER_ADMIN ${EMAIL}`] });
    expect(await runBootstrap(w.deps, { email: null })).toBe(EXIT.ok);
    expect(w.created[0]!.email).toBe(EMAIL);
  });

  it('the output never contains the password or a hash, only the id', async () => {
    const w = world();
    await runBootstrap(w.deps, { email: EMAIL });
    expect(w.text()).not.toContain(PASSWORD);
    expect(w.text()).not.toMatch(/\$2[aby]\$/);
    expect(w.text()).not.toMatch(/HASHOF/);
  });
});

describe('bootstrap: refusals (nothing is written)', () => {
  it('without a terminal: refused first — not even a connection is attempted', async () => {
    const w = world({ interactive: false });
    expect(await runBootstrap(w.deps, { email: EMAIL })).toBe(EXIT.refused);
    expect(w.calls).toEqual([]);
    expect(w.text()).toMatch(/terminal interactiva/);
  });

  it('missing configuration: refused, naming the problem, no connection', async () => {
    const w = world({ configError: new ConfigError('Configuración insuficiente: define DATABASE_URL') });
    expect(await runBootstrap(w.deps, { email: EMAIL })).toBe(EXIT.refused);
    expect(w.calls).toEqual(['configure']);
    expect(w.text()).toMatch(/Configuración insuficiente/);
  });

  it('invalid email: refused before connecting', async () => {
    const w = world();
    expect(await runBootstrap(w.deps, { email: 'not-an-email' })).toBe(EXIT.refused);
    expect(w.calls).not.toContain('connect');
    expect(w.created).toEqual([]);
  });

  it('cannot connect: refused with a code only', async () => {
    const w = world({ connectError: Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'), { code: 'ECONNREFUSED' }) });
    expect(await runBootstrap(w.deps, { email: EMAIL })).toBe(EXIT.refused);
    expect(w.text()).toMatch(/\(ECONNREFUSED\)/);
    expect(w.text()).not.toMatch(/hunter2|10\.0\.0\.5/);
    expect(w.calls).not.toContain('askHidden');
    expect(w.calls.at(-1)).toBe('close');
  });

  it('unexpected schema or pending migrations: refused, lists the problems, never asks for a password', async () => {
    const w = world({ schemaProblems: ['Migraciones pendientes (1): AddAuditLog1790100000000'] });
    expect(await runBootstrap(w.deps, { email: EMAIL })).toBe(EXIT.refused);
    expect(w.text()).toMatch(/Migraciones pendientes/);
    expect(w.text()).toMatch(/no se ejecutan migraciones desde esta herramienta/);
    expect(w.calls).not.toContain('askHidden');
  });

  it('a SUPER_ADMIN already exists: refused by default, before any secret is requested', async () => {
    const w = world({ superAdmins: 1 });
    expect(await runBootstrap(w.deps, { email: EMAIL })).toBe(EXIT.refused);
    expect(w.text()).toMatch(/Ya existe un SUPER_ADMIN/);
    expect(w.calls).not.toContain('askHidden');
    expect(w.created).toEqual([]);
  });

  it('the email already exists: refused, an existing user is never modified', async () => {
    const w = world({ emailTaken: true });
    expect(await runBootstrap(w.deps, { email: EMAIL })).toBe(EXIT.refused);
    expect(w.text()).toMatch(/nunca modifica usuarios existentes/);
    expect(w.calls).not.toContain('askHidden');
    expect(w.created).toEqual([]);
  });

  it('wrong confirmation: nothing hashed, nothing written', async () => {
    const w = world({ visible: ['crear super_admin'] });
    expect(await runBootstrap(w.deps, { email: EMAIL })).toBe(EXIT.refused);
    expect(w.text()).toMatch(/Confirmación incorrecta/);
    expect(w.calls).not.toContain('hash');
    expect(w.created).toEqual([]);
  });

  it('a confirmation typed for ANOTHER email is wrong', async () => {
    const w = world({ visible: ['CREAR SUPER_ADMIN other@mordwave.test'] });
    expect(await runBootstrap(w.deps, { email: EMAIL })).toBe(EXIT.refused);
    expect(w.created).toEqual([]);
  });

  it('password: invalid ones are explained and retried; three failures give up with nothing written', async () => {
    const w = world({ hidden: ['short', 'a'.repeat(73), 'x'.repeat(5)] });
    expect(await runBootstrap(w.deps, { email: EMAIL })).toBe(EXIT.refused);
    expect(w.text()).toMatch(/al menos 12/);
    expect(w.text()).toMatch(/72 bytes/);
    expect(w.text()).toMatch(/No se obtuvo una contraseña válida/);
    expect(w.created).toEqual([]);
    expect(w.text()).not.toContain('a'.repeat(73));
  });

  it('password: a mismatching confirmation is retried and a later matching pair succeeds', async () => {
    const w = world({ hidden: [PASSWORD, 'different-password-123', PASSWORD, PASSWORD] });
    expect(await runBootstrap(w.deps, { email: EMAIL })).toBe(EXIT.ok);
    expect(w.text()).toMatch(/no coinciden/);
    expect(w.created).toHaveLength(1);
  });

  it('password equal to the email is refused', async () => {
    const w = world({ hidden: [EMAIL, EMAIL, EMAIL] });
    expect(await runBootstrap(w.deps, { email: EMAIL })).toBe(EXIT.refused);
    expect(w.text()).toMatch(/igual al correo/);
  });

  it('Ctrl-C at any prompt cancels with nothing written', async () => {
    const w = world({ abort: true });
    expect(await runBootstrap(w.deps, { email: null })).toBe(EXIT.refused);
    expect(w.text()).toMatch(/CANCELADO/);
    expect(w.created).toEqual([]);
  });
});

describe('bootstrap: races and failures', () => {
  it('a SUPER_ADMIN (or the email) that appears between the pre-check and the INSERT is refused by the transaction', async () => {
    const lost = world({ createOutcome: { status: 'super-admin-exists' } });
    expect(await runBootstrap(lost.deps, { email: EMAIL })).toBe(EXIT.refused);
    expect(lost.text()).toMatch(/apareció un SUPER_ADMIN \(otra ejecución\)/);
    expect(lost.text()).not.toMatch(/\[OK\]/);

    const taken = world({ createOutcome: { status: 'email-exists' } });
    expect(await runBootstrap(taken.deps, { email: EMAIL })).toBe(EXIT.refused);
    expect(taken.text()).toMatch(/apareció un usuario con ese correo/);
  });

  it('an unexpected database error prints only its code (never the message, which could carry data) and says it rolled back', async () => {
    const error = Object.assign(new Error(`insert failed for params [${EMAIL}, $2b$12$secrethash, ${PASSWORD}]`), { code: '40001' });
    const w = world({ createOutcome: error });
    expect(await runBootstrap(w.deps, { email: EMAIL })).toBe(EXIT.failure);
    expect(w.text()).toMatch(/\(40001\)/);
    expect(w.text()).toMatch(/puede ser ambiguo/);
    expect(w.text()).toMatch(/NO reintentes a ciegas.*--check/);
    expect(w.text()).not.toMatch(/secrethash|insert failed/);
    expect(w.text()).not.toContain(PASSWORD);
    expect(w.calls.at(-1)).toBe('close');
  });

  it('an error without a usable code falls back to the error name', async () => {
    const w = world({ createOutcome: new TypeError('SQL with password=abc') });
    expect(await runBootstrap(w.deps, { email: EMAIL })).toBe(EXIT.failure);
    expect(w.text()).toMatch(/\(TypeError\)/);
    expect(w.text()).not.toMatch(/password=abc/);
  });

  it('simulated race: two runs whose pre-checks both passed — only the first INSERT wins, the second is refused', async () => {
    let taken = false;
    const make = () => {
      const w = world();
      (w.deps.configure() as Configured).db.createSuperAdmin = async () => {
        if (taken) return { status: 'super-admin-exists' as const };
        taken = true;
        return { status: 'created' as const, id: 'id-1', auditId: 'audit-1' };
      };
      return w;
    };
    // both worlds' pre-checks report "no SUPER_ADMIN"; the serialised transaction decides
    const [a, b] = [make(), make()];
    const first = await runBootstrap(a.deps, { email: EMAIL });
    const second = await runBootstrap(b.deps, { email: EMAIL });
    expect([first, second]).toEqual([EXIT.ok, EXIT.refused]);
  });
});

describe('--check', () => {
  it('is read-only: connects and inspects inside readOnly, never prompts, never hashes, never creates', async () => {
    const w = world();
    expect(await runCheck(w.deps)).toBe(EXIT.ok);
    expect(w.calls).toEqual(['configure', 'connect', 'ping', 'readOnly:begin', 'inspectSchema', 'readState:null', 'readOnly:end', 'close']);
    expect(w.created).toEqual([]);
    expect(w.text()).toMatch(/\[check\] resultado: OK \(nada fue modificado\)/);
    expect(w.text()).toMatch(/SUPER_ADMIN existentes: 0/);
    expect(w.text()).toMatch(/el bootstrap está disponible/);
  });

  it('reports an existing SUPER_ADMIN without exposing anything about it', async () => {
    const w = world({ superAdmins: 1 });
    expect(await runCheck(w.deps)).toBe(EXIT.ok);
    expect(w.text()).toMatch(/Ya existe un SUPER_ADMIN: el bootstrap lo rechazará/);
    expect(w.text()).not.toMatch(/@|\$2/);
  });

  it('works without a terminal (it needs no secret)', async () => {
    const w = world({ interactive: false });
    expect(await runCheck(w.deps)).toBe(EXIT.ok);
  });

  it('fails clearly on missing configuration, connection errors and schema problems — and still writes nothing', async () => {
    const noConfig = world({ configError: new ConfigError('Configuración insuficiente') });
    expect(await runCheck(noConfig.deps)).toBe(EXIT.refused);
    expect(noConfig.text()).toMatch(/\[FALLO\] Configuración/);

    const noConnection = world({ connectError: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) });
    expect(await runCheck(noConnection.deps)).toBe(EXIT.refused);
    expect(noConnection.text()).toMatch(/\(ENOTFOUND\)/);

    const badSchema = world({ schemaProblems: ['Falta la columna users.active.'] });
    expect(await runCheck(badSchema.deps)).toBe(EXIT.refused);
    expect(badSchema.text()).toMatch(/Falta la columna users\.active/);
    for (const w of [noConfig, noConnection, badSchema]) expect(w.created).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// the tool is never started by the application
// ---------------------------------------------------------------------------------------------------------------------
describe('no automatic execution', () => {
  const walk = (dir: URL): URL[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(new URL(`${e.name}/`, dir)) : [new URL(e.name, dir)]));

  it('nothing outside the CLI folder imports it (no module, controller, seed or main references it)', () => {
    const srcRoot = new URL('../../', import.meta.url);
    const offenders = walk(srcRoot)
      .filter((u) => u.pathname.endsWith('.ts') && !u.pathname.includes('/src/cli/'))
      .filter((u) => /bootstrap-super-admin/.test(code(readFileSync(u, 'utf8'))))
      .map((u) => u.pathname.split('/src/')[1]);
    expect(offenders).toEqual([]);
  });

  it('no npm script, start command or seed runs it', () => {
    const scripts = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).scripts as Record<string, string>;
    expect(Object.values(scripts).filter((s) => /bootstrap-super-admin|cli\//.test(s))).toEqual([]);
    expect(code(read('../../seed.ts'))).not.toMatch(/SUPER_ADMIN/);
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

  it('the CLI code has no HTTP, no Nest, no ORM, no migration runner, no seed and no env/file password input', () => {
    for (const file of readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts') && !f.endsWith('.d.ts'))) {
      const source = code(read(file));
      expect(source, file).not.toMatch(/@nestjs|from 'typeorm'|express|listen\(|runMigrations|migration:run|synchronize|dotenv/);
      expect(source, file).not.toMatch(/process\.env\.[A-Z_]*PASS|readFile|--password-stdin|BOOTSTRAP_PASSWORD/i);
    }
    // the only database writes are in one place
    const writes = readdirSync(here)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
      .filter((f) => /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/.test(code(read(f))));
    expect(writes).toEqual(['bootstrap-db.ts']);
    expect((code(read('bootstrap-db.ts')).match(/INSERT INTO/g) ?? []).length).toBe(1);
    expect(code(read('bootstrap-db.ts'))).not.toMatch(/\b(UPDATE|DELETE|ALTER|DROP)\b/);
  });

  it('does not modify existing users: the module never issues an UPDATE or DELETE', () => {
    expect(code(read('bootstrap-db.ts'))).not.toMatch(/UPDATE users|DELETE FROM/);
  });
});
