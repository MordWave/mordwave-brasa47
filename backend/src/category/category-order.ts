import { BadRequestException, ConflictException } from '@nestjs/common';

export const CATEGORY_ORDER_CONFLICT = 'CATEGORY_ORDER_CONFLICT';
export const CATEGORY_ORDER_INVALID = 'CATEGORY_ORDER_INVALID';

export type OrderedCategoryRow = { id: string; sortOrder: number };
export type ReorderPlan = {
  // positions (1..n, consecutive) to write; only the rows whose stored value differs from their new position
  updates: Array<{ id: string; position: number }>;
};

const sameSequence = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

// The pure decision of PUT /categories/order, taken on the rows read UNDER the restaurant lock (`current`: every non-deleted category of the
// restaurant in the order the lists show: sort_order, created_at, id). No I/O: the service writes what this returns, or nothing.
//  1. expectedIds is not exactly the current sequence -> 409: the state the caller saw is gone (reordered, created or deleted meanwhile).
//  2. orderedIds is not a permutation of the current ids (an unknown id, a foreign one, a missing one) -> 400. One answer for "unknown" and
//     "belongs to another restaurant", so the endpoint reveals nothing about other tenants.
//  3. Otherwise every category gets position index + 1 (consecutive, whatever the stored values were: repeated or with gaps).
export function planCategoryReorder(current: readonly OrderedCategoryRow[], orderedIds: readonly string[], expectedIds: readonly string[]): ReorderPlan {
  const currentIds = current.map((row) => row.id);
  if (!sameSequence(expectedIds, currentIds)) {
    throw new ConflictException({
      message: 'The categories changed since you loaded them. Reload the list and try again.',
      errorCode: CATEGORY_ORDER_CONFLICT,
    });
  }
  const known = new Set(currentIds);
  if (orderedIds.length !== currentIds.length || new Set(orderedIds).size !== orderedIds.length || !orderedIds.every((id) => known.has(id))) {
    throw new BadRequestException({
      message: 'orderedIds must list exactly the categories of the restaurant, each once',
      errorCode: CATEGORY_ORDER_INVALID,
    });
  }
  const byId = new Map(current.map((row) => [row.id, row.sortOrder]));
  const updates: ReorderPlan['updates'] = [];
  orderedIds.forEach((id, index) => {
    if (byId.get(id) !== index + 1) updates.push({ id, position: index + 1 });
  });
  return { updates };
}
