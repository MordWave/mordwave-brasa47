import { ForbiddenException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { Business } from './business.entity.js';

// A suspended business (Business.active = false). `Business.active` is NOT the same thing as `User.active`: the
// latter disables one account, the former suspends a whole restaurant. Machine-readable code the frontend maps to a
// message; 403 (not 401) so an authenticated session is never mistaken for an expired one and logged out in a loop.
export const BUSINESS_INACTIVE_ERROR_CODE = 'BUSINESS_INACTIVE';

export function businessInactiveError(): ForbiddenException {
  return new ForbiddenException({
    message: 'This business is suspended',
    errorCode: BUSINESS_INACTIVE_ERROR_CODE,
  });
}

// Reads Business.active under a row lock held until the surrounding transaction ends: FOR SHARE, so any number of
// orders/session-opens proceed together while a transition that rewrites the row (a future deactivation takes FOR
// UPDATE on it, as BusinessLimitsService.assertCanCreate already does) waits for them, or is waited for.
// A missing row counts as inactive (fails closed).
//
// KNOWN GAPS, for the phase that adds the suspend/reactivate transition (8D.2c-2b) — this file only enforces:
//   1. Suspending must close the business's open table sessions in the SAME transaction (it takes FOR UPDATE on
//      the Business row, then the sessions — never a table after a session).
//   2. An admin write that already passed the JWT guard when a suspension begins is not re-checked afterwards; those
//      write paths need reviewing so nothing lands after the transition.
//   3. PublicBusinessResolverService.invalidate(businessId) must be called after that transaction COMMITS.
//   4. Real concurrency between orders and a suspension has not been validated against a standalone PostgreSQL
//      (the e2e harness, PGlite, is a single session); only the lock order and the read-under-lock are tested.
//
// LOCK ORDER (every path that locks more than one of these rows): Business -> RestaurantTable -> TableSession.
// Never take a Business lock while already holding a table or session lock.
export async function lockBusinessIsActive(manager: EntityManager, businessId: string): Promise<boolean> {
  const business = await manager.getRepository(Business).findOne({
    select: { id: true, active: true },
    where: { id: businessId },
    lock: { mode: 'pessimistic_read' },
  });
  return business?.active === true;
}
