// Classifies low-level errors from the Postgres driver / pool / body parser.
// Pure functions over plain properties (no driver imports), so they work the
// same for QueryFailedError (TypeORM wraps the pg error in `driverError`),
// raw pg-pool errors and body-parser's http-errors.

export type InfrastructureErrorKind = 'timeout' | 'unavailable' | 'payload-too-large' | 'unsupported-content-encoding';

// SQLSTATE
const TIMEOUT_SQLSTATES = new Set([
  '57014', // query_canceled — statement_timeout fired
]);
const UNAVAILABLE_SQLSTATES = new Set([
  '53300', // too_many_connections
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
]);
// Node socket errors while talking to the database.
const UNAVAILABLE_SOCKET_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);

// pg / pg-pool raise these as plain Errors with no code.
const TIMEOUT_MESSAGES = ['Query read timeout'];
const UNAVAILABLE_MESSAGES = [
  'timeout exceeded when trying to connect', // pool exhausted > connectionTimeoutMillis
  'Connection terminated due to connection timeout',
  'Connection terminated unexpectedly',
  'Connection terminated',
  'Client has encountered a connection error and is not queryable',
];

interface ErrorLike {
  code?: unknown;
  type?: unknown;
  status?: unknown;
  statusCode?: unknown;
  message?: unknown;
  driverError?: unknown;
  cause?: unknown;
}

function chain(error: unknown): ErrorLike[] {
  const seen: ErrorLike[] = [];
  let current: unknown = error;
  while (current && typeof current === 'object' && seen.length < 4 && !seen.includes(current)) {
    seen.push(current as ErrorLike);
    const next = (current as ErrorLike).driverError ?? (current as ErrorLike).cause;
    current = next;
  }
  return seen;
}

export function classifyInfrastructureError(error: unknown): InfrastructureErrorKind | null {
  const head = error as ErrorLike | null | undefined;
  // body-parser (http-errors): { type: 'entity.too.large', status: 413 }. Looked up along `cause` too, because
  // @nestjs/platform-express >= 12.3 wraps the http-errors in an HttpException that keeps the original as its `cause`.
  // Only the body-parser `type` is matched down the chain: a bare 413 from anywhere else (a Multer file-size rejection,
  // say) keeps its own response.
  if (head && typeof head === 'object' && head.statusCode === 413 && head.status === 413) {
    return 'payload-too-large';
  }
  if (chain(error).some((item) => item.type === 'entity.too.large')) {
    return 'payload-too-large';
  }
  // body-parser (http-errors) with `inflate: false`, for a body that carries a Content-Encoding:
  // { type: 'encoding.unsupported', status: 415 }, found the same way.
  if (chain(error).some((item) => item.type === 'encoding.unsupported')) {
    return 'unsupported-content-encoding';
  }

  for (const item of chain(error)) {
    const code = typeof item.code === 'string' ? item.code : undefined;
    const message = typeof item.message === 'string' ? item.message : '';
    if (code && TIMEOUT_SQLSTATES.has(code)) return 'timeout';
    if (TIMEOUT_MESSAGES.some((m) => message === m)) return 'timeout';
  }
  for (const item of chain(error)) {
    const code = typeof item.code === 'string' ? item.code : undefined;
    const message = typeof item.message === 'string' ? item.message : '';
    if (code && (UNAVAILABLE_SQLSTATES.has(code) || UNAVAILABLE_SOCKET_CODES.has(code))) {
      return 'unavailable';
    }
    // SQLSTATE class 08 — connection exception.
    if (code && /^08[0-9A-Z]{3}$/.test(code)) return 'unavailable';
    if (UNAVAILABLE_MESSAGES.some((m) => message === m)) return 'unavailable';
  }
  return null;
}
