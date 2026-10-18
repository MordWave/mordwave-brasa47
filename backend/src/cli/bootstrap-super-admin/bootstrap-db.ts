import { AUDIT_ACTION, AUDIT_SOURCE, auditEnvironment, insertPlatformAudit, PLATFORM_ADMIN_LOCK_KEY } from '../shared/platform-audit.js';
import { SUPER_ADMIN_ROLE } from './constants.js';

// Everything the bootstrap does to the database, over a minimal SQL executor (a `pg` Client in production, the same client
// in the PGlite integration test). Plain SQL with bound parameters: no ORM, so an error can never drag the statement's
// parameters (the password hash) into a message.
export interface SqlExecutor {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export type CreateOutcome =
  | { status: 'created'; id: string; auditId: string }
  | { status: 'super-admin-exists' }
  | { status: 'email-exists' };

export interface SchemaReport {
  ok: boolean;
  problems: string[];
  appliedMigrations: number;
}

export interface StateReport {
  users: number;
  superAdmins: number;
  emailTaken: boolean;
}

const POSTGRES_UNIQUE_VIOLATION = '23505';

// What the `users` table must look like for this tool to be allowed to write to it (the entity as of today).
const EXPECTED_COLUMNS: Record<string, string> = {
  id: 'uuid',
  email: 'character varying',
  password_hash: 'text',
  role: 'USER-DEFINED',
  business_id: 'uuid',
  active: 'boolean',
  created_at: 'timestamp with time zone',
  updated_at: 'timestamp with time zone',
  credentials_version: 'integer', // AddCredentialsSecurity: recovery bumps it; bootstrap leaves the default
  must_change_password: 'boolean',
};

// The platform audit table (AddPlatformAuditLogs): every SUPER_ADMIN operation records itself there in its own transaction.
const EXPECTED_AUDIT_COLUMNS: Record<string, string> = {
  id: 'uuid',
  created_at: 'timestamp with time zone',
  action: 'character varying',
  source: 'character varying',
  environment: 'character varying',
  target_user_id: 'uuid',
  target_email: 'character varying',
  actor_user_id: 'uuid',
  operator_label: 'character varying',
  reason: 'character varying',
  metadata: 'jsonb',
};

export class BootstrapDb {
  constructor(private readonly sql: SqlExecutor) {}

  // Runs `work` inside a transaction that PostgreSQL itself declares READ ONLY: any write attempted inside fails. Always
  // rolled back. This is what makes `--check` (and the pre-checks of the real run) strictly read-only.
  async readOnly<T>(work: () => Promise<T>): Promise<T> {
    await this.sql.query('BEGIN TRANSACTION READ ONLY');
    try {
      return await work();
    } finally {
      await this.sql.query('ROLLBACK');
    }
  }

  async ping(): Promise<void> {
    await this.sql.query('SELECT 1');
  }

  // Is the schema the one this tool was written for, with every migration shipped in this build applied?
  async inspectSchema(expectedMigrations: readonly string[]): Promise<SchemaReport> {
    const problems: string[] = [];

    const columns = await this.sql.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users'`,
    );
    if (columns.rows.length === 0) {
      problems.push('No existe la tabla "users".');
    } else {
      const byName = new Map(columns.rows.map((r) => [String(r.column_name), r]));
      for (const [name, type] of Object.entries(EXPECTED_COLUMNS)) {
        const column = byName.get(name);
        if (!column) problems.push(`Falta la columna users.${name}.`);
        else if (column.data_type !== type) problems.push(`users.${name} tiene el tipo ${String(column.data_type)} (se esperaba ${type}).`);
      }
      if (byName.get('business_id')?.is_nullable !== 'YES') problems.push('users.business_id debe admitir NULL (un SUPER_ADMIN no depende de un negocio).');
    }

