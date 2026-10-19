import { ConflictException, HttpException } from '@nestjs/common';

// PostgreSQL's "another transaction got in the way" family, and nothing else:
//   40001 serialization_failure, 40P01 deadlock_detected, 55P03 lock_not_available (lock_timeout / NOWAIT).
// In each of them the database has already rolled the whole transaction back, so nothing was applied and nothing was audited;
// the caller may simply repeat the request. This is NOT retried here: an administrative write is repeated only by the person
// who sees the answer. Every other error (a failed audit insert, a constraint violation, a dropped connection...) is a real
// fault and keeps propagating unchanged — it must never be reported as a harmless conflict.
const CONCURRENCY_SQLSTATES: ReadonlySet<string> = new Set(['40001', '40P01', '55P03']);

export const ADMIN_CONCURRENT_MODIFICATION = 'ADMIN_CONCURRENT_MODIFICATION';

function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as { driverError?: { code?: unknown }; code?: unknown };
  const code = e.driverError?.code ?? e.code;
  return typeof code === 'string' ? code : undefined;
}

export function isConcurrencyConflict(error: unknown): boolean {
  if (error instanceof HttpException) return false;
  const code = sqlState(error);
  return code !== undefined && CONCURRENCY_SQLSTATES.has(code);
}

// Wraps the TRANSACTION of an administrative operation (never the work done before or after it, e.g. bcrypt).
export async function withAdminConcurrencyGuard<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isConcurrencyConflict(error)) {
      throw new ConflictException({
        message: 'Another request was changing this business\'s administrators at the same time; nothing was applied, review and retry',
        errorCode: ADMIN_CONCURRENT_MODIFICATION,
      });
    }
    throw error;
  }
}
