import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, ILike, IsNull } from 'typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SafeUser } from '../auth/safe-user.js';
import { Business } from '../business/business.entity.js';
import { BusinessLimitsService } from '../business/business-limits.service.js';
import { PublicBusinessResolverService } from '../business/public-business-resolver.service.js';
import { Category } from '../category/category.entity.js';
import { UserRole } from '../user/user-role.enum.js';
import { ProductImageService } from './product-image.service.js';
import { Product } from './product.entity.js';
import { ProductService } from './product.service.js';

function createRepoMock() {
  return {
    create: vi.fn((entity: unknown) => entity),
    save: vi.fn(async (entity: unknown) => entity),
    findOne: vi.fn(),
    find: vi.fn(),
    findAndCount: vi.fn(),
    createQueryBuilder: vi.fn(),
    softDelete: vi.fn(),
    // the column-scoped write of update()/attachImage()/removeImage(): one row affected unless a test says otherwise
    update: vi.fn(async () => ({ affected: 1 })),
    findOneByOrFail: vi.fn(),
  };
}

function createBusinessLimitsMock() {
  const limits: Record<string, number> = { product: 500, category: 50, table: 200, user: 20 };
  return {
    assertCanCreate: vi.fn(async () => undefined),
    getLimit: vi.fn((resource: string) => limits[resource]),
    getListFetchSize: vi.fn((resource: string) => limits[resource] + 1),
    // Same contract as the real one: trims to the limit (the real service
    // also logs when it actually trims — covered in its own spec).
    capList: vi.fn((resource: string, _businessId: string | undefined, rows: unknown[]) =>
      rows.slice(0, limits[resource]),
    ),
  };
}

function createProductImageServiceMock() {
  // No remove(): ProductImageService has no delete path during the
  // Supabase -> Railway Bucket transition.
  return {
    upload: vi.fn(),
  };
}

function createPublicBusinessResolverMock() {
  return { resolve: vi.fn() };
}

