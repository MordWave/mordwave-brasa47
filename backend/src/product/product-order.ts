import { planOrder, type OrderedRow, type OrderPlan } from '../common/order-plan.js';

export const PRODUCT_ORDER_CONFLICT = 'PRODUCT_ORDER_CONFLICT';
export const PRODUCT_ORDER_INVALID = 'PRODUCT_ORDER_INVALID';

// The pure decision of PUT /products/order (see planOrder): the list is the live products (active and inactive) of ONE category.
export function planProductReorder(current: readonly OrderedRow[], orderedIds: readonly string[], expectedIds: readonly string[]): OrderPlan {
  return planOrder(current, orderedIds, expectedIds, {
    conflict: {
      message: 'The products of this category changed since you loaded them. Reload the list and try again.',
      errorCode: PRODUCT_ORDER_CONFLICT,
    },
    invalid: {
      message: 'orderedIds must list exactly the products of the category, each once',
      errorCode: PRODUCT_ORDER_INVALID,
    },
  });
}
