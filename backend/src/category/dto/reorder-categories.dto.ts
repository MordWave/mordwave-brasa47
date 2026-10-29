import { ArrayMaxSize, ArrayNotEmpty, ArrayUnique, IsArray, IsUUID } from 'class-validator';

// PUT /categories/order — the COMPLETE order of a restaurant's categories (active and inactive, never the soft-deleted ones).
// 500 is a transport guard (the body is small anyway), far above what a Business may create (50 by default).
export const REORDER_MAX_CATEGORIES = 500;

export class ReorderCategoriesDto {
  // The new order, first to last. Must be exactly the ids of the categories of the restaurant: no duplicate, none missing, none foreign.
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(REORDER_MAX_CATEGORIES)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  orderedIds: string[];

  // The order the caller was looking at (the ids as the list showed them). If the restaurant's categories are not exactly that
  // sequence when the write happens (someone reordered, created or deleted one meanwhile) nothing is written: 409
  // CATEGORY_ORDER_CONFLICT, and the caller re-reads. This is what stops one admin from silently overwriting another's order.
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(REORDER_MAX_CATEGORIES)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  expectedIds: string[];
}
