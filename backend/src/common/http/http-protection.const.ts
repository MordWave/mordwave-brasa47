// Static product/protocol rules for the HTTP layer — the same in every
// environment (contrast with config/database-operational.config.ts, which is
// per-environment). Changing any of these is a code review, not a deploy flag.

// express.json limit. Every JSON body in the app is a few KB; 200 KB leaves
// generous room for a product with many add-ons. Does not apply to
// multipart/form-data (image uploads), which Multer handles under its own
// size limits (common/limits/resource-limits.const.ts).
export const JSON_BODY_LIMIT = '200kb';

// Logical per-request deadlines (see RequestTimeoutInterceptor).
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const UPLOAD_REQUEST_TIMEOUT_MS = 90_000;

// Node http.Server timeouts. Tied to the idle timeout of whatever sits in
// front of the app (Railway's edge today, an AWS ALB later — both 60s):
// keepAliveTimeout must be LONGER than the proxy's idle timeout, otherwise
// the proxy can reuse a connection Node has just closed (sporadic 502s), and
// headersTimeout must be longer than keepAliveTimeout.
export const HTTP_KEEP_ALIVE_TIMEOUT_MS = 65_000;
export const HTTP_HEADERS_TIMEOUT_MS = 66_000;
// Hard cap for receiving an entire request (headers + body), including
// uploads over a slow mobile connection. Above the 90s upload deadline.
export const HTTP_REQUEST_TIMEOUT_MS = 120_000;

export const ERROR_CODES = {
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  REQUEST_TIMEOUT: 'REQUEST_TIMEOUT',
  TEMPORARILY_UNAVAILABLE: 'TEMPORARILY_UNAVAILABLE',
} as const;
