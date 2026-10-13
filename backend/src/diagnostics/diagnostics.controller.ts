import { Controller, Get, Inject, Req, UseGuards } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Request } from 'express';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { resolveClientIp } from '../common/client-ip/client-ip.js';
import securityConfig from '../config/security.config.js';
import { UserRole } from '../user/user-role.enum.js';
import { DiagnosticsEnabledGuard } from './diagnostics-enabled.guard.js';

export interface ClientIpDiagnostics {
  resolvedIp: string | null;
  reqIp: string | null;
  reqIps: string[];
  socketIp: string | null;
  xRealIp: string | null;
  xForwardedFor: string | null;
  forwarded: string | null;
  // Effective settings, so one response is enough to interpret the rest.
  config: { clientIpHeader: string | null; trustProxy: boolean | number };
}

function headerValue(req: Request, name: string): string | null {
  const value = req.headers[name];
  return typeof value === 'string' ? value : null;
}

// TEMPORARY — exists only to verify, against the real platform (Railway
// today), which header/hop carries the true client address before any
// IP-based rate limiting is switched on. Remove once that's settled.
// Off by default (ENABLE_IP_DIAGNOSTICS); returns request metadata only,
// never environment values, tokens or secrets.
@Controller('diagnostics')
export class DiagnosticsController {
  constructor(
    @Inject(securityConfig.KEY)
    private readonly security: ConfigType<typeof securityConfig>,
  ) {}

  @Get('client-ip')
  @UseGuards(DiagnosticsEnabledGuard, JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  clientIp(@Req() req: Request): ClientIpDiagnostics {
    return {
      resolvedIp: resolveClientIp(req),
      reqIp: req.ip ?? null,
      reqIps: req.ips ?? [],
      socketIp: req.socket?.remoteAddress ?? null,
      xRealIp: headerValue(req, 'x-real-ip'),
      xForwardedFor: headerValue(req, 'x-forwarded-for'),
      forwarded: headerValue(req, 'forwarded'),
      config: {
        clientIpHeader: this.security.clientIpHeader,
        // What Express actually applies (set in main.ts), not just the env.
        trustProxy: req.app.get('trust proxy') as boolean | number,
      },
    };
  }
}