    const audit = await this.sql.query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'platform_audit_logs'`,
    );
    if (audit.rows.length === 0) {
      problems.push('No existe la tabla "platform_audit_logs" (migración AddPlatformAuditLogs): sin ella no se puede registrar la auditoría.');
    } else {
      const byName = new Map(audit.rows.map((r) => [String(r.column_name), String(r.data_type)]));
      for (const [name, type] of Object.entries(EXPECTED_AUDIT_COLUMNS)) {
        const found = byName.get(name);
        if (found === undefined) problems.push(`Falta la columna platform_audit_logs.${name}.`);
        else if (found !== type) problems.push(`platform_audit_logs.${name} tiene el tipo ${found} (se esperaba ${type}).`);
      }
    }

    const roles = await this.sql.query(
      `SELECT e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typname = 'users_role_enum'`,
    );
    if (!roles.rows.some((r) => r.enumlabel === SUPER_ADMIN_ROLE)) problems.push('El tipo users_role_enum no contiene SUPER_ADMIN.');

    let appliedMigrations = 0;
    const registry = await this.sql.query(`SELECT to_regclass('public.migrations') AS registry`);
    if (registry.rows[0]?.registry == null) {
      problems.push('No existe el registro de migraciones ("migrations"): ¿se ejecutaron las migraciones?');
    } else {
      const applied = await this.sql.query('SELECT name FROM migrations');
      const appliedNames = new Set(applied.rows.map((r) => String(r.name)));
      appliedMigrations = appliedNames.size;
      const pending = expectedMigrations.filter((name) => !appliedNames.has(name));
      if (pending.length > 0) problems.push(`Migraciones pendientes (${pending.length}): ${pending.join(', ')}`);
      if (expectedMigrations.length === 0) problems.push('No se pudo determinar la lista de migraciones esperadas de esta compilación.');
    }
    return { ok: problems.length === 0, problems, appliedMigrations };
  }

  // Counts only; never a hash, never another user's email.
  async readState(email: string | null): Promise<StateReport> {
    const counts = await this.sql.query(
      `SELECT count(*)::int AS users, count(*) FILTER (WHERE role = $1)::int AS super_admins FROM users`,
      [SUPER_ADMIN_ROLE],
    );
    let emailTaken = false;
    if (email !== null) {
      emailTaken = (await this.sql.query('SELECT 1 FROM users WHERE lower(email) = $1 LIMIT 1', [email])).rows.length > 0;
    }
    return { users: Number(counts.rows[0]?.users ?? 0), superAdmins: Number(counts.rows[0]?.super_admins ?? 0), emailTaken };
  }

  // The ONLY write. One transaction: take the platform advisory lock (shared with the recovery CLI, so a second simultaneous
  // run waits here and then sees the first one's result), RE-CHECK that no SUPER_ADMIN and no such email exist, INSERT the
  // user and INSERT its SUPER_ADMIN_BOOTSTRAPPED audit event, COMMIT. Anything that goes wrong — the audit insert included —
  // rolls everything back, so neither a half-created user nor an unaudited one can exist. UNIQUE(email) is the last backstop.
  async createSuperAdmin(input: { email: string; passwordHash: string; environment: string }): Promise<CreateOutcome> {
    await this.sql.query('BEGIN');
    let insertingUser = false;
    try {
      await this.sql.query('SET LOCAL lock_timeout = \'5s\''); // never wait forever for the lock or a row
      await this.sql.query('SELECT pg_advisory_xact_lock(hashtext($1))', [PLATFORM_ADMIN_LOCK_KEY]);

      const existing = await this.sql.query('SELECT 1 FROM users WHERE role = $1 LIMIT 1', [SUPER_ADMIN_ROLE]);
      if (existing.rows.length > 0) {
        await this.sql.query('ROLLBACK');
        return { status: 'super-admin-exists' };
      }
      // case-insensitive: the login lowercases what it looks up, and the UNIQUE index alone would not catch an old 'Root@…' row
      const taken = await this.sql.query('SELECT 1 FROM users WHERE lower(email) = $1 LIMIT 1', [input.email]);
      if (taken.rows.length > 0) {
        await this.sql.query('ROLLBACK');
        return { status: 'email-exists' };
      }

      // business_id is left NULL on purpose: the account does not depend on any restaurant, active or not.
      insertingUser = true;
      const inserted = await this.sql.query(
        `INSERT INTO users (email, password_hash, role, business_id, active) VALUES ($1, $2, $3, NULL, true) RETURNING id`,
        [input.email, input.passwordHash, SUPER_ADMIN_ROLE],
      );
      insertingUser = false;
      const id = String(inserted.rows[0]!.id);

      // Same transaction. The version/flag values are the column defaults this INSERT just produced (0 / false).
      const auditId = await insertPlatformAudit(this.sql, {
        action: AUDIT_ACTION.bootstrapped,
        source: AUDIT_SOURCE.bootstrap,
        environment: auditEnvironment(input.environment),
        targetUserId: id,
        targetEmail: input.email,
        reason: null,
        operatorLabel: null,
        metadata: { version_after: 0, active_after: true, forced_change_after: false, operator_identity: 'none' },
      });
      await this.sql.query('COMMIT');
      return { status: 'created', id, auditId };
    } catch (error) {
      try {
        await this.sql.query('ROLLBACK');
      } catch {
        // the connection is gone; the server rolls the transaction back on its own
      }
      if (insertingUser && (error as { code?: unknown })?.code === POSTGRES_UNIQUE_VIOLATION) return { status: 'email-exists' };
      throw error;
    }
  }
}

// `1789679086923-AddUsers.js` -> `AddUsers1789679086923` (the name TypeORM records in the "migrations" table).
export function migrationNameFromFile(fileName: string): string | null {
  const match = /^(\d+)-(.+)\.(?:js|ts)$/.exec(fileName);
  if (!match || fileName.endsWith('.d.ts')) return null;
  return `${match[2]}${match[1]}`;
}
