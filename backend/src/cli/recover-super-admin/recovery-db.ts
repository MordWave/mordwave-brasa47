import { BootstrapDb, type SchemaReport, type SqlExecutor } from '../bootstrap-super-admin/bootstrap-db.js';
import { SUPER_ADMIN_ROLE } from '../bootstrap-super-admin/constants.js';
import {
  AUDIT_ACTION,
  AUDIT_SOURCE,
  auditEnvironment,
  insertPlatformAudit,
  PLATFORM_ADMIN_LOCK_KEY,
  type AuditAction,
  type AuditMetadata,
  type OperatorIdentity,
} from '../shared/platform-audit.js';

// Everything the recovery tool does to the database, over a minimal SQL executor (a `pg` Client in production, the same
// client in the PGlite integration test). Plain SQL with bound parameters: no ORM, so an error can never drag a statement's
// parameters (the password hash) into a message. It never SELECTs password_hash.

export type RecoveryOperation = 'reset-password' | 'reactivate' | 'revoke-sessions';

// What the operator saw and confirmed. The write is allowed only if the row STILL looks exactly like this.
export interface TargetSnapshot {
  id: string;
  email: string;
  active: boolean;
  credentialsVersion: number;
  mustChangePassword: boolean;
  createdAt: Date | null;
}

export type TargetLookup =
  | { status: 'found'; target: TargetSnapshot }
  // Deliberately one answer for "no such e-mail" and "that e-mail belongs to someone who is not a SUPER_ADMIN": the tool
  // must not tell whether an ADMIN account exists. (Only SUPER_ADMIN rows are ever read.)
  | { status: 'not-found' }
  | { status: 'ambiguous' };

export interface AuditTrailEntry {
  action: string;
  source: string;
  createdAt: Date | null;
}

export interface ApplyInput {
  operation: RecoveryOperation;
  expected: TargetSnapshot;
  passwordHash: string | null; // only for reset-password; a bound parameter, never part of the SQL text
  environment: string;
  reason: string;
  operatorLabel: string | null;
}

export type ApplyOutcome =
  | { status: 'applied'; versionBefore: number; versionAfter: number; auditId: string }
  | { status: 'target-gone' }
  | { status: 'state-changed' }
  | { status: 'already-active' };

// COMMIT was sent and its answer never arrived (or failed): the transaction may or may not have been committed.
export class CommitUncertainError extends Error {
  constructor(readonly cause: unknown) {
    super('commit-uncertain');
  }
}

const ACTION: Record<RecoveryOperation, AuditAction> = {
  'reset-password': AUDIT_ACTION.passwordReset,
  reactivate: AUDIT_ACTION.reactivated,
  'revoke-sessions': AUDIT_ACTION.sessionsRevoked,
};

const asDate = (value: unknown): Date | null => (value instanceof Date ? value : null);
const snapshotOf = (row: Record<string, unknown>): TargetSnapshot => ({
  id: String(row.id),
  email: String(row.email),
  active: row.active === true,
  credentialsVersion: Number(row.credentials_version),
  mustChangePassword: row.must_change_password === true,
  createdAt: asDate(row.created_at),
});

const sameState = (a: TargetSnapshot, b: TargetSnapshot): boolean =>
  a.id === b.id && a.email === b.email && a.active === b.active && a.credentialsVersion === b.credentialsVersion && a.mustChangePassword === b.mustChangePassword;

export class RecoveryDb {
  private readonly base: BootstrapDb;

  constructor(private readonly sql: SqlExecutor) {
    this.base = new BootstrapDb(sql);
  }

  // PostgreSQL itself declares the transaction READ ONLY: any write attempted inside fails. Always rolled back.
  readOnly<T>(work: () => Promise<T>): Promise<T> {
    return this.base.readOnly(work);
  }

  ping(): Promise<void> {
    return this.base.ping();
  }

  // The same schema/migration inspection as the bootstrap (it includes platform_audit_logs and the credentials columns).
  inspectSchema(expectedMigrations: readonly string[]): Promise<SchemaReport> {
    return this.base.inspectSchema(expectedMigrations);
  }

  // Read-only. Looks up ONLY SUPER_ADMIN rows, by exact (case-insensitive) e-mail, and never lists anything.
  async findTarget(email: string): Promise<TargetLookup> {
    const result = await this.sql.query(
      `SELECT id, email, active, credentials_version, must_change_password, created_at
         FROM users WHERE role = $1 AND lower(email) = $2 LIMIT 2`,
      [SUPER_ADMIN_ROLE, email],
    );
    if (result.rows.length === 0) return { status: 'not-found' };
    if (result.rows.length > 1) return { status: 'ambiguous' };
    return { status: 'found', target: snapshotOf(result.rows[0]!) };
  }

