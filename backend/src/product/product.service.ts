import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, FindOptionsWhere, ILike, In, Repository } from 'typeorm';
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

  private async getCategoryOrThrow(categoryId: string): Promise<Category> {
    const category = await this.categoryRepository.findOne({
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
      await this.businessLimits.assertCanCreate(manager, businessId, 'product');
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

  async update(id: string, dto: UpdateProductDto, user: SafeUser): Promise<Product> {
    const product = await this.findOne(id);

    // ADMIN: always their own business (throws if it doesn't match the
    // product's current one). SUPER_ADMIN: the requested business, or the
    // product's current one if none was sent.
    const businessId = resolveBusinessIdForUpdate(user, product.businessId, dto.businessId);

    if (businessId !== product.businessId) {
      await this.assertBusinessExists(businessId);
    }

    // Re-validate the category (existence, business, and active status)
    // whenever it's actually being assigned to the product: the category
    // changed, the business changed (so the current category needs
    // re-checking against the destination business), or the product is
    // being reactivated (active: false -> true) — a product can't come back
    // to the menu under a category that's no longer on it either. A plain
    // deactivation, or an edit that leaves an already-active product's
    // category untouched, doesn't re-run this.
    const categoryId = dto.categoryId ?? product.categoryId;
    const categoryTargetChanged = Boolean(dto.categoryId) || businessId !== product.businessId;
    const reactivating = dto.active === true && !product.active;

    if (categoryTargetChanged || reactivating) {
      const category = await this.getCategoryOrThrow(categoryId);
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

    const movingToAnotherBusiness = businessId !== product.businessId;
    Object.assign(product, dto, { businessId });

    // Only a SUPER_ADMIN can move a product (see resolveBusinessIdForUpdate).
    // That consumes quota in the DESTINATION Business, so it goes through the
    // same locked count as a create.
    if (movingToAnotherBusiness) {
      return this.dataSource.transaction(async (manager) => {
        await this.businessLimits.assertCanCreate(manager, businessId, 'product');
        return manager.getRepository(Product).save(product);
      });
    }
    return this.productRepository.save(product);
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
  // image of a product in their own business. imageUrl is only written
  // after ProductImageService confirms the file actually exists in
  // Storage; if it throws, this never reaches the save().
  async attachImage(id: string, user: SafeUser, file: UploadableFile): Promise<Product> {
    const product = await this.findOne(id);
    const businessId = resolveBusinessIdForUpdate(user, product.businessId, undefined);

    const imageUrl = await this.productImageService.upload(businessId, product.id, file);

    product.imageUrl = imageUrl;
    return this.productRepository.save(product);
  }

  // Deliberately different from soft-deleting the product itself: this is
  // an explicit, standalone action on a still-existing product, so the
  // Storage object is actually removed (not preserved the way a soft
  // delete's image is).
  async removeImage(id: string, user: SafeUser): Promise<Product> {
    const product = await this.findOne(id);
    const businessId = resolveBusinessIdForUpdate(user, product.businessId, undefined);

    await this.productImageService.remove(businessId, product.id);

    product.imageUrl = null;
    return this.productRepository.save(product);
  }
}
