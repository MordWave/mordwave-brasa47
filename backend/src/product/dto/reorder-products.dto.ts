import { ArrayMaxSize, ArrayNotEmpty, ArrayUnique, IsArray, IsUUID } from 'class-validator';

// PUT /products/order — the COMPLETE order of the products of ONE category (active and inactive, never the soft-deleted ones).
// 500 is a transport guard: it is what a Business may create in total (see resource limits), so a category can never be larger.
export const REORDER_MAX_PRODUCTS = 500;

export class ReorderProductsDto {
  // The category whose products are being ordered. It decides the restaurant too: an ADMIN can only use a category of their own.
  @IsUUID('all')
  categoryId: string;

  // The new order, first to last. Must be exactly the ids of the products of that category: no duplicate, none missing, none foreign.
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(REORDER_MAX_PRODUCTS)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  orderedIds: string[];

  // The order the caller was looking at. If the category's products are not exactly that sequence when the write happens (someone reordered,
  // created, moved or deleted one meanwhile) nothing is written: 409 PRODUCT_ORDER_CONFLICT, and the caller re-reads.
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(REORDER_MAX_PRODUCTS)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  expectedIds: string[];
}
