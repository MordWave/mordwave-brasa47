import { SetMetadata } from '@nestjs/common';

export const AUDIT_METADATA_KEY = 'audit';

export interface AuditMetadata {
  action: string;
  entityType: string;
}

// Applied to a controller route whose action name is knowable purely from
// the route itself (create, or a single-purpose route like opening/closing
// a table session) — read by AuditInterceptor. A route whose action depends
// on the request body at runtime (e.g. deactivate-via-PATCH, an order's
// DELIVERED vs CANCELLED) is NOT a good fit for this — use an explicit
// AuditService.record() call in the controller instead (see
// product.controller.ts's update()/remove() for the pattern).
export const Audit = (action: string, entityType: string) =>
  SetMetadata<string, AuditMetadata>(AUDIT_METADATA_KEY, { action, entityType });
