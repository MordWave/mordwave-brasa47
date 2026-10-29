import { planOrder, type OrderedRow, type OrderPlan } from '../common/order-plan.js';

export const CATEGORY_ORDER_CONFLICT = 'CATEGORY_ORDER_CONFLICT';
export const CATEGORY_ORDER_INVALID = 'CATEGORY_ORDER_INVALID';

export type OrderedCategoryRow = OrderedRow;
export type ReorderPlan = OrderPlan;

// The pure decision of PUT /categories/order (see planOrder): the list is the live categories of ONE restaurant.
export function planCategoryReorder(current: readonly OrderedCategoryRow[], orderedIds: readonly string[], expectedIds: readonly string[]): ReorderPlan {
  return planOrder(current, orderedIds, expectedIds, {
    conflict: {
      message: 'The categories changed since you loaded them. Reload the list and try again.',
      errorCode: CATEGORY_ORDER_CONFLICT,
    },
    invalid: {
      message: 'orderedIds must list exactly the categories of the restaurant, each once',
      errorCode: CATEGORY_ORDER_INVALID,
    },
  });
}
