import { BadRequestException, ConflictException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type EntityManager, IsNull, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity.js';
import {
  resolveBusinessIdForCreate,
  resolveBusinessIdForRead,
  resolveBusinessIdForUpdate,
} from '../auth/tenant.util.js';
import type { SafeUser } from '../auth/safe-user.js';
import { Business } from '../business/business.entity.js';
import { businessInactiveError } from '../business/business-active.js';
import { BusinessLimitsService } from '../business/business-limits.service.js';
import { PublicBusinessResolverService } from '../business/public-business-resolver.service.js';
import { Product } from '../product/product.entity.js';
import { Category } from './category.entity.js';
import { lockCategoryExclusive } from './category-locks.js';
import { CategoryQueryDto } from './dto/category-query.dto.js';
import { planCategoryReorder } from './category-order.js';
import { CreateCategoryDto } from './dto/create-category.dto.js';
import { ReorderCategoriesDto } from './dto/reorder-categories.dto.js';
import { UserRole } from '../user/user-role.enum.js';
import { UpdateCategoryDto } from './dto/update-category.dto.js';

@Injectable()
export class CategoryService {
  constructor(
    @InjectRepository(Category)
    private readonly categoryRepository: Repository<Category>,
    @InjectRepository(Business)
    private readonly businessRepository: Repository<Business>,
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
    private readonly publicBusinessResolver: PublicBusinessResolverService,
    private readonly dataSource: DataSource,
    private readonly businessLimits: BusinessLimitsService,
  ) {}

  private async assertBusinessExists(businessId: string): Promise<void> {
    const business = await this.businessRepository.findOne({
      where: { id: businessId },
    });
    if (!business) {
      throw new NotFoundException(
        `Business with id "${businessId}" does not exist`,
      );
    }
  }

  async create(dto: CreateCategoryDto, user: SafeUser): Promise<Category> {
    const businessId = resolveBusinessIdForCreate(user, dto.businessId);
    await this.assertBusinessExists(businessId);
    // Count + insert in one transaction behind a FOR UPDATE on the Business
    // row — see BusinessLimitsService.assertCanCreate.
    return this.dataSource.transaction(async (manager) => {
      await this.businessLimits.assertCanCreate(manager, businessId, 'category', user);
      const categoryRepository = manager.getRepository(Category);
      const category = categoryRepository.create(dto);
      category.businessId = businessId;
      // A new category goes LAST, decided here and not by the browser: the position after the highest one of the live categories (active and
      // inactive). The Business row is already locked FOR UPDATE above (the same lock PUT /categories/order takes), so two simultaneous creations
      // cannot read the same maximum. An explicit sortOrder (older clients, scripts) is still honoured as before.
      if (dto.sortOrder === undefined) category.sortOrder = await this.nextSortOrder(manager, businessId);
      return categoryRepository.save(category);
    });
  }

  // MAX(sort_order) + 1 over the live categories of the restaurant (soft-deleted ones do not count). Call it holding the Business lock.
  private async nextSortOrder(manager: EntityManager, businessId: string): Promise<number> {
    const rows = (await manager.query(
      `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM categories WHERE business_id = $1 AND deleted_at IS NULL`,
      [businessId],
    )) as Array<{ next: number | string }>;
    return Number(rows[0].next);
  }

  // Public menu read — active:false categories never show up here. Always
  // scoped to exactly one business (see PublicBusinessResolverService) — an
  // unscoped public read would otherwise mix every tenant's menu together.
  async findAllPublic(query: CategoryQueryDto): Promise<Category[]> {
    const businessId = await this.publicBusinessResolver.resolve(query);
    // Defensive ceiling = what a Business may create (never lower), with a
    // deterministic order.
    const rows = await this.categoryRepository.find({
      where: { businessId, active: true },
      order: { sortOrder: 'ASC', createdAt: 'ASC', id: 'ASC' },
      take: this.businessLimits.getListFetchSize('category'),
    });
    return this.businessLimits.capList('category', businessId, rows);
  }

  // Admin listing — includes active:false categories, scoped to the
  // caller's tenant (ADMIN: always their own business; SUPER_ADMIN:
  // whatever they ask for, or everything if unscoped).
  async findAllAdmin(query: CategoryQueryDto, user: SafeUser): Promise<Category[]> {
    const businessId = resolveBusinessIdForRead(user, query.businessId);
    const rows = await this.categoryRepository.find({
      where: businessId ? { businessId } : {},
      order: { sortOrder: 'ASC', createdAt: 'ASC', id: 'ASC' },
      take: this.businessLimits.getListFetchSize('category'),
    });
    return this.businessLimits.capList('category', businessId, rows);
  }

  // Internal lookup, no active filter — used by update() so a deactivated
  // category can still be found and reactivated.
  private async findOne(id: string): Promise<Category> {
    const category = await this.categoryRepository.findOne({ where: { id } });
    if (!category) {
      throw new NotFoundException(`Category with id "${id}" not found`);
    }
    return category;
  }

  // The ONLY columns a PATCH /categories/:id may write (never id, businessId, timestamps or deletedAt).
  private static readonly PATCH_COLUMNS = ['name', 'slug', 'active', 'sortOrder'] as const;

  // PATCH. Two things the old findOne -> Object.assign -> save() could not do under concurrency:
  //  1. Write ONLY the columns the request carries. save() wrote back every column that differed from the row as it is now, so a
  //     rename restored an `active` that another admin had just switched off (and could even write deleted_at = NULL: resurrect a
  //     deleted category). Now: `UPDATE categories SET <only the sent columns> WHERE id = $1 AND deleted_at IS NULL`.
  //  2. Judge "it still has active products" under a lock the product writers respect (see category-locks.ts): the category row is
  //     locked FOR UPDATE first, ownership and the product count are judged on what is committed at that moment, and the write
  //     happens in the same transaction, so a product created / reactivated / moved into this category meanwhile either finished
  //     before (and is counted) or waits and then finds the category inactive.
  async update(id: string, dto: UpdateCategoryDto, user: SafeUser): Promise<Category> {
    // Cheap fail-fast (404 / 403) before taking any lock; never trusted as the state to write over.
    const initial = await this.findOne(id);
    resolveBusinessIdForUpdate(user, initial.businessId, undefined);

    return this.dataSource.transaction(async (manager) => {
      const category = await lockCategoryExclusive(manager, id);
      // deleted while this request waited for the lock: same 404 as a category that never existed
      if (!category) throw new NotFoundException(`Category with id "${id}" not found`);

      // businessId isn't part of UpdateCategoryDto (immutable), so this only
      // ever enforces ownership: ADMIN must own this category, SUPER_ADMIN
      // always passes. Repeated on the locked row.
      resolveBusinessIdForUpdate(user, category.businessId, undefined);

      if (dto.active === false && category.active) {
        const activeProductCount = await manager.getRepository(Product).count({
          where: { categoryId: id, active: true },
        });
        if (activeProductCount > 0) {
          throw new ConflictException({
            message: `Cannot deactivate category "${id}": it still has ${activeProductCount} active product(s). Deactivate them first.`,
            errorCode: 'CATEGORY_HAS_ACTIVE_PRODUCTS',
            count: activeProductCount,
          });
        }
      }

      // only what the request really carries: undefined = untouched; a value (including false and 0) = the new value
      const columns: QueryDeepPartialEntity<Category> = {};
      for (const field of CategoryService.PATCH_COLUMNS) {
        const value = dto[field];
        if (value !== undefined) (columns as Record<string, unknown>)[field] = value;
      }
      const repository = manager.getRepository(Category);
      if (Object.keys(columns).length > 0) {
        const result = await repository.update({ id, deletedAt: IsNull() }, columns);
        // cannot happen while the row is locked and was just read alive; never report a write that did not happen
        if (!(result.affected ?? 0)) throw new NotFoundException(`Category with id "${id}" not found`);
      }
      // the row as it is now (the lock is still held): every column, including those this request did not send
      return repository.findOneByOrFail({ id });
    });
  }

  // Soft delete: sets deletedAt instead of removing the row (see the
  // deletedAt column comment on Category), so every existing find/findOne/
  // count already excludes it going forward. Blocked while the category
  // still has any non-deleted product under it — active or inactive,
  // unlike the deactivate check above, which only cares about active ones —
  // since deleting the category out from under a still-existing product
  // would leave that product pointing at a category that no longer exists
  // for any normal purpose.
  // The count is taken UNDER the category's FOR UPDATE lock (category-locks.ts), in the transaction that deletes: a product
  // created or moved into this category meanwhile either committed first (and is counted) or waits and then finds it deleted (404).
  // Returns { businessId } (rather than void) purely so the controller can
  // audit-log the deletion with the correct tenant even for a SUPER_ADMIN
  // acting on a business that isn't their own — the HTTP contract is
  // unaffected (the controller still responds 204 with no body).
  async remove(id: string, user: SafeUser): Promise<{ businessId: string }> {
    const initial = await this.findOne(id);
    resolveBusinessIdForUpdate(user, initial.businessId, undefined);

    return this.dataSource.transaction(async (manager) => {
      const category = await lockCategoryExclusive(manager, id);
      if (!category) throw new NotFoundException(`Category with id "${id}" not found`);
      resolveBusinessIdForUpdate(user, category.businessId, undefined);

      const productCount = await manager.getRepository(Product).count({
        where: { categoryId: id },
      });
      if (productCount > 0) {
        throw new ConflictException({
          message: `Cannot delete category "${id}": it still has ${productCount} product(s). Delete or move them first.`,
          errorCode: 'CATEGORY_HAS_PRODUCTS',
          count: productCount,
        });
      }

      await manager.getRepository(Category).softDelete(id);
      return { businessId: category.businessId };
    });
  }

  // PUT /categories/order — saves the COMPLETE order of one restaurant's categories, atomically.
  //
  // One transaction, and in it, in this order:
  //  1. the Business row FOR UPDATE: the coordination point per restaurant, the same lock category CREATION takes (assertCanCreate). So a
  //     reorder and a creation never interleave: whichever gets the lock first finishes, and the other sees its result. (Row locks on the
  //     categories alone could not stop an INSERT that happens meanwhile.) It is also where a suspended restaurant is refused for an ADMIN.
  //  2. every live category of the restaurant FOR UPDATE (active and inactive), in the order the lists show. A concurrent PATCH/DELETE of one
  //     category holds only its own row lock and never waits for the Business row, so there is no cycle (see category-locks.ts).
  //  3. planCategoryReorder judges the rows just read: 409 when the sequence the caller saw (expectedIds) is no longer the real one, 400 when
  //     orderedIds is not a permutation of the restaurant's ids (unknown / foreign / missing look the same).
  //  4. ONE UPDATE writes the new consecutive positions (1..n), only on rows whose value changes, and the rows are read back and checked: a
  //     mismatch throws and the whole transaction rolls back. Nothing else is written: no products, no other restaurant, no names or flags.
  // Order values that were repeated or had gaps become 1..n only here (never automatically when deploying). Nothing changes if the order
  // is already what was asked: no write, no audit.
  async reorder(
    query: CategoryQueryDto,
    dto: ReorderCategoriesDto,
    user: SafeUser,
  ): Promise<{ businessId: string; categories: Category[]; changed: boolean }> {
    const businessId = resolveBusinessIdForRead(user, query.businessId);
    if (!businessId) {
      throw new BadRequestException('businessId is required for a SUPER_ADMIN on this endpoint');
    }

    return this.dataSource.transaction(async (manager) => {
      const business = await manager.getRepository(Business).findOne({ where: { id: businessId }, lock: { mode: 'pessimistic_write' } });
      if (!business) throw new NotFoundException(`Business with id "${businessId}" does not exist`);
      if (!business.active && user.role !== UserRole.SUPER_ADMIN) throw businessInactiveError();

      const repository = manager.getRepository(Category);
      const listOrder = { sortOrder: 'ASC', createdAt: 'ASC', id: 'ASC' } as const;
      const current = await repository.find({ where: { businessId }, order: listOrder, lock: { mode: 'pessimistic_write' } });
      const plan = planCategoryReorder(current, dto.orderedIds, dto.expectedIds);
      if (plan.updates.length === 0) return { businessId, categories: current, changed: false };

      await manager.query(
        `UPDATE categories SET sort_order = t.position, updated_at = now()
           FROM unnest($1::uuid[], $2::int[]) AS t(id, position)
          WHERE categories.id = t.id AND categories.business_id = $3 AND categories.deleted_at IS NULL`,
        [plan.updates.map((u) => u.id), plan.updates.map((u) => u.position), businessId],
      );

      const after = await repository.find({ where: { businessId }, order: listOrder });
      const saved = after.length === dto.orderedIds.length && after.every((row, index) => row.id === dto.orderedIds[index] && row.sortOrder === index + 1);
      if (!saved) throw new InternalServerErrorException('The category order could not be saved');
      return { businessId, categories: after, changed: true };
    });
  }
}
