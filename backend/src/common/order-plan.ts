import { BadRequestException, ConflictException } from '@nestjs/common';

export type OrderedRow = { id: string; sortOrder: number };
export type OrderPlan = {
  // positions (1..n, consecutive) to write; only the rows whose stored value differs from their new position
  updates: Array<{ id: string; position: number }>;
};
// What each kind of list answers when the request is refused (the error codes and messages are part of the API of each endpoint).
export type OrderRefusals = {
  conflict: { message: string; errorCode: string };
  invalid: { message: string; errorCode: string };
};

const sameSequence = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

// The pure decision of a "save the complete order of this list" endpoint (categories of a restaurant, products of a category), taken on the rows
// read UNDER the lock that protects that list (`current`: every live row, in the order the lists show: sort_order, created_at, id). No I/O: the
// service writes what this returns, or nothing.
//  1. expectedIds is not exactly the current sequence -> 409: the state the caller saw is gone (reordered, created, moved or deleted meanwhile).
//  2. orderedIds is not a permutation of the current ids (an unknown id, a foreign one, a missing one) -> 400. One answer for "unknown" and
//     "belongs to another restaurant / category", so the endpoint reveals nothing about other tenants.
//  3. Otherwise every row gets position index + 1 (consecutive, whatever the stored values were: repeated or with gaps). The starting point is
//     the EFFECTIVE order the lists already show, ties included, so nobody sees a change except the one that was asked for.
export function planOrder(
  current: readonly OrderedRow[],
  orderedIds: readonly string[],
  expectedIds: readonly string[],
  refusals: OrderRefusals,
): OrderPlan {
  const currentIds = current.map((row) => row.id);
  if (!sameSequence(expectedIds, currentIds)) throw new ConflictException(refusals.conflict);
  const known = new Set(currentIds);
  if (orderedIds.length !== currentIds.length || new Set(orderedIds).size !== orderedIds.length || !orderedIds.every((id) => known.has(id))) {
    throw new BadRequestException(refusals.invalid);
  }
  const byId = new Map(current.map((row) => [row.id, row.sortOrder]));
  const updates: OrderPlan['updates'] = [];
  orderedIds.forEach((id, index) => {
    if (byId.get(id) !== index + 1) updates.push({ id, position: index + 1 });
  });
  return { updates };
}
