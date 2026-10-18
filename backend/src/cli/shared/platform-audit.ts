import type { SqlExecutor } from '../bootstrap-super-admin/bootstrap-db.js';

// The ONLY place the CLIs write to platform_audit_logs (8D.2d-6b). Both tools call `insertPlatformAudit` INSIDE the
// transaction of the change they record, so if this insert fails the caller rolls the whole operation back.
//
// What the database enforces (migration AddPlatformAuditLogs): append-only, the shape of `action` and `source`, and that no
// KEY of `metadata` is named like a secret. It does NOT inspect values or the free-text columns. That protection is this
// file's job: the record is built from a CLOSED list of fields, each with a type check, and the two free-text fields
// (`reason`, `operator_label`) are validated by `validateFreeText` before they ever reach the SQL.

// One advisory lock for every platform-level SUPER_ADMIN operation: the bootstrap and every recovery operation take it
// (transaction-scoped), so they serialise against each other. Keyed by this text through hashtext().
export const PLATFORM_ADMIN_LOCK_KEY = 'mordwave:platform-super-admin';

export const AUDIT_SOURCE = { bootstrap: 'bootstrap-cli', recovery: 'recovery-cli' } as const;
export const AUDIT_ACTION = {
  bootstrapped: 'SUPER_ADMIN_BOOTSTRAPPED',
  passwordReset: 'SUPER_ADMIN_PASSWORD_RESET',
  reactivated: 'SUPER_ADMIN_REACTIVATED',
  sessionsRevoked: 'SUPER_ADMIN_SESSIONS_REVOKED',
} as const;
export type AuditAction = (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION];
export type AuditSource = (typeof AUDIT_SOURCE)[keyof typeof AUDIT_SOURCE];

// The operator's name is typed by hand: it identifies nobody. The record says so explicitly.
export type OperatorIdentity = 'declared-unverified' | 'none';

// The closed list of metadata fields. A key that is not here cannot be recorded (a programming error, thrown), and every
// value is checked against its type. Names avoid the words the table's CHECK refuses (password, hash, token, ...).
const METADATA_FIELDS = {
  version_before: 'count',
  version_after: 'count',
  active_before: 'boolean',
  active_after: 'boolean',
  forced_change_before: 'boolean',
  forced_change_after: 'boolean',
  operator_identity: 'identity',
} as const;
export const AUDIT_METADATA_KEYS = Object.keys(METADATA_FIELDS);
export type AuditMetadata = Partial<{
  version_before: number;
  version_after: number;
  active_before: boolean;
  active_after: boolean;
  forced_change_before: boolean;
  forced_change_after: boolean;
  operator_identity: OperatorIdentity;
}>;

export interface PlatformAuditEvent {
  action: AuditAction;
  source: AuditSource;
  environment: string | null;
  targetUserId: string;
  targetEmail: string;
  reason: string | null;
  operatorLabel: string | null;
  metadata: AuditMetadata;
}

export const REASON_MIN = 10;
export const REASON_MAX = 300;
export const OPERATOR_LABEL_MAX = 120;

// `environment` comes from an environment variable: only a plain, short name is recorded.
export function auditEnvironment(raw: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._ -]{0,59}$/.test(raw) ? raw : 'desconocido';
}

// Text that looks like it carries a secret is refused (not scrubbed: "partially hidden" is still a leak, and the operator
// should retype the sentence). Heuristic by nature — it catches the usual accidents, not a determined person.
const SECRET_LIKE: Array<[RegExp, string]> = [
  [/\$2[abxy]\$\d{2}\$/, 'un hash bcrypt'],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\./, 'un JWT'],
  [/-----BEGIN [A-Z ]*(PRIVATE KEY|PGP)/i, 'una clave privada'],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]*:[^\s/@]+@/i, 'una URL con credenciales'],
  [/(password|passwd|contrase(ñ|n)a|clave|passphrase|secret|secreto|token|api[-_ ]?key)\s*[:=]/i, 'una asignación de credencial'],
  [/[A-Za-z0-9+/_=-]{32,}/, 'una cadena larga sin espacios (¿una clave o un token?)'],
];

export function validateFreeText(raw: string, options: { min: number; max: number; label: string }): { ok: true; value: string } | { ok: false; problem: string } {
  const value = raw.trim().replace(/\s+/g, ' ');
  const length = Array.from(value).length;
  if (length < options.min) return { ok: false, problem: `${options.label}: escribe al menos ${options.min} caracteres.` };
  if (length > options.max) return { ok: false, problem: `${options.label}: máximo ${options.max} caracteres.` };
  if (/\p{C}/u.test(value)) return { ok: false, problem: `${options.label}: no puede contener caracteres de control.` };
  for (const [pattern, what] of SECRET_LIKE) {
    if (pattern.test(value)) return { ok: false, problem: `${options.label}: parece contener ${what}. Nunca escribas secretos aquí; reformula el texto.` };
  }
  return { ok: true, value };
}

// Whitelists and type-checks the metadata. Returns a fresh object; nothing from the input is passed through untouched.
export function buildAuditMetadata(input: Record<string, unknown>): Record<string, number | boolean | string> {
  const out: Record<string, number | boolean | string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    const kind = (METADATA_FIELDS as Record<string, string>)[key];
    const valid =
      (kind === 'count' && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
      (kind === 'boolean' && typeof value === 'boolean') ||
      (kind === 'identity' && (value === 'declared-unverified' || value === 'none'));
    if (!valid) throw new Error(`Campo de auditoría no permitido: ${kind === undefined ? 'clave desconocida' : `valor inválido para ${key}`}`);
    out[key] = value as number | boolean | string;
  }
  return out;
}

// Inserts EXACTLY ONE event, in the caller's transaction, and returns its id. `actor_user_id` is the literal NULL: these
// tools have no authenticated application user (the operator label is a declaration, not an identity). Any failure
// (including a database constraint) propagates so the caller rolls everything back.
export async function insertPlatformAudit(sql: SqlExecutor, event: PlatformAuditEvent): Promise<string> {
  const metadata = buildAuditMetadata({ ...event.metadata });
  const result = await sql.query(
    `INSERT INTO platform_audit_logs (action, source, environment, target_user_id, target_email, actor_user_id, operator_label, reason, metadata)
     VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8::jsonb) RETURNING id`,
    [event.action, event.source, event.environment, event.targetUserId, event.targetEmail, event.operatorLabel, event.reason, JSON.stringify(metadata)],
  );
  if (result.rows.length !== 1) throw new Error('El evento de auditoría no se registró.');
  return String(result.rows[0]!.id);
}
