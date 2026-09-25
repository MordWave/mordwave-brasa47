import type { Request } from 'express';

export interface ClientInfo {
  ipAddress: string | null;
  userAgent: string | null;
}

// Shared by every controller that calls AuditService.record() explicitly,
// and by AuditInterceptor for the decorator-driven path — both read
// ip/userAgent the same way. req.ip already respects Express's `trust
// proxy` setting (see config/security.config.ts / main.ts), so this never
// reads X-Forwarded-For directly itself.
export function extractClientInfo(req: Request): ClientInfo {
  const userAgent = req.headers['user-agent'];
  return {
    ipAddress: req.ip ?? null,
    userAgent: typeof userAgent === 'string' ? userAgent : null,
  };
}
