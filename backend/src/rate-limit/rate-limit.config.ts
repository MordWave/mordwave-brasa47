// Single source of truth for every rate-limit number in the app. Plain
// constants (not env vars) on purpose: these are product/security decisions
// reviewed in code, and a typo'd env var must not silently disable a limit.
// Tests swap the whole object through the RATE_LIMIT_CONFIG provider.

export const RATE_LIMIT_CONFIG = Symbol('RATE_LIMIT_CONFIG');
export const RATE_LIMIT_STORAGE = Symbol('RATE_LIMIT_STORAGE');

export const RATE_LIMITED_ERROR_CODE = 'RATE_LIMITED';
export const RATE_LIMITED_MESSAGE = 'Too many requests';

export interface RateLimitBucket {
  limit: number;
  ttlMs: number;
}

// Which counters a route opts into, on top of the global ones:
//   ip      per client IP (resolveClientIp) — evaluated before auth
//   session per body.sessionToken (IP fallback) — evaluated before auth
//   user    per authenticated user id — evaluated AFTER JwtAuthGuard
export interface RateLimitPolicy {
  ip?: RateLimitBucket;
  session?: RateLimitBucket;
  user?: RateLimitBucket;
  // The route has its own IP bucket that is deliberately HIGHER than the
  // global per-IP ceiling (a venue's many phones share one IP), so it must
  // not also count toward — and be capped by — that global ceiling.
  skipGlobalIp?: boolean;
}

export type RateLimitPolicyName =
  | 'publicMenu'
  | 'login'
  | 'changePassword'
  | 'adminProvisioning'
  | 'adminStatus'
  | 'upload'
  | 'ordersCreate'
  | 'tableJoin'
  | 'tableStatus'
  | 'media';

export interface RateLimitConfig {
  // Every route, per IP — general anti-abuse ceiling.
  globalIp: RateLimitBucket;
  // Every authenticated route, per user id (a second admin on the same
  // Wi-Fi gets their own bucket).
  authenticatedUser: RateLimitBucket;
  policies: Record<RateLimitPolicyName, RateLimitPolicy>;
}

const MINUTE_MS = 60_000;
const perMinute = (limit: number): RateLimitBucket => ({ limit, ttlMs: MINUTE_MS });

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  globalIp: perMinute(300),
  authenticatedUser: perMinute(300),
  policies: {
    // GET /products, GET /products/:id, GET /categories — each route has its
    // own counter.
    publicMenu: { ip: perMinute(120) },
    // POST /auth/login
    login: { ip: perMinute(5) },
    // POST /auth/change-password — it verifies the CURRENT password, so with a stolen session it is a guessing
    // oracle: a per-user cap (after auth) plus a per-IP cap (before auth). Both count every attempt, failed ones too,
    // because the buckets are charged before the handler runs. The global ceilings still apply on top.
    changePassword: { ip: perMinute(10), user: perMinute(5) },
    // POST /businesses/:id/admins and .../reset-password (SUPER_ADMIN) — they mint credentials, so they get their own
    // tight caps on top of the global ones: per IP before auth, per user after it. Every attempt counts.
    adminProvisioning: { ip: perMinute(20), user: perMinute(10) },
    // POST /businesses/:id/admins/:userId/activate|deactivate (SUPER_ADMIN)
    adminStatus: { user: perMinute(30) },
    // POST /products/:id/image, POST /businesses/me/logo
    upload: { user: perMinute(30) },
    // POST /orders — the session bucket is shared by every device at the
    // table (they all hold the same sessionToken); the IP bucket covers a
    // whole venue behind one Wi-Fi.
    ordersCreate: { session: perMinute(10), ip: perMinute(120) },
    // POST /table-sessions/join
    tableJoin: { ip: perMinute(120) },
    // POST /table-sessions/status — every device polls ~5×/min and all the
    // devices at a table share one sessionToken, so 60 leaves room for
    // several devices plus bursts/retries.
    tableStatus: { session: perMinute(60), ip: perMinute(600), skipGlobalIp: true },
    // GET/HEAD /media/<key> — one 302 per image. A 50-product menu opened on
    // several phones behind one venue Wi-Fi legitimately produces hundreds of
    // redirects, so it must not eat the global 300/min/IP ceiling; it still
    // has its own (higher) per-IP cap, so it is never unlimited.
    media: { ip: perMinute(1200), skipGlobalIp: true },
  },
};
