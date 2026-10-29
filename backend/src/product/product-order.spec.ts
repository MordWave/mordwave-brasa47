import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { PRODUCT_ORDER_CONFLICT, PRODUCT_ORDER_INVALID, planProductReorder } from './product-order.js';

const rows = (...values: number[]) => values.map((sortOrder, i) => ({ id: `p${i + 1}`, sortOrder }));
const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);
const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return { type: (e as Error).constructor, code: (e as { getResponse: () => { errorCode: string } }).getResponse().errorCode };
  }
  return null;
};

describe('planProductReorder (the pure decision of PUT /products/order)', () => {
  it('moves a product up or down: consecutive positions for the rows that change, nothing for the rest', () => {
    expect(planProductReorder(rows(1, 2, 3, 4), ['p1', 'p3', 'p2', 'p4'], ids(4)).updates).toEqual([
      { id: 'p3', position: 2 },
      { id: 'p2', position: 3 },
    ]);
  });

  it('"to the start" with every product at 0: the starting point is the order the lists show, so only the moved one jumps', () => {
    // p1..p4 all 0 are listed p1, p2, p3, p4 (ties by created_at, id): moving p3 to the start gives p3, p1, p2, p4
    const plan = planProductReorder(rows(0, 0, 0, 0), ['p3', 'p1', 'p2', 'p4'], ids(4));
    expect(plan.updates.map((u) => [u.id, u.position])).toEqual([['p3', 1], ['p1', 2], ['p2', 3], ['p4', 4]]);
  });

  it('"to the end": the others close the gap, and a legacy gap (0, 1, 2, 3, 5) becomes 1..n', () => {
    const plan = planProductReorder(rows(0, 1, 2, 3, 5), ['p2', 'p3', 'p4', 'p5', 'p1'], ids(5));
    // p2, p3 and p4 already hold 1, 2 and 3: only the two that differ are written, and the stored values end up exactly 1..5
    expect(plan.updates.map((u) => [u.id, u.position])).toEqual([['p5', 4], ['p1', 5]]);
  });

  it('answers 409 PRODUCT_ORDER_CONFLICT before anything else when the sequence the caller saw is not the real one (same ids, other order too)', () => {
    expect(refusal(() => planProductReorder(rows(1, 2, 3), ['p1', 'p2', 'p3'], ['p2', 'p1', 'p3']))).toEqual({ type: ConflictException, code: PRODUCT_ORDER_CONFLICT });
    expect(refusal(() => planProductReorder(rows(1, 2, 3), ['p1', 'p2', 'zzz'], ['p1', 'p2']))).toEqual({ type: ConflictException, code: PRODUCT_ORDER_CONFLICT });
  });

  it('answers 400 PRODUCT_ORDER_INVALID, one answer for unknown, foreign, missing and repeated ids', () => {
    for (const ordered of [['p1', 'p2', 'zzz'], ['p1', 'p2'], ['p1', 'p2', 'p3', 'p4'], ['p1', 'p1', 'p2']]) {
      expect(refusal(() => planProductReorder(rows(1, 2, 3), ordered, ids(3)))).toEqual({ type: BadRequestException, code: PRODUCT_ORDER_INVALID });
    }
  });

  it('an order that is already the one asked changes nothing', () => {
    expect(planProductReorder(rows(1, 2, 3), ids(3), ids(3)).updates).toEqual([]);
  });
});