describe('ProductService', () => {
  let service: ProductService;
  let productRepo: ReturnType<typeof createRepoMock>;
  let categoryRepo: ReturnType<typeof createRepoMock>;
  let businessRepo: ReturnType<typeof createRepoMock>;
  let productImageService: ReturnType<typeof createProductImageServiceMock>;
  let publicBusinessResolver: ReturnType<typeof createPublicBusinessResolverMock>;
  let businessLimits: ReturnType<typeof createBusinessLimitsMock>;
  let transactionManager: { getRepository: ReturnType<typeof vi.fn> };

  const admin: SafeUser = {
    id: 'admin-1',
    email: 'admin@brasa47.cl',
    role: UserRole.ADMIN,
    businessId: 'biz-1',
    active: true,
  };

  const superAdmin: SafeUser = {
    id: 'super-1',
    email: 'super@mordwave.cl',
    role: UserRole.SUPER_ADMIN,
    businessId: null,
    active: true,
  };

  beforeEach(async () => {
    productRepo = createRepoMock();
    categoryRepo = createRepoMock();
    businessRepo = createRepoMock();
    productImageService = createProductImageServiceMock();
    publicBusinessResolver = createPublicBusinessResolverMock();
    businessLimits = createBusinessLimitsMock();

    // create()/moves run inside a transaction — manager.getRepository() routes
    // to the same product mock as the injected repository.
    transactionManager = {
      getRepository: vi.fn((entity: unknown) => {
        if (entity === Product) return productRepo;
        // update() judges the merged state on the transaction's own connection
        if (entity === Category) return categoryRepo;
        if (entity === Business) return businessRepo;
        throw new Error(`unexpected entity in manager.getRepository: ${String(entity)}`);
      }),
    };
    const dataSource = {
      transaction: vi.fn(async (cb: (manager: unknown) => unknown) => cb(transactionManager)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ProductService,
        { provide: getRepositoryToken(Product), useValue: productRepo },
        { provide: getRepositoryToken(Category), useValue: categoryRepo },
        { provide: getRepositoryToken(Business), useValue: businessRepo },
        { provide: ProductImageService, useValue: productImageService },
        { provide: PublicBusinessResolverService, useValue: publicBusinessResolver },
        { provide: DataSource, useValue: dataSource },
        { provide: BusinessLimitsService, useValue: businessLimits },
      ],
    }).compile();

    service = moduleRef.get(ProductService);
  });

  it('ADMIN create ignores a foreign businessId from the body and uses their own', async () => {
    businessRepo.findOne.mockResolvedValue({ id: 'biz-1' });
    categoryRepo.findOne.mockResolvedValue({ id: 'cat-1', businessId: 'biz-1', active: true });

    await service.create(
      { name: 'Producto', price: 1000, businessId: 'other-biz', categoryId: 'cat-1' },
      admin,
    );

    expect(productRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: 'biz-1' }),
    );
  });

  it('rejects create for an ADMIN with no businessId', async () => {
    const adminNoBusiness: SafeUser = { ...admin, businessId: null };

    await expect(
      service.create(
        { name: 'Producto', price: 1000, businessId: 'biz-1', categoryId: 'cat-1' },
        adminNoBusiness,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects create when the category belongs to a different business', async () => {
    businessRepo.findOne.mockResolvedValue({ id: 'biz-1' });
    categoryRepo.findOne.mockResolvedValue({ id: 'cat-1', businessId: 'other-biz', active: true });

    await expect(
      service.create(
        { name: 'Producto', price: 1000, businessId: 'biz-1', categoryId: 'cat-1' },
        admin,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects create when the category is inactive', async () => {
    businessRepo.findOne.mockResolvedValue({ id: 'biz-1' });
    categoryRepo.findOne.mockResolvedValue({ id: 'cat-1', businessId: 'biz-1', active: false });

    await expect(
      service.create(
        { name: 'Producto', price: 1000, businessId: 'biz-1', categoryId: 'cat-1' },
        admin,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('ADMIN cannot update a product belonging to another business', async () => {
    productRepo.findOne.mockResolvedValue({ id: 'p1', businessId: 'other-biz', categoryId: 'cat-1' });

    await expect(service.update('p1', { name: 'renamed' }, admin)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('ADMIN update rejects a category from a different business', async () => {
    productRepo.findOne.mockResolvedValue({ id: 'p1', businessId: 'biz-1', categoryId: 'cat-1' });
    categoryRepo.findOne.mockResolvedValue({ id: 'cat-2', businessId: 'other-biz', active: true });

    await expect(
      service.update('p1', { categoryId: 'cat-2' }, admin),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects moving a product to an inactive category', async () => {
    productRepo.findOne.mockResolvedValue({
      id: 'p1',
      businessId: 'biz-1',
      categoryId: 'cat-1',
      active: true,
    });
    categoryRepo.findOne.mockResolvedValue({ id: 'cat-2', businessId: 'biz-1', active: false });

    await expect(
      service.update('p1', { categoryId: 'cat-2' }, admin),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects reactivating (active:false -> true) a product whose category is inactive', async () => {
    productRepo.findOne.mockResolvedValue({
      id: 'p1',
      businessId: 'biz-1',
      categoryId: 'cat-1',
      active: false,
    });
    categoryRepo.findOne.mockResolvedValue({ id: 'cat-1', businessId: 'biz-1', active: false });

    await expect(
      service.update('p1', { active: true }, admin),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('allows deactivating a product regardless of its category status', async () => {
    productRepo.findOne.mockResolvedValue({
      id: 'p1',
      businessId: 'biz-1',
      categoryId: 'cat-1',
      active: true,
    });

    await service.update('p1', { active: false }, admin);

    // The category check is never even reached for a plain deactivation.
    expect(categoryRepo.findOne).not.toHaveBeenCalled();
    expect(productRepo.update).toHaveBeenCalledWith({ id: 'p1', deletedAt: IsNull() }, expect.objectContaining({ active: false }));
  });

  it('does not re-check the category on an unrelated edit to an already-active product', async () => {
    productRepo.findOne.mockResolvedValue({
      id: 'p1',
      businessId: 'biz-1',
      categoryId: 'cat-1',
      active: true,
    });

    await service.update('p1', { name: 'renamed' }, admin);

    expect(categoryRepo.findOne).not.toHaveBeenCalled();
    expect(productRepo.update).toHaveBeenCalledWith({ id: 'p1', deletedAt: IsNull() }, expect.objectContaining({ name: 'renamed' }));
  });

  it('SUPER_ADMIN moving a product to another business must also move its category', async () => {
    productRepo.findOne.mockResolvedValue({ id: 'p1', businessId: 'biz-1', categoryId: 'cat-1' });
    businessRepo.findOne.mockResolvedValue({ id: 'biz-2' });
    // The existing category still belongs to the OLD business.
    categoryRepo.findOne.mockResolvedValue({ id: 'cat-1', businessId: 'biz-1', active: true });

    await expect(
      service.update('p1', { businessId: 'biz-2' }, superAdmin),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('SUPER_ADMIN update keeps the current business when none is sent', async () => {
    productRepo.findOne.mockResolvedValue({ id: 'p1', businessId: 'biz-1', categoryId: 'cat-1' });

    await service.update('p1', { name: 'renamed' }, superAdmin);

    expect(businessRepo.findOne).not.toHaveBeenCalled();
    expect(productRepo.update).toHaveBeenCalledWith({ id: 'p1', deletedAt: IsNull() }, { name: 'renamed' },
    );
  });

  it('findAllPublic resolves the business first, then only includes products whose category is active', async () => {
    publicBusinessResolver.resolve.mockResolvedValue('biz-1');
    categoryRepo.find.mockResolvedValue([{ id: 'cat-1' }, { id: 'cat-2' }]);
    productRepo.find.mockResolvedValue([]);

    await service.findAllPublic({ businessSlug: 'brasa-47' });

    expect(publicBusinessResolver.resolve).toHaveBeenCalledWith({ businessSlug: 'brasa-47' });
    expect(categoryRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ active: true, businessId: 'biz-1' }) }),
    );
    const callArgs = productRepo.find.mock.calls[0][0];
    expect(callArgs.where.active).toBe(true);
    expect(callArgs.where.businessId).toBe('biz-1');
    expect(callArgs.where.categoryId).toEqual(expect.objectContaining({ _type: 'in' }));
  });

  it('findAllPublic skips the product query entirely when no category is active', async () => {
    publicBusinessResolver.resolve.mockResolvedValue('biz-1');
    categoryRepo.find.mockResolvedValue([]);

    const result = await service.findAllPublic({ businessId: 'biz-1' });

    expect(result).toEqual([]);
    expect(productRepo.find).not.toHaveBeenCalled();
  });

  it('findAllPublic never queries the database when the business cannot be resolved', async () => {
    publicBusinessResolver.resolve.mockRejectedValue(new BadRequestException());

    await expect(service.findAllPublic({})).rejects.toBeInstanceOf(BadRequestException);
    expect(categoryRepo.find).not.toHaveBeenCalled();
    expect(productRepo.find).not.toHaveBeenCalled();
  });

  it('findOnePublic 404s on an inactive product (same as not existing)', async () => {
    publicBusinessResolver.resolve.mockResolvedValue('biz-1');
    productRepo.findOne.mockResolvedValue(null);

    await expect(
      service.findOnePublic('p1', { businessId: 'biz-1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(productRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'p1', active: true, businessId: 'biz-1' }),
      }),
    );
  });

  it('findOnePublic 404s when the product is active but its category is not', async () => {
    publicBusinessResolver.resolve.mockResolvedValue('biz-1');
    productRepo.findOne.mockResolvedValue({ id: 'p1', categoryId: 'cat-1', active: true });
    categoryRepo.findOne.mockResolvedValue(null);

    await expect(
      service.findOnePublic('p1', { businessId: 'biz-1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(categoryRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'cat-1', active: true }) }),
    );
  });

  it('findOnePublic 404s a product that belongs to a different business (tenant-scoped lookup)', async () => {
    // The businessId filter is baked into the findOne() call itself — a
    // product from another business simply doesn't match, same as an
    // unknown id.
    publicBusinessResolver.resolve.mockResolvedValue('biz-1');
    productRepo.findOne.mockResolvedValue(null);

    await expect(
      service.findOnePublic('p-from-other-biz', { businessId: 'biz-1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(productRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ businessId: 'biz-1' }) }),
    );
  });

  describe('findAllAdmin (paginated)', () => {
    beforeEach(() => {
      productRepo.findAndCount.mockResolvedValue([[], 0]);
    });

    it('ADMIN ignores a foreign businessId from the query and sees only their own', async () => {
      await service.findAllAdmin({ businessId: 'other-biz' }, admin);

      expect(productRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ businessId: 'biz-1' }) }),
      );
      // No active filter by default — admin listing must include inactive products.
      const callArgs = productRepo.findAndCount.mock.calls[0][0];
      expect(callArgs.where).not.toHaveProperty('active');
    });

    it('SUPER_ADMIN with no businessId gets an unfiltered (all-business) query', async () => {
      await service.findAllAdmin({}, superAdmin);

      const callArgs = productRepo.findAndCount.mock.calls[0][0];
      expect(callArgs.where).not.toHaveProperty('businessId');
    });

    it('SUPER_ADMIN can scope to a specific business', async () => {
      await service.findAllAdmin({ businessId: 'biz-2' }, superAdmin);

      expect(productRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ businessId: 'biz-2' }) }),
      );
    });

    it('defaults to page 1, limit 20 and returns the standard envelope', async () => {
      productRepo.findAndCount.mockResolvedValue([[{ id: 'p1' }], 45]);

      const result = await service.findAllAdmin({}, admin);

      expect(productRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20 }),
      );
      expect(result).toEqual({
        items: [{ id: 'p1' }],
        page: 1,
        limit: 20,
        total: 45,
        totalPages: 3,
        hasMore: true,
      });
    });

    it('translates page/limit into skip/take', async () => {
      productRepo.findAndCount.mockResolvedValue([[], 45]);

      const result = await service.findAllAdmin({ page: 3, limit: 10 }, admin);

      expect(productRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10 }),
      );
      expect(result).toMatchObject({ page: 3, limit: 10, total: 45, totalPages: 5, hasMore: true });
    });

    it('reports hasMore=false on the last page and an empty envelope when there are no products', async () => {
      productRepo.findAndCount.mockResolvedValue([[], 45]);
      const last = await service.findAllAdmin({ page: 3 }, admin);
      expect(last).toMatchObject({ totalPages: 3, hasMore: false });

      productRepo.findAndCount.mockResolvedValue([[], 0]);
      const empty = await service.findAllAdmin({}, admin);
      expect(empty).toEqual({ items: [], page: 1, limit: 20, total: 0, totalPages: 0, hasMore: false });
    });

    it('orders deterministically (sortOrder, createdAt, then id as tiebreaker)', async () => {
      await service.findAllAdmin({}, admin);

      expect(productRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ order: { sortOrder: 'ASC', createdAt: 'ASC', id: 'ASC' } }),
      );
    });

    it('applies categoryId, active and available filters (including explicit false)', async () => {
      await service.findAllAdmin({ categoryId: 'cat-1', active: false, available: false }, admin);

      const where = productRepo.findAndCount.mock.calls[0][0].where;
      expect(where).toMatchObject({
        businessId: 'biz-1',
        categoryId: 'cat-1',
        active: false,
        available: false,
      });
    });

    it('search becomes a case-insensitive partial match on name', async () => {
      await service.findAllAdmin({ search: 'burg' }, admin);

      const where = productRepo.findAndCount.mock.calls[0][0].where;
      expect(where.name).toEqual(ILike('%burg%'));
    });

    it('search escapes LIKE wildcards so they match literally', async () => {
      await service.findAllAdmin({ search: '50%_off\\' }, admin);

      const where = productRepo.findAndCount.mock.calls[0][0].where;
      expect(where.name).toEqual(ILike('%50\\%\\_off\\\\%'));
    });

    it('an empty search adds no name filter', async () => {
      await service.findAllAdmin({ search: '' }, admin);

      const where = productRepo.findAndCount.mock.calls[0][0].where;
      expect(where).not.toHaveProperty('name');
    });

    it('never opts back into seeing soft-deleted rows (no withDeleted)', async () => {
      await service.findAllAdmin({}, admin);

      const callArgs = productRepo.findAndCount.mock.calls.at(-1)[0];
      expect(callArgs).not.toHaveProperty('withDeleted');
    });
  });

  describe('getAdminSummary', () => {
    function mockBuilder(rows: Array<{ categoryId: string; count: string }>) {
      const builder = {
        select: vi.fn().mockReturnThis(),
        addSelect: vi.fn().mockReturnThis(),
        groupBy: vi.fn().mockReturnThis(),
        andWhere: vi.fn().mockReturnThis(),
        getRawMany: vi.fn().mockResolvedValue(rows),
      };
      productRepo.createQueryBuilder.mockReturnValue(builder);
      return builder;
    }

    it('returns counts per category and a total, from a single grouped query', async () => {
      const builder = mockBuilder([
        { categoryId: 'cat-1', count: '12' },
        { categoryId: 'cat-2', count: '3' },
      ]);

      const result = await service.getAdminSummary({}, admin);

      expect(result).toEqual({ total: 15, byCategory: { 'cat-1': 12, 'cat-2': 3 } });
      expect(productRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(builder.groupBy).toHaveBeenCalledWith('product.categoryId');
      expect(builder.getRawMany).toHaveBeenCalledTimes(1);
    });

    it('ADMIN is always scoped to their own business, ignoring a foreign businessId', async () => {
      const builder = mockBuilder([]);

      await service.getAdminSummary({ businessId: 'other-biz' }, admin);

      expect(builder.andWhere).toHaveBeenCalledWith('product.businessId = :businessId', {
        businessId: 'biz-1',
      });
    });

    it('SUPER_ADMIN can scope to a business, or leave it unscoped', async () => {
      const scoped = mockBuilder([]);
      await service.getAdminSummary({ businessId: 'biz-2' }, superAdmin);
      expect(scoped.andWhere).toHaveBeenCalledWith('product.businessId = :businessId', {
        businessId: 'biz-2',
      });

      const unscoped = mockBuilder([]);
      await service.getAdminSummary({}, superAdmin);
      expect(unscoped.andWhere).not.toHaveBeenCalled();
    });

    it('with no filters, adds no condition beyond the tenant scope (whole catalog)', async () => {
      const builder = mockBuilder([]);

      await service.getAdminSummary({}, admin);

      expect(builder.andWhere).toHaveBeenCalledTimes(1);
    });

    it('applies search (escaped, case-insensitive), active and available — including explicit false', async () => {
      const builder = mockBuilder([]);

      await service.getAdminSummary({ search: '50%_', active: false, available: false }, admin);

      expect(builder.andWhere).toHaveBeenCalledWith('product.active = :active', { active: false });
      expect(builder.andWhere).toHaveBeenCalledWith('product.available = :available', { available: false });
      expect(builder.andWhere).toHaveBeenCalledWith('product.name ILIKE :search', {
        search: '%50\\%\\_%',
      });
    });

    it('never filters by category, even if a categoryId is smuggled into the query', async () => {
      const builder = mockBuilder([]);

      await service.getAdminSummary({ categoryId: 'cat-1' } as never, admin);

      const conditions = builder.andWhere.mock.calls.map((call) => call[0]);
      expect(conditions.some((c: string) => c.includes('categoryId') || c.includes('category'))).toBe(false);
    });

    it('returns an empty summary for a business with no matching products', async () => {
      mockBuilder([]);

      await expect(service.getAdminSummary({}, admin)).resolves.toEqual({ total: 0, byCategory: {} });
    });
  });

  describe('per-Business product limit', () => {
    const limitError = () =>
      new ConflictException({
        message: 'The maximum number of products for this business (500) has been reached',
        errorCode: 'BUSINESS_PRODUCT_LIMIT_REACHED',
        limit: 500,
      });

    it('create() checks the limit for the resolved Business, inside the transaction, before saving', async () => {
      businessRepo.findOne.mockResolvedValue({ id: 'biz-1' });
      categoryRepo.findOne.mockResolvedValue({ id: 'cat-1', businessId: 'biz-1', active: true });
      const order: string[] = [];
      businessLimits.assertCanCreate.mockImplementation(async () => {
        order.push('limit');
      });
      productRepo.save.mockImplementation(async (entity: unknown) => {
        order.push('save');
        return entity;
      });

      await service.create({ name: 'Producto', price: 1000, businessId: 'x', categoryId: 'cat-1' }, admin);

      expect(businessLimits.assertCanCreate).toHaveBeenCalledWith(transactionManager, 'biz-1', 'product', admin);
      expect(order).toEqual(['limit', 'save']);
    });

    it('create() never saves when the limit is reached, and the 409 error propagates untouched', async () => {
      businessRepo.findOne.mockResolvedValue({ id: 'biz-1' });
      categoryRepo.findOne.mockResolvedValue({ id: 'cat-1', businessId: 'biz-1', active: true });
      businessLimits.assertCanCreate.mockRejectedValue(limitError());

      const attempt = service.create({ name: 'Producto', price: 1000, businessId: 'x', categoryId: 'cat-1' }, admin);

      await expect(attempt).rejects.toBeInstanceOf(ConflictException);
      expect(productRepo.save).not.toHaveBeenCalled();
    });

    it('SUPER_ADMIN is not exempt: the limit is checked against the Business they target', async () => {
      businessRepo.findOne.mockResolvedValue({ id: 'biz-2' });
      categoryRepo.findOne.mockResolvedValue({ id: 'cat-9', businessId: 'biz-2', active: true });

      await service.create({ name: 'Producto', price: 1000, businessId: 'biz-2', categoryId: 'cat-9' }, superAdmin);

      expect(businessLimits.assertCanCreate).toHaveBeenCalledWith(transactionManager, 'biz-2', 'product', superAdmin);
    });

    it('moving a product to another Business consumes quota in the DESTINATION (locked check before saving)', async () => {
      productRepo.findOne.mockResolvedValue({ id: 'p1', businessId: 'biz-1', categoryId: 'cat-1', active: true });
      businessRepo.findOne.mockResolvedValue({ id: 'biz-2' });
      categoryRepo.findOne.mockResolvedValue({ id: 'cat-9', businessId: 'biz-2', active: true });

      await service.update('p1', { businessId: 'biz-2', categoryId: 'cat-9' }, superAdmin);

      expect(businessLimits.assertCanCreate).toHaveBeenCalledWith(transactionManager, 'biz-2', 'product', superAdmin);
      expect(productRepo.update).toHaveBeenCalledWith({ id: 'p1', deletedAt: IsNull() }, { businessId: 'biz-2', categoryId: 'cat-9' });
    });

    it('a move into a full Business is rejected and nothing is saved', async () => {
      productRepo.findOne.mockResolvedValue({ id: 'p1', businessId: 'biz-1', categoryId: 'cat-1', active: true });
      businessRepo.findOne.mockResolvedValue({ id: 'biz-2' });
      categoryRepo.findOne.mockResolvedValue({ id: 'cat-9', businessId: 'biz-2', active: true });
      businessLimits.assertCanCreate.mockRejectedValue(limitError());

      await expect(
        service.update('p1', { businessId: 'biz-2', categoryId: 'cat-9' }, superAdmin),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(productRepo.update).not.toHaveBeenCalled();
    });

    it('an ordinary update (same Business) never touches the limit', async () => {
      productRepo.findOne.mockResolvedValue({ id: 'p1', businessId: 'biz-1', categoryId: 'cat-1', active: true });

      await service.update('p1', { name: 'renamed' }, admin);

      expect(businessLimits.assertCanCreate).not.toHaveBeenCalled();
      expect(productRepo.update).toHaveBeenCalled();
    });

    it('reactivating (active false -> true) does not consume quota — the row already counts', async () => {
      productRepo.findOne.mockResolvedValue({ id: 'p1', businessId: 'biz-1', categoryId: 'cat-1', active: false });
      categoryRepo.findOne.mockResolvedValue({ id: 'cat-1', businessId: 'biz-1', active: true });

      await service.update('p1', { active: true }, admin);

      expect(businessLimits.assertCanCreate).not.toHaveBeenCalled();
    });
  });

  describe('public menu defensive cap', () => {
    const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}` }));

    it('asks for ONE row more than the product limit (to detect real truncation) with a fully deterministic order', async () => {
      publicBusinessResolver.resolve.mockResolvedValue('biz-1');
      categoryRepo.find.mockResolvedValue([{ id: 'cat-1' }]);
      productRepo.find.mockResolvedValue(rowsOf(1));

      await service.findAllPublic({ businessSlug: 'brasa-47' });

      expect(productRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 501,
          order: { sortOrder: 'ASC', createdAt: 'ASC', id: 'ASC' },
        }),
      );
      expect(businessLimits.getListFetchSize).toHaveBeenCalledWith('product');
    });

    it('exactly at the limit: returns every product, nothing is trimmed', async () => {
      publicBusinessResolver.resolve.mockResolvedValue('biz-1');
      categoryRepo.find.mockResolvedValue([{ id: 'cat-1' }]);
      productRepo.find.mockResolvedValue(rowsOf(500));

      const result = await service.findAllPublic({ businessSlug: 'brasa-47' });

      expect(result).toHaveLength(500);
      expect(businessLimits.capList).toHaveBeenCalledWith('product', 'biz-1', expect.any(Array));
    });

    it('above the limit (the extra probe row exists): returns only the first `limit`, in order', async () => {
      publicBusinessResolver.resolve.mockResolvedValue('biz-1');
      categoryRepo.find.mockResolvedValue([{ id: 'cat-1' }]);
      productRepo.find.mockResolvedValue(rowsOf(501));

      const result = await service.findAllPublic({ businessSlug: 'brasa-47' });

      expect(result).toHaveLength(500);
      expect(result[0]).toEqual({ id: 'p0' });
      expect(result.at(-1)).toEqual({ id: 'p499' });
    });

    it('asks for one extra category row too, deterministically ordered, and caps the ids it uses', async () => {
      publicBusinessResolver.resolve.mockResolvedValue('biz-1');
      categoryRepo.find.mockResolvedValue(
        Array.from({ length: 51 }, (_, i) => ({ id: `cat-${i}` })),
      );
      productRepo.find.mockResolvedValue([]);

      await service.findAllPublic({ businessSlug: 'brasa-47' });

      expect(categoryRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 51,
          order: { sortOrder: 'ASC', createdAt: 'ASC', id: 'ASC' },
        }),
      );
      // 51 rows came back; only the first 50 category ids reach the product query.
      const categoryIdFilter = productRepo.find.mock.calls[0][0].where.categoryId;
      expect(categoryIdFilter.value).toHaveLength(50);
      expect(categoryIdFilter.value).not.toContain('cat-50');
    });

    it('the public cap is never lower than what a Business may create (same limit source)', async () => {
      businessLimits.getLimit.mockImplementation((resource: string) => (resource === 'product' ? 123 : 7));
      businessLimits.getListFetchSize.mockImplementation((resource: string) => (resource === 'product' ? 124 : 8));
      publicBusinessResolver.resolve.mockResolvedValue('biz-1');
      categoryRepo.find.mockResolvedValue([{ id: 'cat-1' }]);
      productRepo.find.mockResolvedValue([]);

      await service.findAllPublic({ businessSlug: 'brasa-47' });

      expect(productRepo.find).toHaveBeenCalledWith(expect.objectContaining({ take: 124 }));
      expect(categoryRepo.find).toHaveBeenCalledWith(expect.objectContaining({ take: 8 }));
    });
  });

  describe('persists tag/ingredients/removableIngredients/addOns', () => {
    it('create() persists all four fields exactly as given', async () => {
      businessRepo.findOne.mockResolvedValue({ id: 'biz-1' });
      categoryRepo.findOne.mockResolvedValue({ id: 'cat-1', businessId: 'biz-1', active: true });

      await service.create(
        {
          name: 'Clásica Brasa',
          price: 6900,
          businessId: 'biz-1',
          categoryId: 'cat-1',
          tag: 'Más pedido',
          ingredients: ['Carne', 'Pan', 'Queso'],
          removableIngredients: ['Queso'],
          addOns: [{ name: 'Queso extra', price: 1200 }],
        },
        admin,
      );

      expect(productRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          tag: 'Más pedido',
          ingredients: ['Carne', 'Pan', 'Queso'],
          removableIngredients: ['Queso'],
          addOns: [{ name: 'Queso extra', price: 1200 }],
        }),
      );
    });

    it('update() persists a change to tag and addOns onto an existing product', async () => {
      productRepo.findOne.mockResolvedValue({
        id: 'p1',
        businessId: 'biz-1',
        categoryId: 'cat-1',
        active: true,
        tag: null,
        ingredients: [],
        removableIngredients: [],
        addOns: [],
      });

      await service.update(
        'p1',
        { tag: 'Nuevo', addOns: [{ name: 'Tocino', price: 1500 }] },
        admin,
      );

      expect(productRepo.update).toHaveBeenCalledWith({ id: 'p1', deletedAt: IsNull() }, expect.objectContaining({
          tag: 'Nuevo',
          addOns: [{ name: 'Tocino', price: 1500 }],
        }),
      );
    });

    it('update() persists a change to ingredients and removableIngredients together', async () => {
      productRepo.findOne.mockResolvedValue({
        id: 'p1',
        businessId: 'biz-1',
        categoryId: 'cat-1',
        active: true,
        tag: null,
        ingredients: ['Carne', 'Pan'],
        removableIngredients: [],
        addOns: [],
      });

      await service.update(
        'p1',
        { ingredients: ['Carne', 'Pan', 'Queso'], removableIngredients: ['Queso'] },
        admin,
      );

      expect(productRepo.update).toHaveBeenCalledWith({ id: 'p1', deletedAt: IsNull() }, expect.objectContaining({
          ingredients: ['Carne', 'Pan', 'Queso'],
          removableIngredients: ['Queso'],
        }),
      );
    });
  });

  describe('removableIngredients must be a subset of ingredients', () => {
    it('create() accepts a valid subset', async () => {
      businessRepo.findOne.mockResolvedValue({ id: 'biz-1' });
      categoryRepo.findOne.mockResolvedValue({ id: 'cat-1', businessId: 'biz-1', active: true });

      await service.create(
        {
          name: 'Clásica Brasa',
          price: 6900,
          businessId: 'biz-1',
          categoryId: 'cat-1',
          ingredients: ['Carne', 'Pan', 'Queso'],
          removableIngredients: ['Queso'],
        },
        admin,
      );

      expect(productRepo.save).toHaveBeenCalled();
    });

    it('create() rejects a removableIngredients entry not present in ingredients', async () => {
      businessRepo.findOne.mockResolvedValue({ id: 'biz-1' });
      categoryRepo.findOne.mockResolvedValue({ id: 'cat-1', businessId: 'biz-1', active: true });

      const error = await service
        .create(
          {
            name: 'Clásica Brasa',
            price: 6900,
            businessId: 'biz-1',
            categoryId: 'cat-1',
            ingredients: ['Carne', 'Pan'],
            removableIngredients: ['Queso'], // not in ingredients
          },
          admin,
        )
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toEqual(
        expect.objectContaining({ errorCode: 'REMOVABLE_INGREDIENTS_NOT_SUBSET' }),
      );
      expect(productRepo.save).not.toHaveBeenCalled();
    });

    it('update() rejects a PATCH that only changes removableIngredients, validated against the EXISTING ingredients', async () => {
      productRepo.findOne.mockResolvedValue({
        id: 'p1',
        businessId: 'biz-1',
        categoryId: 'cat-1',
        active: true,
        ingredients: ['Carne', 'Pan'],
        removableIngredients: [],
      });

      const error = await service
        .update('p1', { removableIngredients: ['Queso'] }, admin) // "Queso" isn't in the existing ingredients
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toEqual(
        expect.objectContaining({ errorCode: 'REMOVABLE_INGREDIENTS_NOT_SUBSET' }),
      );
      expect(productRepo.save).not.toHaveBeenCalled();
    });

    it('update() rejects a PATCH that only changes ingredients, orphaning an entry the EXISTING removableIngredients still references', async () => {
      productRepo.findOne.mockResolvedValue({
        id: 'p1',
        businessId: 'biz-1',
        categoryId: 'cat-1',
        active: true,
        ingredients: ['Carne', 'Pan', 'Queso'],
        removableIngredients: ['Queso'],
      });

      // Renaming/dropping "Queso" from ingredients without also updating
      // removableIngredients must be rejected, not silently leave a
      // removableIngredients entry that no longer matches anything.
      const error = await service
        .update('p1', { ingredients: ['Carne', 'Pan'] }, admin)
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toEqual(
        expect.objectContaining({ errorCode: 'REMOVABLE_INGREDIENTS_NOT_SUBSET' }),
      );
      expect(productRepo.save).not.toHaveBeenCalled();
    });

    it('update() accepts changing both fields together consistently', async () => {
      productRepo.findOne.mockResolvedValue({
        id: 'p1',
        businessId: 'biz-1',
        categoryId: 'cat-1',
        active: true,
        ingredients: ['Carne', 'Pan', 'Queso'],
        removableIngredients: ['Queso'],
      });

      await service.update(
        'p1',
        { ingredients: ['Carne', 'Pan'], removableIngredients: [] },
        admin,
      );

      expect(productRepo.update).toHaveBeenCalledWith({ id: 'p1', deletedAt: IsNull() }, expect.objectContaining({ ingredients: ['Carne', 'Pan'], removableIngredients: [] }),
      );
    });

    it('update() leaves an already-consistent product alone on an unrelated edit', async () => {
      productRepo.findOne.mockResolvedValue({
        id: 'p1',
        businessId: 'biz-1',
        categoryId: 'cat-1',
        active: true,
        ingredients: ['Carne', 'Pan', 'Queso'],
        removableIngredients: ['Queso'],
      });

      await service.update('p1', { name: 'renamed' }, admin);

      expect(productRepo.update).toHaveBeenCalledWith({ id: 'p1', deletedAt: IsNull() }, expect.objectContaining({ name: 'renamed' }));
    });
  });

  describe('duplicate names within ingredients/removableIngredients/addOns are rejected', () => {
    it('create() rejects two addOns with the same name but different prices', async () => {
      businessRepo.findOne.mockResolvedValue({ id: 'biz-1' });
      categoryRepo.findOne.mockResolvedValue({ id: 'cat-1', businessId: 'biz-1', active: true });

      const error = await service
        .create(
          {
            name: 'Clásica Brasa',
            price: 6900,
            businessId: 'biz-1',
            categoryId: 'cat-1',
            addOns: [
              { name: 'Tocino', price: 1500 },
              { name: 'Tocino', price: 99999 },
            ],
          },
          admin,
        )
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toEqual(
        expect.objectContaining({ errorCode: 'DUPLICATE_PRODUCT_FIELD_NAMES', field: 'addOns' }),
      );
      expect(productRepo.save).not.toHaveBeenCalled();
    });

    it('create() rejects duplicate addOns compared case-insensitively and trimmed', async () => {
      businessRepo.findOne.mockResolvedValue({ id: 'biz-1' });
      categoryRepo.findOne.mockResolvedValue({ id: 'cat-1', businessId: 'biz-1', active: true });

      const error = await service
        .create(
          {
            name: 'Clásica Brasa',
            price: 6900,
            businessId: 'biz-1',
            categoryId: 'cat-1',
            addOns: [
              { name: 'Queso extra', price: 1200 },
              { name: ' QUESO EXTRA ', price: 1200 },
            ],
          },
          admin,
        )
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toEqual(
        expect.objectContaining({ errorCode: 'DUPLICATE_PRODUCT_FIELD_NAMES', field: 'addOns' }),
      );
    });

    it('create() rejects duplicate ingredients (case-insensitive, trimmed)', async () => {
      businessRepo.findOne.mockResolvedValue({ id: 'biz-1' });
      categoryRepo.findOne.mockResolvedValue({ id: 'cat-1', businessId: 'biz-1', active: true });

      const error = await service
        .create(
          {
            name: 'Clásica Brasa',
            price: 6900,
            businessId: 'biz-1',
            categoryId: 'cat-1',
            ingredients: ['Queso', ' queso '],
          },
          admin,
        )
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toEqual(
        expect.objectContaining({ errorCode: 'DUPLICATE_PRODUCT_FIELD_NAMES', field: 'ingredients' }),
      );
      expect(productRepo.save).not.toHaveBeenCalled();
    });

    it('create() rejects duplicate removableIngredients', async () => {
      businessRepo.findOne.mockResolvedValue({ id: 'biz-1' });
      categoryRepo.findOne.mockResolvedValue({ id: 'cat-1', businessId: 'biz-1', active: true });

      const error = await service
        .create(
          {
            name: 'Clásica Brasa',
            price: 6900,
            businessId: 'biz-1',
            categoryId: 'cat-1',
            ingredients: ['Queso', 'Tomate'],
            removableIngredients: ['Queso', 'Queso'],
          },
          admin,
        )
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toEqual(
        expect.objectContaining({
          errorCode: 'DUPLICATE_PRODUCT_FIELD_NAMES',
          field: 'removableIngredients',
        }),
      );
      expect(productRepo.save).not.toHaveBeenCalled();
    });

    it('create() accepts distinct addOns/ingredients — no false positive', async () => {
      businessRepo.findOne.mockResolvedValue({ id: 'biz-1' });
      categoryRepo.findOne.mockResolvedValue({ id: 'cat-1', businessId: 'biz-1', active: true });

      await service.create(
        {
          name: 'Clásica Brasa',
          price: 6900,
          businessId: 'biz-1',
          categoryId: 'cat-1',
          ingredients: ['Carne', 'Pan', 'Queso'],
          removableIngredients: ['Queso'],
          addOns: [
            { name: 'Queso extra', price: 1200 },
            { name: 'Tocino', price: 1500 },
          ],
        },
        admin,
      );

      expect(productRepo.save).toHaveBeenCalled();
    });

    it('update() rejects a PATCH that introduces a duplicate addOn name, never deduplicating silently', async () => {
      productRepo.findOne.mockResolvedValue({
        id: 'p1',
        businessId: 'biz-1',
        categoryId: 'cat-1',
        active: true,
        ingredients: [],
        removableIngredients: [],
        addOns: [{ name: 'Tocino', price: 1500 }],
      });

      const error = await service
        .update(
          'p1',
          { addOns: [{ name: 'Tocino', price: 1500 }, { name: 'Tocino', price: 2000 }] },
          admin,
        )
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toEqual(
        expect.objectContaining({ errorCode: 'DUPLICATE_PRODUCT_FIELD_NAMES', field: 'addOns' }),
      );
      expect(productRepo.save).not.toHaveBeenCalled();
    });

    it('update() validates the FINAL merged addOns state — an unrelated edit on a product whose EXISTING addOns already have a duplicate (e.g. from before this check existed) is rejected too', async () => {
      productRepo.findOne.mockResolvedValue({
        id: 'p1',
        businessId: 'biz-1',
        categoryId: 'cat-1',
        active: true,
        ingredients: [],
        removableIngredients: [],
        addOns: [
          { name: 'Tocino', price: 1500 },
          { name: 'tocino', price: 2000 },
        ],
      });

      const error = await service
        .update('p1', { name: 'renamed' }, admin)
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toEqual(
        expect.objectContaining({ errorCode: 'DUPLICATE_PRODUCT_FIELD_NAMES', field: 'addOns' }),
      );
      expect(productRepo.save).not.toHaveBeenCalled();
    });

    it('update() leaves an already-clean product alone on an unrelated edit (no false positive from inherited state)', async () => {
      productRepo.findOne.mockResolvedValue({
        id: 'p1',
        businessId: 'biz-1',
        categoryId: 'cat-1',
        active: true,
        ingredients: ['Carne', 'Pan'],
        removableIngredients: [],
        addOns: [{ name: 'Tocino', price: 1500 }],
      });

      await service.update('p1', { name: 'renamed' }, admin);

      expect(productRepo.update).toHaveBeenCalledWith({ id: 'p1', deletedAt: IsNull() }, expect.objectContaining({ name: 'renamed' }));
    });
  });

  // Soft delete: TypeORM's @DeleteDateColumn makes every find/findOne/count
  // on this repository exclude a soft-deleted row automatically (verified
  // against the installed TypeORM's own source — see product.entity.ts).
  // These tests simulate that by having findOne resolve null for an id
  // that's already been soft-deleted, since that's exactly what TypeORM
  // would return once deletedAt is set — the service code has no idea
  // (and shouldn't need to) whether "not found" means "never existed" or
  // "was deleted".
  describe('remove', () => {
    it('soft-deletes via repository.softDelete(), never a real delete', async () => {
      productRepo.findOne.mockResolvedValue({ id: 'p1', businessId: 'biz-1' });

      await service.remove('p1', admin);

      expect(productRepo.softDelete).toHaveBeenCalledWith('p1');
    });

    it('rejects removing a product belonging to another business', async () => {
      productRepo.findOne.mockResolvedValue({ id: 'p1', businessId: 'other-biz' });

      await expect(service.remove('p1', admin)).rejects.toBeInstanceOf(ForbiddenException);
      expect(productRepo.softDelete).not.toHaveBeenCalled();
    });

    it('a second delete attempt 404s instead of deleting again', async () => {
      productRepo.findOne.mockResolvedValue(null);

      await expect(service.remove('p1', admin)).rejects.toBeInstanceOf(NotFoundException);
      expect(productRepo.softDelete).not.toHaveBeenCalled();
    });
  });

  it('a soft-deleted product cannot be edited afterward (404, same as never existing)', async () => {
    productRepo.findOne.mockResolvedValue(null);

    await expect(service.update('p1', { name: 'renamed' }, admin)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  describe('column-scoped writes (9E.21: no stale save(), never a deleted product)', () => {
    const live = { id: 'p1', businessId: 'biz-1', categoryId: 'cat-1', active: true, available: true, price: 1000, name: 'Burger' };

    it('update() locks the product row (FOR UPDATE) and writes ONLY the columns the request carries, never save()', async () => {
      productRepo.findOne.mockResolvedValue({ ...live });

      await service.update('p1', { description: 'Con queso' }, admin);

      expect(productRepo.findOne).toHaveBeenCalledWith({ where: { id: 'p1' }, lock: { mode: 'pessimistic_write' } });
      expect(productRepo.update).toHaveBeenCalledTimes(1);
      expect(productRepo.update).toHaveBeenCalledWith({ id: 'p1', deletedAt: IsNull() }, { description: 'Con queso' });
      expect(productRepo.save).not.toHaveBeenCalled();
    });

    it('update(): an omitted field is untouched, an explicit null clears it, and a falsy value (0, false, "") is written', async () => {
      productRepo.findOne.mockResolvedValue({ ...live });

      await service.update('p1', { description: null as unknown as string, price: 0, available: false, tag: '' }, admin);

      expect(productRepo.update).toHaveBeenCalledWith({ id: 'p1', deletedAt: IsNull() }, { description: null, price: 0, available: false, tag: '' });
    });

    it('update(): fields that are not editable columns (id, image key, timestamps, deletedAt) can never reach the statement', async () => {
      productRepo.findOne.mockResolvedValue({ ...live });

      await service.update('p1', { name: 'x', id: 'other', imageStorageKey: 'k', deletedAt: null, createdAt: 'now' } as never, admin);

      expect(productRepo.update).toHaveBeenCalledWith({ id: 'p1', deletedAt: IsNull() }, { name: 'x' });
    });

    it('update(): a product deleted while the request waited for the lock is a 404 and nothing is written', async () => {
      productRepo.findOne.mockResolvedValueOnce({ ...live }).mockResolvedValueOnce(null);

      await expect(service.update('p1', { name: 'x' }, admin)).rejects.toBeInstanceOf(NotFoundException);
      expect(productRepo.update).not.toHaveBeenCalled();
      expect(productRepo.save).not.toHaveBeenCalled();
    });

    it('update(): the ownership check is repeated on the LOCKED row (a product moved to another business meanwhile is refused)', async () => {
      productRepo.findOne.mockResolvedValueOnce({ ...live }).mockResolvedValueOnce({ ...live, businessId: 'other-biz' });

      await expect(service.update('p1', { name: 'x' }, admin)).rejects.toBeInstanceOf(ForbiddenException);
      expect(productRepo.update).not.toHaveBeenCalled();
    });

    it('update(): a SUPER_ADMIN move that another request already performed is a 409 PRODUCT_CONCURRENT_MODIFICATION, nothing written', async () => {
      productRepo.findOne.mockResolvedValueOnce({ ...live }).mockResolvedValueOnce({ ...live, businessId: 'biz-2' });
      businessRepo.findOne.mockResolvedValue({ id: 'biz-2' });

      const error = await service.update('p1', { businessId: 'biz-2', categoryId: 'cat-9' }, superAdmin).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ errorCode: 'PRODUCT_CONCURRENT_MODIFICATION' });
      expect(productRepo.update).not.toHaveBeenCalled();
    });

    it('update(): a request with nothing to change writes nothing and answers the current row', async () => {
      productRepo.findOne.mockResolvedValue({ ...live });
      productRepo.findOneByOrFail.mockResolvedValue({ ...live });

      const result = await service.update('p1', {}, admin);

      expect(productRepo.update).not.toHaveBeenCalled();
      expect(result.id).toBe('p1');
    });

    it('update(): the answer is the row re-read after the write (every column, including those the request did not send)', async () => {
      productRepo.findOne.mockResolvedValue({ ...live });
      productRepo.findOneByOrFail.mockResolvedValue({ ...live, description: 'Con queso' });

      const result = await service.update('p1', { description: 'Con queso' }, admin);

      expect(productRepo.findOneByOrFail).toHaveBeenCalledWith({ id: 'p1' });
      expect(result).toMatchObject({ name: 'Burger', price: 1000, description: 'Con queso' });
    });
  });

  describe('attachImage', () => {
    const file = { buffer: Buffer.from('bytes'), size: 100 };
    const NEW_KEY = 'businesses/aaaaaaaa-1111-4abc-8def-111111111abc/products/bbbbbbbb-2222-4abc-8def-222222222abc/cccccccc-3333-4abc-8def-333333333abc.webp';
    const NEWER_KEY = NEW_KEY.replace('cccccccc', 'dddddddd');

    it('rejects attaching an image to a product belonging to another business', async () => {
      productRepo.findOne.mockResolvedValue({ id: 'p1', businessId: 'other-biz' });

      await expect(service.attachImage('p1', admin, file)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(productImageService.upload).not.toHaveBeenCalled();
    });

    it("uploads for the product's own business, then writes ONLY image_storage_key (one statement scoped to id, business and not-deleted)", async () => {
      productRepo.findOne.mockResolvedValueOnce({ id: 'p1', businessId: 'biz-1', imageStorageKey: null, price: 1000 }).mockResolvedValueOnce({ id: 'p1', businessId: 'biz-1', imageStorageKey: NEW_KEY, price: 1500 });
      productImageService.upload.mockResolvedValue(NEW_KEY);

      const result = await service.attachImage('p1', admin, file);

      expect(productImageService.upload).toHaveBeenCalledWith('biz-1', 'p1', file);
      expect(productRepo.update).toHaveBeenCalledTimes(1);
      expect(productRepo.update).toHaveBeenCalledWith({ id: 'p1', businessId: 'biz-1', deletedAt: IsNull() }, { imageStorageKey: NEW_KEY });
      expect(productRepo.save).not.toHaveBeenCalled(); // a stale entity is never saved back
      // the answer is the row as it is now: the price another admin set during the upload is in it
      expect(result).toMatchObject({ imageStorageKey: NEW_KEY, price: 1500 });
      // the DB is written strictly after the upload
      expect(productImageService.upload.mock.invocationCallOrder[0]).toBeLessThan(productRepo.update.mock.invocationCallOrder[0]);
    });

    it('replacing again stores a different key and never deletes anything', async () => {
      productRepo.findOne.mockResolvedValue({ id: 'p1', businessId: 'biz-1', imageStorageKey: NEW_KEY });
      productImageService.upload.mockResolvedValue(NEWER_KEY);

      await service.attachImage('p1', admin, file);

      expect(productRepo.update).toHaveBeenCalledWith(expect.anything(), { imageStorageKey: NEWER_KEY });
      expect(NEWER_KEY).not.toBe(NEW_KEY);
      expect(productImageService).not.toHaveProperty('remove');
    });

    it('leaves the row untouched when the upload fails (storage error never modifies the DB)', async () => {
      productRepo.findOne.mockResolvedValue({ id: 'p1', businessId: 'biz-1', imageStorageKey: NEW_KEY });
      productImageService.upload.mockRejectedValue(new Error('storage down'));

      await expect(service.attachImage('p1', admin, file)).rejects.toThrow('storage down');

      expect(productRepo.update).not.toHaveBeenCalled();
    });

    it('a product DELETED during the upload is not revived: 404, the object is only a logged orphan candidate, nothing is retried or deleted', async () => {
      // read alive -> upload -> the UPDATE matches no row (deleted_at IS NULL no longer holds) -> the product is gone
      productRepo.findOne.mockResolvedValueOnce({ id: 'p1', businessId: 'biz-1', imageStorageKey: null }).mockResolvedValueOnce(null);
      productImageService.upload.mockResolvedValue(NEW_KEY);
      productRepo.update.mockResolvedValueOnce({ affected: 0 });
      const logged = vi.spyOn((service as unknown as { logger: { error: (m: string) => void } }).logger, 'error').mockImplementation(() => undefined);

      await expect(service.attachImage('p1', admin, file)).rejects.toBeInstanceOf(NotFoundException);

      expect(productRepo.update).toHaveBeenCalledTimes(1); // no retry
      expect(productRepo.save).not.toHaveBeenCalled();
      expect(logged).toHaveBeenCalledWith(expect.stringContaining(`orphan candidate key=${NEW_KEY}`));
      expect(productImageService).not.toHaveProperty('remove');
    });

    it('a product moved to another business during the upload is a 409 and the key is not written (orphan candidate logged)', async () => {
      productRepo.findOne.mockResolvedValueOnce({ id: 'p1', businessId: 'biz-1', imageStorageKey: null }).mockResolvedValueOnce({ id: 'p1', businessId: 'biz-2' });
      productImageService.upload.mockResolvedValue(NEW_KEY);
      productRepo.update.mockResolvedValueOnce({ affected: 0 });
      const logged = vi.spyOn((service as unknown as { logger: { error: (m: string) => void } }).logger, 'error').mockImplementation(() => undefined);

      const error = await service.attachImage('p1', admin, file).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ errorCode: 'PRODUCT_CONCURRENT_MODIFICATION' });
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('orphan candidate'));
    });

    it('a DB failure after a successful upload is reported, writes nothing else, is not retried, and deletes nothing', async () => {
      productRepo.findOne.mockResolvedValue({ id: 'p1', businessId: 'biz-1', imageStorageKey: null });
      productImageService.upload.mockResolvedValue(NEW_KEY);
      productRepo.update.mockRejectedValueOnce(new Error('db down'));
      const logged = vi.spyOn((service as unknown as { logger: { error: (m: string) => void } }).logger, 'error').mockImplementation(() => undefined);

      await expect(service.attachImage('p1', admin, file)).rejects.toThrow('db down');

      expect(productRepo.update).toHaveBeenCalledTimes(1);
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('orphan candidate'));
      expect(productImageService).not.toHaveProperty('remove');
    });
  });

  describe('removeImage', () => {
    it('rejects removing the image of a product belonging to another business', async () => {
      productRepo.findOne.mockResolvedValue({ id: 'p1', businessId: 'other-biz' });

      await expect(service.removeImage('p1', admin)).rejects.toBeInstanceOf(ForbiddenException);
      expect(productRepo.update).not.toHaveBeenCalled();
    });

    it('clears ONLY image_storage_key (one statement scoped to id, business and not-deleted), uploads and deletes nothing', async () => {
      productRepo.findOne
        .mockResolvedValueOnce({ id: 'p1', businessId: 'biz-1', imageStorageKey: 'k', price: 1000 })
        .mockResolvedValueOnce({ id: 'p1', businessId: 'biz-1', imageStorageKey: null, price: 1500 });

      const result = await service.removeImage('p1', admin);

      expect(productRepo.update).toHaveBeenCalledTimes(1);
      expect(productRepo.update).toHaveBeenCalledWith({ id: 'p1', businessId: 'biz-1', deletedAt: IsNull() }, { imageStorageKey: null });
      expect(productRepo.save).not.toHaveBeenCalled();
      expect(result).toMatchObject({ imageStorageKey: null, price: 1500 });
      expect(productImageService.upload).not.toHaveBeenCalled();
      expect(productImageService).not.toHaveProperty('remove');
    });

    it('a product DELETED meanwhile is not restored: 404 and nothing is retried', async () => {
      productRepo.findOne.mockResolvedValueOnce({ id: 'p1', businessId: 'biz-1', imageStorageKey: 'k' }).mockResolvedValueOnce(null);
      productRepo.update.mockResolvedValueOnce({ affected: 0 });

      await expect(service.removeImage('p1', admin)).rejects.toBeInstanceOf(NotFoundException);
      expect(productRepo.update).toHaveBeenCalledTimes(1);
      expect(productRepo.save).not.toHaveBeenCalled();
    });
  });

  it('soft-deleting a product never touches its Storage image (kept for history)', async () => {
    productRepo.findOne.mockResolvedValue({ id: 'p1', businessId: 'biz-1' });

    await service.remove('p1', admin);

    expect(productImageService).not.toHaveProperty('remove');
    expect(productRepo.softDelete).toHaveBeenCalledWith('p1');
  });
});