  // Read-only. The latest audit entries about one account: action, channel and time only (no reason, no label).
  async recentAudit(targetUserId: string, limit = 5): Promise<AuditTrailEntry[]> {
    const result = await this.sql.query(
      `SELECT action, source, created_at FROM platform_audit_logs WHERE target_user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
      [targetUserId, limit],
    );
    return result.rows.map((r) => ({ action: String(r.action), source: String(r.source), createdAt: asDate(r.created_at) }));
  }

  // The ONLY write path. ONE transaction:
  //   BEGIN -> bounded lock wait -> platform advisory lock (shared with the bootstrap) -> re-read and LOCK the row
  //   -> compare it with what the operator confirmed -> UPDATE (compare-and-set on credentials_version) -> INSERT exactly one
  //   audit event -> COMMIT.
  // Anything that fails before COMMIT — the audit insert included — rolls everything back. A failure AT COMMIT is never
  // retried here: it surfaces as CommitUncertainError and the operator verifies with a read-only check.
  async apply(input: ApplyInput): Promise<ApplyOutcome> {
    if ((input.operation === 'reset-password') !== (input.passwordHash !== null)) {
      throw new Error('reset-password needs a password hash and the other operations must not carry one');
    }
    await this.sql.query('BEGIN');
    let committing = false;
    try {
      await this.sql.query(`SET LOCAL lock_timeout = '5s'`);
      await this.sql.query('SELECT pg_advisory_xact_lock(hashtext($1))', [PLATFORM_ADMIN_LOCK_KEY]);

      const current = await this.sql.query(
        `SELECT id, email, active, credentials_version, must_change_password, created_at FROM users WHERE id = $1 AND role = $2 FOR UPDATE`,
        [input.expected.id, SUPER_ADMIN_ROLE],
      );
      if (current.rows.length === 0) return await this.refuse('target-gone');
      const now = snapshotOf(current.rows[0]!);
      if (!sameState(now, input.expected)) return await this.refuse('state-changed');
      if (input.operation === 'reactivate' && now.active) return await this.refuse('already-active');

      // Only this operation's columns. credentials_version is the compare-and-set: the WHERE repeats the version we read.
      const set =
        input.operation === 'reset-password'
          ? 'password_hash = $4, must_change_password = true'
          : input.operation === 'reactivate'
            ? 'active = true'
            : null;
      const params: unknown[] = [now.id, now.credentialsVersion, SUPER_ADMIN_ROLE];
      if (input.operation === 'reset-password') params.push(input.passwordHash);
      const updated = await this.sql.query(
        `UPDATE users SET ${set ? `${set}, ` : ''}credentials_version = credentials_version + 1, updated_at = now()
          WHERE id = $1 AND credentials_version = $2 AND role = $3
          RETURNING active, credentials_version, must_change_password`,
        params,
      );
      if (updated.rows.length !== 1) return await this.refuse('state-changed');
      const after = updated.rows[0]!;

      const identity: OperatorIdentity = input.operatorLabel === null ? 'none' : 'declared-unverified';
      const metadata: AuditMetadata = {
        version_before: now.credentialsVersion,
        version_after: Number(after.credentials_version),
        active_before: now.active,
        active_after: after.active === true,
        forced_change_before: now.mustChangePassword,
        forced_change_after: after.must_change_password === true,
        operator_identity: identity,
      };
      const auditId = await insertPlatformAudit(this.sql, {
        action: ACTION[input.operation],
        source: AUDIT_SOURCE.recovery,
        environment: auditEnvironment(input.environment),
        targetUserId: now.id,
        targetEmail: now.email,
        reason: input.reason,
        operatorLabel: input.operatorLabel,
        metadata,
      });

      committing = true;
      await this.sql.query('COMMIT');
      return { status: 'applied', versionBefore: now.credentialsVersion, versionAfter: Number(after.credentials_version), auditId };
    } catch (error) {
      try {
        await this.sql.query('ROLLBACK');
      } catch {
        // the connection is gone; the server rolls an unfinished transaction back on its own
      }
      if (committing) throw new CommitUncertainError(error);
      throw error;
    }
  }

  private async refuse<T extends 'target-gone' | 'state-changed' | 'already-active'>(status: T): Promise<{ status: T }> {
    await this.sql.query('ROLLBACK');
    return { status };
  }
}
