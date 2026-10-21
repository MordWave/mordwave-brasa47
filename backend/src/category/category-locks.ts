import type { EntityManager } from 'typeorm';
import { Category } from './category.entity.js';

// THE CONCURRENCY PROTOCOL BETWEEN A CATEGORY AND THE PRODUCTS UNDER IT.
//
// Invariants (business rules that already exist, and that two checks alone cannot keep under concurrency):
//   I1  a category is never DEACTIVATED while it has an active product (CATEGORY_HAS_ACTIVE_PRODUCTS), and no product is created,
//       reactivated or moved INTO an inactive category (409);
//   I2  a category is never DELETED while it has any non-deleted product (CATEGORY_HAS_PRODUCTS), and no product is created or moved
//       into a deleted category (404).
// "Check the state, then write" is not enough: the category writer counts products while a product writer reads the category as active,
// each passes, both commit, and an active product sits under an inactive/deleted category. A foreign key does not help either: an
// INSERT/UPDATE of a product takes only FOR KEY SHARE on the category row, which does NOT conflict with the FOR NO KEY UPDATE of a plain
// `UPDATE categories SET active = false`.
//
// So both sides take an explicit row lock on the SAME category row, BEFORE judging anything, and hold it until their transaction ends:
//   - category writers that must see the products (deactivate, delete): lockCategoryExclusive  = SELECT ... FOR UPDATE
//   - product writers that rely on the category state (create, reactivate, change category, move):  lockCategoryShared = SELECT ... FOR SHARE
// FOR SHARE locks are compatible with each other (products of one category are created concurrently without waiting for one another)
// and conflict with FOR UPDATE. Whichever side gets the lock first completes its check AND its write before the other proceeds, and the
// one that waited re-reads the row it was waiting for (READ COMMITTED: a locking read returns the newest committed version, and a row
// soft-deleted meanwhile no longer matches): the category writer's COUNT, taken after the lock, sees every product the sharers
// committed; a product writer that waited sees the category already inactive or deleted and refuses.
//
// LOCK ORDER (every path acquires in this order, so none can deadlock another):
//     Business  ->  Product  ->  Category
//   - ProductService.create:  Business (assertCanCreate, FOR UPDATE) -> [new row] -> Category (FOR SHARE)
//   - ProductService.update:  [moving: destination Business FOR UPDATE] -> Product (FOR UPDATE) -> Category (FOR SHARE)
//   - CategoryService.update/remove: Category (FOR UPDATE) only; its COUNT of products is a plain read and takes no lock.
//   - CategoryService.create: Business only.
// Nobody holding a Category lock ever waits for a Product or Business lock, so there is no cycle.
//
// Both helpers MUST be called with the `manager` of the transaction that does the write, and the lock lasts until that transaction
// commits or rolls back. A soft-deleted category is not returned (null): the caller answers 404.
export function lockCategoryExclusive(manager: EntityManager, categoryId: string): Promise<Category | null> {
  return manager.getRepository(Category).findOne({ where: { id: categoryId }, lock: { mode: 'pessimistic_write' } });
}

export function lockCategoryShared(manager: EntityManager, categoryId: string): Promise<Category | null> {
  return manager.getRepository(Category).findOne({ where: { id: categoryId }, lock: { mode: 'pessimistic_read' } });
}
