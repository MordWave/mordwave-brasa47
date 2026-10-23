import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity.js';
import {
  resolveBusinessIdForCreate,
  resolveBusinessIdForRead,
  resolveBusinessIdForUpdate,
} from '../auth/tenant.util.js';
import type { SafeUser } from '../auth/safe-user.js';
import { Business } from '../business/business.entity.js';
import { BusinessLimitsService } from '../business/business-limits.service.js';
import { PublicBusinessResolverService } from '../business/public-business-resolver.service.js';
import { Product } from '../product/product.entity.js';
import { Category } from './category.entity.js';
import { lockCategoryExclusive } from './category-locks.js';
import { CategoryQueryDto } from './dto/category-query.dto.js';
import { CreateCategoryDto } from './dto/create-category.dto.js';
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
      return categoryRepository.save(category);
    });
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
}
