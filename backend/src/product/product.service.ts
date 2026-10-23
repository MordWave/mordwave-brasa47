import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, FindOptionsWhere, ILike, In, IsNull, Repository } from 'typeorm';
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
import { Category } from '../category/category.entity.js';
import { PAGINATION_DEFAULT_LIMIT, PAGINATION_DEFAULT_PAGE } from '../common/pagination.const.js';
import { buildPaginated, escapeLikePattern, type Paginated } from '../common/pagination.util.js';
import { CreateProductDto } from './dto/create-product.dto.js';
import { ProductAdminQueryDto } from './dto/product-admin-query.dto.js';
import { ProductQueryDto } from './dto/product-query.dto.js';
import { ProductSummaryQueryDto } from './dto/product-summary-query.dto.js';
import { UpdateProductDto } from './dto/update-product.dto.js';
import { ProductImageService, type UploadableFile } from './product-image.service.js';
import { Product, type ProductAddOn } from './product.entity.js';

// Per-category product counts for the admin category chips — computed over
// the whole filtered set (search/active/available), never over just the page
// the list is showing.
export interface ProductAdminSummary {
  total: number;
  byCategory: Record<string, number>;
}

@Injectable()
export class ProductService {
  private readonly logger = new Logger(ProductService.name);

  constructor(
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
    @InjectRepository(Category)
    private readonly categoryRepository: Repository<Category>,
    @InjectRepository(Business)
    private readonly businessRepository: Repository<Business>,
    private readonly productImageService: ProductImageService,
    private readonly publicBusinessResolver: PublicBusinessResolverService,
    private readonly dataSource: DataSource,
    private readonly businessLimits: BusinessLimitsService,
  ) {}

  private async assertBusinessExists(businessId: string, repo: Repository<Business> = this.businessRepository): Promise<void> {
    const business = await repo.findOne({
      where: { id: businessId },
    });
    if (!business) {
      throw new NotFoundException(
        `Business with id "${businessId}" does not exist`,
      );
    }
  }

  private async getCategoryOrThrow(categoryId: string, repo: Repository<Category> = this.categoryRepository): Promise<Category> {
    const category = await repo.findOne({
      where: { id: categoryId },
    });
    if (!category) {
      throw new NotFoundException(
        `Category with id "${categoryId}" does not exist`,
      );
    }
    return category;
  }

  private assertCategoryBelongsToBusiness(category: Category, businessId: string): void {
    if (category.businessId !== businessId) {
      throw new BadRequestException(
        `Category "${category.id}" does not belong to business "${businessId}"`,
      );
    }
  }

  private assertCategoryIsActive(category: Category): void {
    if (!category.active) {
      throw new ConflictException(
        `Category "${category.id}" is inactive and cannot be used for products`,
      );
    }
  }

  // removableIngredients must always be a subset of ingredients — checked
  // here, against whatever the FINAL combined state will be, never against
  // just the fields present in one particular request. A partial PATCH
  // that only sends removableIngredients (leaving ingredients untouched),
  // or only sends ingredients (silently orphaning an entry the existing
  // removableIngredients still references), must be rejected exactly the
  // same as sending both at once inconsistently — never silently
  // corrected by dropping the offending entries.
  private assertRemovableIngredientsSubset(ingredients: string[], removableIngredients: string[]): void {
    const invalid = removableIngredients.filter((item) => !ingredients.includes(item));
    if (invalid.length > 0) {
      throw new BadRequestException({
        message: `removableIngredients must be a subset of ingredients — not found in ingredients: ${invalid.join(', ')}`,
        errorCode: 'REMOVABLE_INGREDIENTS_NOT_SUBSET',
        invalidIngredients: invalid,
      });
    }
  }

