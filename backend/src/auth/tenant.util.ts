import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '../user/user-role.enum.js';
import type { SafeUser } from './safe-user.js';

// Create: an ADMIN's own businessId always wins over whatever the client
// sent — the body is never trusted for tenant scoping. A SUPER_ADMIN may
// target any business, but must specify one explicitly.
export function resolveBusinessIdForCreate(
  user: SafeUser,
  requestedBusinessId: string,
): string {
  if (user.role === UserRole.SUPER_ADMIN) {
    return requestedBusinessId;
  }
  if (!user.businessId) {
    throw new ForbiddenException('User is not assigned to a business');
  }
  return user.businessId;
}

// Update: an ADMIN can only ever touch a record that already belongs to
// their own business — the requested businessId is ignored entirely, and a
// mismatch is rejected outright rather than silently corrected. A
// SUPER_ADMIN may move a record to a different business by sending a new
// businessId, or keep the current one by omitting it.
export function resolveBusinessIdForUpdate(
  user: SafeUser,
  currentBusinessId: string,
  requestedBusinessId: string | undefined,
): string {
  if (user.role === UserRole.SUPER_ADMIN) {
    return requestedBusinessId ?? currentBusinessId;
  }
  if (!user.businessId) {
    throw new ForbiddenException('User is not assigned to a business');
  }
  if (user.businessId !== currentBusinessId) {
    throw new ForbiddenException('This record does not belong to your business');
  }
  return user.businessId;
}

// Admin read (list): an ADMIN always sees only their own business — any
// businessId in the query is ignored. A SUPER_ADMIN sees whichever business
// they asked for, or every business (no filter) if they didn't specify one
// — unlike create/update, an unscoped admin listing is a legitimate
// cross-tenant view for this role.
export function resolveBusinessIdForRead(
  user: SafeUser,
  requestedBusinessId: string | undefined,
): string | undefined {
  if (user.role === UserRole.SUPER_ADMIN) {
    return requestedBusinessId;
  }
  if (!user.businessId) {
    throw new ForbiddenException('User is not assigned to a business');
  }
  return user.businessId;
}
