import type { Request } from 'express';
import { resolveClientIp } from '../common/client-ip/client-ip.js';

export interface ClientInfo {
  ipAddress: string | null;
  userAgent: string | null;
}

// Shared by every controller that calls AuditService.record() explicitly,
// and by AuditInterceptor for the decorator-driven path — both read
// ip/userAgent the same way. The address comes from resolveClientIp (the one
// place that decides CLIENT_IP_HEADER vs req.ip / `trust proxy`), so audit
// and rate limiting can never resolve the client differently.
export function extractClientInfo(req: Request): ClientInfo {
  const userAgent = req.headers['user-agent'];
  return {
    ipAddress: resolveClientIp(req),
    userAgent: typeof userAgent === 'string' ? userAgent : null,
  };
}