  // A name repeated within the same list (ingredients, removableIngredients,
  // or addOns' own names) is never legitimate — for addOns specifically,
  // OrderService.resolveItemModifiers resolves a selected name to a single
  // { name, price } via a Map keyed by name, so a duplicate would silently
  // collapse to whichever entry happens to come last, charging a price the
  // admin may not have intended. Rejected outright here (never
  // deduplicated server-side) so the admin sees exactly what's wrong.
  // Compared trimmed + case-insensitive: "Queso", " queso ", and "QUESO"
  // are the same name for this purpose.
  private assertNoDuplicateNames(field: string, names: string[]): void {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const name of names) {
      const normalized = name.trim().toLowerCase();
      if (seen.has(normalized)) {
        duplicates.add(name);
      } else {
        seen.add(normalized);
      }
    }
    if (duplicates.size > 0) {
      throw new BadRequestException({
        message: `${field} contains duplicate names (case-insensitive, trimmed): ${[...duplicates].join(', ')}`,
        errorCode: 'DUPLICATE_PRODUCT_FIELD_NAMES',
        field,
        duplicateNames: [...duplicates],
      });
    }
  }

  private assertNoDuplicatePersonalizationNames(
    ingredients: string[],
    removableIngredients: string[],
    addOns: ProductAddOn[],
  ): void {
    this.assertNoDuplicateNames('ingredients', ingredients);
    this.assertNoDuplicateNames('removableIngredients', removableIngredients);
    this.assertNoDuplicateNames(
      'addOns',
      addOns.map((addOn) => addOn.name),
    );
  }

  async create(dto: CreateProductDto, user: SafeUser): Promise<Product> {
    const businessId = resolveBusinessIdForCreate(user, dto.businessId);
    await this.assertBusinessExists(businessId);
    const category = await this.getCategoryOrThrow(dto.categoryId);
    this.assertCategoryBelongsToBusiness(category, businessId);
    this.assertCategoryIsActive(category);
    this.assertNoDuplicatePersonalizationNames(
      dto.ingredients ?? [],
      dto.removableIngredients ?? [],
      dto.addOns ?? [],
    );
    this.assertRemovableIngredientsSubset(dto.ingredients ?? [], dto.removableIngredients ?? []);
    // Count + insert run in one transaction behind a FOR UPDATE on the
    // Business row (see BusinessLimitsService.assertCanCreate) so the
    // per-Business product ceiling can't be overshot by concurrent creates.
    return this.dataSource.transaction(async (manager) => {
      await this.businessLimits.assertCanCreate(manager, businessId, 'product', user);
      const productRepository = manager.getRepository(Product);
      const product = productRepository.create(dto);
      product.businessId = businessId;
      return productRepository.save(product);
    });
  }

  private async findActiveCategoryIds(businessId: string, categoryId?: string): Promise<string[]> {
    const where: { active: boolean; businessId: string; id?: string } = { active: true, businessId };
    if (categoryId) where.id = categoryId;
    const rows = await this.categoryRepository.find({
      where,
      select: { id: true },
      // Defensive ceiling only — a Business can't create more categories
      // than this, so a normal tenant is never cut off. Asks for one extra
      // row so a real truncation can be detected (see capList).
      take: this.businessLimits.getListFetchSize('category'),
      order: { sortOrder: 'ASC', createdAt: 'ASC', id: 'ASC' },
    });
    const categories = this.businessLimits.capList('category', businessId, rows);
    return categories.map((category) => category.id);
  }

  // Public menu read — active:false products never show up here, and
  // neither do products whose category is itself inactive (a product can't
  // be "in" a category the menu no longer shows). `available` is left
  // untouched: an unavailable-but-active product still appears (e.g. "sold
  // out today"), it's just flagged as unavailable. Always scoped to exactly
  // one business (see PublicBusinessResolverService) — an unscoped public
  // read would otherwise mix every tenant's menu together.
  async findAllPublic(query: ProductQueryDto): Promise<Product[]> {
    const businessId = await this.publicBusinessResolver.resolve(query);
    const activeCategoryIds = await this.findActiveCategoryIds(businessId, query.categoryId);
    if (activeCategoryIds.length === 0) {
      return [];
    }

    // Defensive ceiling = exactly what a Business is allowed to create
    // (never lower, so a normal tenant is never truncated), with a fully
    // deterministic order so the cut — if it ever applies — is stable.
    const rows = await this.productRepository.find({
      where: { active: true, categoryId: In(activeCategoryIds), businessId },
      order: { sortOrder: 'ASC', createdAt: 'ASC', id: 'ASC' },
      take: this.businessLimits.getListFetchSize('product'),
    });
    return this.businessLimits.capList('product', businessId, rows);
  }

  // Same tenant scoping as findAllPublic: a product id from another
  // business 404s exactly like one that doesn't exist, instead of leaking
  // cross-tenant data to whoever guesses/finds a UUID.
  async findOnePublic(id: string, query: ProductQueryDto): Promise<Product> {
    const businessId = await this.publicBusinessResolver.resolve(query);
    const product = await this.productRepository.findOne({
      where: { id, active: true, businessId },
    });
    if (!product) {
      throw new NotFoundException(`Product with id "${id}" not found`);
    }
    const category = await this.categoryRepository.findOne({
      where: { id: product.categoryId, active: true },
    });
    if (!category) {
      // Same 404 as "doesn't exist" — an inactive parent category hides the
      // product from the public menu just as effectively as active:false.
      throw new NotFoundException(`Product with id "${id}" not found`);
    }
    return product;
  }

  // Admin listing — includes active:false products (and products under an
  // inactive category), scoped to the caller's tenant (ADMIN: always their
  // own business; SUPER_ADMIN: whatever they ask for, or everything if
  // unscoped). Paginated with a real total: a product catalog is small and
  // bounded, so the extra COUNT is cheap and lets the UI show "page X of Y".
  // `id` is a final ORDER BY tiebreaker so rows sharing the same
  // sortOrder/createdAt can never shuffle between pages.
  async findAllAdmin(query: ProductAdminQueryDto, user: SafeUser): Promise<Paginated<Product>> {
    const businessId = resolveBusinessIdForRead(user, query.businessId);
    const page = query.page ?? PAGINATION_DEFAULT_PAGE;
    const limit = query.limit ?? PAGINATION_DEFAULT_LIMIT;

    const where: FindOptionsWhere<Product> = {};
    if (businessId) where.businessId = businessId;
    if (query.categoryId) where.categoryId = query.categoryId;
    if (query.active !== undefined) where.active = query.active;
    if (query.available !== undefined) where.available = query.available;
    if (query.search) where.name = ILike(`%${escapeLikePattern(query.search)}%`);

    const [items, total] = await this.productRepository.findAndCount({
      where,
      order: { sortOrder: 'ASC', createdAt: 'ASC', id: 'ASC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return buildPaginated(items, page, limit, total);
  }

  // Per-category counts of the products matching the CURRENT search/active/
  // available filters, across every category (categoryId is deliberately not
  // a filter here — the breakdown by category is the point). With no filters
  // that's the whole catalog. One grouped query regardless of how many
  // categories exist; never derived from a single page of findAllAdmin. Same
  // tenant scoping as findAllAdmin; soft-deleted products are excluded
  // automatically (Product has a @DeleteDateColumn).
  async getAdminSummary(query: ProductSummaryQueryDto, user: SafeUser): Promise<ProductAdminSummary> {
    const businessId = resolveBusinessIdForRead(user, query.businessId);

    const builder = this.productRepository
      .createQueryBuilder('product')
      .select('product.categoryId', 'categoryId')
      .addSelect('COUNT(*)', 'count')
      .groupBy('product.categoryId');
    if (businessId) builder.andWhere('product.businessId = :businessId', { businessId });
    if (query.active !== undefined) builder.andWhere('product.active = :active', { active: query.active });
    if (query.available !== undefined) {
      builder.andWhere('product.available = :available', { available: query.available });
    }
    if (query.search) {
      // Same literal-wildcard escaping as findAllAdmin (backslash is
      // Postgres' default LIKE escape character).
      builder.andWhere('product.name ILIKE :search', { search: `%${escapeLikePattern(query.search)}%` });
    }

    const rows = await builder.getRawMany<{ categoryId: string; count: string }>();

    const byCategory: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      const count = Number(row.count);
      byCategory[row.categoryId] = count;
      total += count;
    }
    return { total, byCategory };
  }

  // Internal lookup, no active filter — used by update() so a deactivated
  // product can still be found and reactivated.
  async findOne(id: string): Promise<Product> {
    const product = await this.productRepository.findOne({ where: { id } });
    if (!product) {
      throw new NotFoundException(`Product with id "${id}" not found`);
    }
    return product;
  }

  // The ONLY columns a PATCH /products/:id may write (plus businessId for a SUPER_ADMIN move). Never id, image key, timestamps or
  // deletedAt, whatever the DTO class may grow.
  private static readonly PATCH_COLUMNS = [
    'name',
    'description',
    'price',
    'available',
    'active',
    'sortOrder',
    'tag',
    'ingredients',
    'removableIngredients',
    'addOns',
    'categoryId',
  ] as const;

  // WRITES OF A PRODUCT ROW (update, attachImage, removeImage). Rules, all about concurrent writers:
  //
  // 1. COLUMN-SCOPED. Each write is ONE `UPDATE products SET <only the columns it changes> WHERE id = $1 AND deleted_at IS NULL ...`.
  //    It never saves an entity read earlier: TypeORM's save() writes back EVERY column that differs from the row as it is now, so it
  //    restored an old price / availability / name that another admin had committed meanwhile (the whole S3 upload of an image is that
  //    window), and, because a soft-deleted row differs in `deleted_at`, it even wrote `deleted_at = NULL` and RESURRECTED a deleted
  //    product. A column nobody asked to change is not in the statement, so it cannot be reverted. Two writes that change the SAME
  //    column are last-writer-wins, as for any plain UPDATE (whoever commits last keeps their value; the other columns are never
  //    touched by either).
  //
  // 2. NEVER A DELETED PRODUCT. `deleted_at IS NULL` travels inside every statement. A concurrent soft delete holds the row lock until it
  //    commits; the UPDATE waits and re-evaluates the condition on the new version of the row, so it matches nothing (0 rows) instead
  //    of reviving it. 0 rows is explained afterwards, with nothing written: the product is gone -> 404.
  //
  // 3. PATCH (update) additionally takes the row lock (SELECT ... FOR UPDATE, which also skips a deleted row) and judges the merged
  //    state UNDER it: ownership, category rules, the ingredient/add-on invariants are checked against the row as it is at that moment,
  //    so two PATCHes of ingredients and removableIngredients cannot both pass against the same old state and leave them inconsistent.
  //    The lock is on this one product only (it never waits on, nor blocks, another product or another tenant).
  private async writeImageKey(product: Product, storageKey: string | null): Promise<void> {
    // business_id too: if a SUPER_ADMIN moved the product in the meantime, a key built for the old business is not written
    const result = await this.productRepository.update(
      { id: product.id, businessId: product.businessId, deletedAt: IsNull() },
      { imageStorageKey: storageKey },
    );
    if ((result.affected ?? 0) > 0) return;

    const current = await this.productRepository.findOne({ where: { id: product.id }, select: { id: true, businessId: true } });
    if (!current) throw new NotFoundException(`Product with id "${product.id}" not found`);
    throw new ConflictException({
      message: `Product "${product.id}" was moved to another business while its image was being changed; nothing was applied`,
      errorCode: 'PRODUCT_CONCURRENT_MODIFICATION',
    });
  }

  async update(id: string, dto: UpdateProductDto, user: SafeUser): Promise<Product> {
    // Cheap fail-fast (404 / 403) before opening a transaction; never trusted as the state to write over.
    const initial = await this.findOne(id);
    const initialBusinessId = resolveBusinessIdForUpdate(user, initial.businessId, dto.businessId);
    // Only a SUPER_ADMIN can move a product (see resolveBusinessIdForUpdate). That consumes quota in the DESTINATION Business, so it
    // goes through the same locked count as a create (Business row first, then the product row).
    const moving = initialBusinessId !== initial.businessId;

    return this.dataSource.transaction(async (manager) => {
      if (moving) await this.businessLimits.assertCanCreate(manager, initialBusinessId, 'product', user);

      const productRepository = manager.getRepository(Product);
      const product = await productRepository.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      // deleted while this request was waiting: same 404 as a product that never existed
      if (!product) throw new NotFoundException(`Product with id "${id}" not found`);

      // ADMIN: always their own business (throws if it doesn't match the product's current one). SUPER_ADMIN: the requested
      // business, or the product's current one if none was sent. Judged on the LOCKED row.
      const businessId = resolveBusinessIdForUpdate(user, product.businessId, dto.businessId);
      if ((businessId !== product.businessId) !== moving) {
        // the product was moved by someone else after the first read: nothing has been written, safe to repeat
        throw new ConflictException({
          message: `Product "${id}" was changed by another request; nothing was applied, review and retry`,
          errorCode: 'PRODUCT_CONCURRENT_MODIFICATION',
        });
      }

      if (moving) await this.assertBusinessExists(businessId, manager.getRepository(Business));

      // Re-validate the category (existence, business, and active status)
      // whenever it's actually being assigned to the product: the category
      // changed, the business changed (so the current category needs
      // re-checking against the destination business), or the product is
      // being reactivated (active: false -> true) — a product can't come back
      // to the menu under a category that's no longer on it either. A plain
      // deactivation, or an edit that leaves an already-active product's
      // category untouched, doesn't re-run this.
      const categoryId = dto.categoryId ?? product.categoryId;
      const categoryTargetChanged = Boolean(dto.categoryId) || moving;
      const reactivating = dto.active === true && !product.active;

      if (categoryTargetChanged || reactivating) {
        const category = await this.getCategoryOrThrow(categoryId, manager.getRepository(Category));
        this.assertCategoryBelongsToBusiness(category, businessId);
        this.assertCategoryIsActive(category);
      }

      // Validated against the FINAL combined state (whatever this PATCH
      // changes, merged onto whatever it leaves untouched) — never against
      // only the fields this particular request happens to include. The
      // `?? []` fallback only matters for a product row loaded before either
      // column existed in memory (e.g. a stale cache) — a real row always
      // has both as real arrays, never null/undefined, thanks to the
      // column's own DB-level default.
      const finalIngredients = dto.ingredients ?? product.ingredients ?? [];
      const finalRemovableIngredients = dto.removableIngredients ?? product.removableIngredients ?? [];
      const finalAddOns = dto.addOns ?? product.addOns ?? [];
      this.assertNoDuplicatePersonalizationNames(finalIngredients, finalRemovableIngredients, finalAddOns);
      this.assertRemovableIngredientsSubset(finalIngredients, finalRemovableIngredients);

      // only what the request really carries: undefined = untouched; null = cleared on purpose; anything else = the new value
      const columns: QueryDeepPartialEntity<Product> = {};
      for (const field of ProductService.PATCH_COLUMNS) {
        const value = dto[field];
        if (value !== undefined) (columns as Record<string, unknown>)[field] = value;
      }
      if (moving) columns.businessId = businessId;

      if (Object.keys(columns).length > 0) {
        const result = await productRepository.update({ id, deletedAt: IsNull() }, columns);
        // cannot happen while the row is locked and was just read alive; kept so a write is never reported that did not happen
        if (!(result.affected ?? 0)) throw new NotFoundException(`Product with id "${id}" not found`);
      }
      // the row as it is now (the lock is still held): every column, including those this request did not touch
      return productRepository.findOneByOrFail({ id });
    });
  }

  // Soft delete: sets deletedAt instead of removing the row, so it's
  // excluded from every find/findOne/count going forward (see the
  // deletedAt column comment on Product) while staying intact for any
  // future orders table to reference. No extra precondition beyond
  // ownership — unlike a category, a product has nothing under it.
  //
  // Returns { businessId } (rather than void) purely so the controller can
  // audit-log the deletion with the correct tenant even for a SUPER_ADMIN
  // acting on a business that isn't their own — the HTTP contract is
  // unaffected (the controller still responds 204 with no body).
  async remove(id: string, user: SafeUser): Promise<{ businessId: string }> {
    const product = await this.findOne(id);
    resolveBusinessIdForUpdate(user, product.businessId, undefined);
    await this.productRepository.softDelete(id);
    return { businessId: product.businessId };
  }

  // Same ownership check as update()/remove() — an ADMIN can only touch the
  // image of a product in their own business.
  //
  // New image: upload to the bucket under a brand-new key, THEN point the row
  // at it. The previous object is never deleted here (left for a later orphan
  // cleanup).
  //
  // If the DB save fails after a successful upload, nothing references the new
  // object (the row still has its old values): it is only an orphan candidate,
  // logged for the later cleanup — never auto-deleted during the transition.
  async attachImage(id: string, user: SafeUser, file: UploadableFile): Promise<Product> {
    const product = await this.findOne(id);
    resolveBusinessIdForUpdate(user, product.businessId, undefined);

    const storageKey = await this.productImageService.upload(product.businessId, product.id, file);

    // ONE statement that writes only image_storage_key (see writeImageKey): the price, availability, name... that other admins
    // changed during the upload are not touched, and a product deleted meanwhile is not revived.
    try {
      await this.writeImageKey(product, storageKey);
    } catch (error) {
      this.logger.error(`Product image uploaded but not saved; orphan candidate key=${storageKey}`);
      throw error;
    }
    return this.findOne(id); // the row as it is now (a product deleted a moment later is a plain 404)
  }

  // Detaches the image by clearing its storage key. No object is deleted from
  // the bucket — physical cleanup is a separate, later step.
  async removeImage(id: string, user: SafeUser): Promise<Product> {
    const product = await this.findOne(id);
    resolveBusinessIdForUpdate(user, product.businessId, undefined);

    await this.writeImageKey(product, null);
    return this.findOne(id);
  }
}
