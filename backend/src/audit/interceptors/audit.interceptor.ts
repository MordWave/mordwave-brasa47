import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { type Observable, tap } from 'rxjs';
import type { SafeUser } from '../../auth/safe-user.js';
import { AuditService } from '../audit.service.js';
import { AUDIT_METADATA_KEY, type AuditMetadata } from '../decorators/audit.decorator.js';
import { extractClientInfo } from '../request-client-info.util.js';

// Global (registered via APP_INTERCEPTOR in AuditModule) but a no-op for
// any route without @Audit(...) — a cheap Reflector.get() check, so routes
// that don't opt in pay effectively nothing. Only fires on success (tap()
// skips on a thrown exception) — auditing a *denied* attempt is a
// deliberately separate, not-yet-built concern (see Fase 8A.1 design notes).
// Delivery itself is best-effort/fire-and-forget — see the KNOWN LIMITATION
// note on AuditService.record().
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly auditService: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.get<AuditMetadata | undefined>(AUDIT_METADATA_KEY, context.getHandler());
    if (!meta) return next.handle();

    const request = context.switchToHttp().getRequest<Request>();
    const user = (request as Request & { user?: SafeUser }).user;

    return next.handle().pipe(
      tap((response: unknown) => {
        if (!user) return; // shouldn't happen behind JwtAuthGuard — defensive only

        const responseRecord = (response ?? {}) as Record<string, unknown>;
        // Prefer the resulting entity's own businessId (authoritative for
        // what was actually just created/changed) over the caller's own —
        // matters for a SUPER_ADMIN acting on a specific business.
        const businessId = (responseRecord.businessId as string | undefined) ?? user.businessId;
        if (!businessId) return; // nothing to scope this entry to

        const entityId =
          (responseRecord.id as string | undefined) ??
          (request.params?.id as string | undefined) ??
          null;

        void this.auditService.record({
          businessId,
          userId: user.id,
          userEmail: user.email,
          action: meta.action,
          entityType: meta.entityType,
          entityId,
          metadata: request.body,
          ...extractClientInfo(request),
        });
      }),
    );
  }
}
