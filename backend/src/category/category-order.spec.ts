import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { CATEGORY_ORDER_CONFLICT, CATEGORY_ORDER_INVALID, planCategoryReorder } from './category-order.js';

const rows = (...values: number[]) => values.map((sortOrder, i) => ({ id: `c${i + 1}`, sortOrder }));
const ids = (n: number) => Array.from({ length: n }, (_, i) => `c${i + 1}`);
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return { type: (e as Error).constructor, code: ((e as { getResponse?: () => { errorCode?: string } }).getResponse?.() ?? {}).errorCode };
  }
  return null;
};

describe('planCategoryReorder (the pure decision of PUT /categories/order)', () => {
  it('moves one category up: consecutive positions for the rows that change, nothing for the rest', () => {
    const plan = planCategoryReorder(rows(1, 2, 3, 4), ['c1', 'c3', 'c2', 'c4'], ids(4));
    expect(plan.updates).toEqual([
      { id: 'c3', position: 2 },
      { id: 'c2', position: 3 },
    ]);
  });

  it('normalises repeated initial values (all 0, as the old form created them) to 1..n', () => {
    const plan = planCategoryReorder(rows(0, 0, 0, 0), ['c1', 'c2', 'c4', 'c3'], ids(4));
    expect(plan.updates.map((u) => u.position)).toEqual([1, 2, 3, 4]);
    expect(plan.updates.map((u) => u.id)).toEqual(['c1', 'c2', 'c4', 'c3']);
  });

  it('normalises values with gaps (10, 20, 35) and negative or huge ones', () => {
    expect(planCategoryReorder(rows(10, 20, 35), ids(3), ids(3)).updates).toEqual([
      { id: 'c1', position: 1 },
      { id: 'c2', position: 2 },
      { id: 'c3', position: 3 },
    ]);
    expect(planCategoryReorder(rows(-5, 2_000_000_000, 7), ['c3', 'c1', 'c2'], ids(3)).updates.map((u) => u.position)).toEqual([1, 2, 3]);
  });

  it('writes nothing when the order and the values are already what was asked', () => {
    expect(planCategoryReorder(rows(1, 2, 3), ids(3), ids(3)).updates).toEqual([]);
  });

  it('409 CATEGORY_ORDER_CONFLICT when the sequence the caller saw is not the current one (reordered, created or deleted meanwhile)', () => {
    const current = rows(1, 2, 3);
    for (const expected of [['c2', 'c1', 'c3'], ['c1', 'c2'], ['c1', 'c2', 'c3', 'c4'], []]) {
      expect(codeOf(() => planCategoryReorder(current, ids(3), expected))).toEqual({ type: ConflictException, code: CATEGORY_ORDER_CONFLICT });
    }
  });

  it('400 CATEGORY_ORDER_INVALID when orderedIds is not a permutation of the restaurant ids: unknown, foreign, missing, repeated or extra', () => {
    const current = rows(1, 2, 3);
    for (const ordered of [['c1', 'c2', 'zzz'], ['c1', 'c2'], ['c1', 'c2', 'c3', 'c4'], ['c1', 'c1', 'c2'], []]) {
      expect(codeOf(() => planCategoryReorder(current, ordered, ids(3)))).toEqual({ type: BadRequestException, code: CATEGORY_ORDER_INVALID });
    }
  });

  it('the conflict is judged first: a stale expectation never reveals whether the ids were valid', () => {
    expect(codeOf(() => planCategoryReorder(rows(1, 2), ['x', 'y'], ['c2', 'c1'])).code).toBe(CATEGORY_ORDER_CONFLICT)
  });

  it('a single category has nothing to move: writes nothing when already 1, one write otherwise', () => {
    expect(planCategoryReorder(rows(1), ['c1'], ['c1']).updates).toEqual([]);
    expect(planCategoryReorder(rows(0), ['c1'], ['c1']).updates).toEqual([{ id: 'c1', position: 1 }]);
  });
});
