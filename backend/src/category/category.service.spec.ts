import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SafeUser } from '../auth/safe-user.js';
import { Business } from '../business/business.entity.js';
import { BusinessLimitsService } from '../business/business-limits.service.js';
import { PublicBusinessResolverService } from '../business/public-business-resolver.service.js';
import { Product } from '../product/product.entity.js';
import { UserRole } from '../user/user-role.enum.js';
import { Category } from './category.entity.js';
import { CategoryService } from './category.service.js';

function createRepoMock() {
  return {
    create: vi.fn((entity: unknown) => entity),
    save: vi.fn(async (entity: unknown) => entity),
    findOne: vi.fn(),
    find: vi.fn(),
    count: vi.fn(),
    softDelete: vi.fn(),
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

describe('CategoryService', () => {
  let service: CategoryService;
  let categoryRepo: ReturnType<typeof createRepoMock>;
  let businessRepo: ReturnType<typeof createRepoMock>;
  let productRepo: ReturnType<typeof createRepoMock>;
  let publicBusinessResolver: { resolve: ReturnType<typeof vi.fn> };
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
    categoryRepo = createRepoMock();
    businessRepo = createRepoMock();
    productRepo = createRepoMock();
    publicBusinessResolver = { resolve: vi.fn() };
    businessLimits = createBusinessLimitsMock();

    // create() runs inside a transaction — manager.getRepository() routes to
    // the same category mock as the injected repository.
    transactionManager = {
      getRepository: vi.fn((entity: unknown) => {
        if (entity === Category) return categoryRepo;
        throw new Error(`unexpected entity in manager.getRepository: ${String(entity)}`);
      }),
    };
    const dataSource = {
      transaction: vi.fn(async (cb: (manager: unknown) => unknown) => cb(transactionManager)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        CategoryService,
        { provide: getRepositoryToken(Category), useValue: categoryRepo },
        { provide: getRepositoryToken(Business), useValue: businessRepo },
        { provide: getRepositoryToken(Product), useValue: productRepo },
        { provide: PublicBusinessResolverService, useValue: publicBusinessResolver },
        { provide: DataSource, useValue: dataSource },
        { provide: BusinessLimitsService, useValue: businessLimits },
      ],
    }).compile();

    service = moduleRef.get(CategoryService);
  });

  describe('per-Business category limit', () => {
    it('create() checks the limit for the resolved Business, inside the transaction, before saving', async () => {
      businessRepo.findOne.mockResolvedValue({ id: 'biz-1' });
      const order: string[] = [];
      businessLimits.assertCanCreate.mockImplementation(async () => {
        order.push('limit');
      });
      categoryRepo.save.mockImplementation(async (entity: unknown) => {
        order.push('save');
        return entity;
      });

      await service.create({ name: 'Bebidas', slug: 'bebidas', businessId: 'x' }, admin);

      expect(businessLimits.assertCanCreate).toHaveBeenCalledWith(transactionManager, 'biz-1', 'category');
      expect(order).toEqual(['limit', 'save']);
    });

    it('create() never saves when the limit is reached', async () => {
      businessRepo.findOne.mockResolvedValue({ id: 'biz-1' });
      businessLimits.assertCanCreate.mockRejectedValue(
        new ConflictException({ errorCode: 'BUSINESS_CATEGORY_LIMIT_REACHED', limit: 50 }),
      );

      await expect(
        service.create({ name: 'Bebidas', slug: 'bebidas', businessId: 'x' }, admin),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(categoryRepo.save).not.toHaveBeenCalled();
    });

    it('SUPER_ADMIN is not exempt: the limit is checked against the Business they target', async () => {
      businessRepo.findOne.mockResolvedValue({ id: 'biz-2' });

      await service.create({ name: 'Bebidas', slug: 'bebidas', businessId: 'biz-2' }, superAdmin);

      expect(businessLimits.assertCanCreate).toHaveBeenCalledWith(transactionManager, 'biz-2', 'category');
    });

    it('updating or deactivating a category never consumes quota', async () => {
      categoryRepo.findOne.mockResolvedValue({ id: 'c1', businessId: 'biz-1', active: true });
      productRepo.count.mockResolvedValue(0);

      await service.update('c1', { active: false }, admin);

      expect(businessLimits.assertCanCreate).not.toHaveBeenCalled();
    });
  });

  describe('listing caps', () => {
    const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}` }));
    const order = { sortOrder: 'ASC', createdAt: 'ASC', id: 'ASC' };

    it('public list asks for one extra row (limit + 1) with a deterministic order', async () => {
      publicBusinessResolver.resolve.mockResolvedValue('biz-1');
      categoryRepo.find.mockResolvedValue(rowsOf(1));

      await service.findAllPublic({ businessSlug: 'brasa-47' });

      expect(categoryRepo.find).toHaveBeenCalledWith(expect.objectContaining({ take: 51, order }));
      expect(businessLimits.capList).toHaveBeenCalledWith('category', 'biz-1', expect.any(Array));
    });

    it('public list exactly at the limit: returns all 50, nothing trimmed', async () => {
      publicBusinessResolver.resolve.mockResolvedValue('biz-1');
      categoryRepo.find.mockResolvedValue(rowsOf(50));

      await expect(service.findAllPublic({ businessSlug: 'brasa-47' })).resolves.toHaveLength(50);
    });

    it('public list above the limit: returns only the first 50, in order', async () => {
      publicBusinessResolver.resolve.mockResolvedValue('biz-1');
      categoryRepo.find.mockResolvedValue(rowsOf(51));

      const result = await service.findAllPublic({ businessSlug: 'brasa-47' });

      expect(result).toHaveLength(50);
      expect(result.at(-1)).toEqual({ id: 'c49' });
    });

    it('admin list: limit + 1 probe, exactly at the limit returns all, above it trims', async () => {
      categoryRepo.find.mockResolvedValue(rowsOf(50));
      await expect(service.findAllAdmin({}, admin)).resolves.toHaveLength(50);
      expect(categoryRepo.find).toHaveBeenCalledWith(expect.objectContaining({ take: 51, order }));

      categoryRepo.find.mockResolvedValue(rowsOf(51));
      await expect(service.findAllAdmin({}, admin)).resolves.toHaveLength(50);
      expect(businessLimits.capList).toHaveBeenLastCalledWith('category', 'biz-1', expect.any(Array));
    });
  });

  it('ADMIN create ignores a foreign businessId from the body and uses their own', async () => {
    businessRepo.findOne.mockResolvedValue({ id: 'biz-1' });

    await service.create({ name: 'Bebidas', slug: 'bebidas', businessId: 'other-biz' }, admin);

    expect(categoryRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: 'biz-1' }),
    );
  });

  it('rejects create for an ADMIN with no businessId', async () => {
    const adminNoBusiness: SafeUser = { ...admin, businessId: null };

    await expect(
      service.create({ name: 'Bebidas', slug: 'bebidas', businessId: 'biz-1' }, adminNoBusiness),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('findAllPublic resolves the business first, then filters by active:true and that business', async () => {
    publicBusinessResolver.resolve.mockResolvedValue('biz-1');
    categoryRepo.find.mockResolvedValue([]);

    await service.findAllPublic({ businessSlug: 'brasa-47' });

    expect(publicBusinessResolver.resolve).toHaveBeenCalledWith({ businessSlug: 'brasa-47' });
    expect(categoryRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { businessId: 'biz-1', active: true } }),
    );
  });

  it('findAllPublic never queries the database when the business cannot be resolved', async () => {
    publicBusinessResolver.resolve.mockRejectedValue(new BadRequestException());

    await expect(service.findAllPublic({})).rejects.toBeInstanceOf(BadRequestException);
    expect(categoryRepo.find).not.toHaveBeenCalled();
  });

  it('findAllAdmin: ADMIN ignores a foreign businessId from the query and sees only their own', async () => {
    categoryRepo.find.mockResolvedValue([]);

    await service.findAllAdmin({ businessId: 'other-biz' }, admin);

    expect(categoryRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { businessId: 'biz-1' } }),
    );
  });

  it('findAllAdmin: SUPER_ADMIN with no businessId gets an unfiltered (all-business) query', async () => {
    categoryRepo.find.mockResolvedValue([]);

    await service.findAllAdmin({}, superAdmin);

    expect(categoryRepo.find).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
  });

  it('ADMIN cannot update a category belonging to another business', async () => {
    categoryRepo.findOne.mockResolvedValue({ id: 'cat-1', businessId: 'other-biz', active: true });

    await expect(service.update('cat-1', { name: 'renamed' }, admin)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('blocks deactivating a category that still has active products', async () => {
    categoryRepo.findOne.mockResolvedValue({ id: 'cat-1', businessId: 'biz-1', active: true });
    productRepo.count.mockResolvedValue(3);

    const error = await service
      .update('cat-1', { active: false }, admin)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toEqual(
      expect.objectContaining({ errorCode: 'CATEGORY_HAS_ACTIVE_PRODUCTS', count: 3 }),
    );
    expect(productRepo.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: { categoryId: 'cat-1', active: true } }),
    );
    expect(categoryRepo.save).not.toHaveBeenCalled();
  });

  it('allows deactivating a category with no active products', async () => {
    categoryRepo.findOne.mockResolvedValue({ id: 'cat-1', businessId: 'biz-1', active: true });
    productRepo.count.mockResolvedValue(0);

    await service.update('cat-1', { active: false }, admin);

    expect(categoryRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ active: false }),
    );
  });

  it('allows reactivating a category without checking product counts', async () => {
    categoryRepo.findOne.mockResolvedValue({ id: 'cat-1', businessId: 'biz-1', active: false });

    await service.update('cat-1', { active: true }, admin);

    expect(productRepo.count).not.toHaveBeenCalled();
    expect(categoryRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ active: true }),
    );
  });

  // Soft delete: TypeORM's @DeleteDateColumn makes every find/findOne/count
  // on this repository exclude a soft-deleted row automatically (verified
  // against the installed TypeORM's own source — see category.entity.ts).
  // These tests simulate that by having findOne resolve null for an id
  // that's already been soft-deleted, since that's exactly what TypeORM
  // would return once deletedAt is set.
  describe('remove', () => {
    it('soft-deletes via repository.softDelete() when the category has no products', async () => {
      categoryRepo.findOne.mockResolvedValue({ id: 'cat-1', businessId: 'biz-1' });
      productRepo.count.mockResolvedValue(0);

      await service.remove('cat-1', admin);

      expect(categoryRepo.softDelete).toHaveBeenCalledWith('cat-1');
    });

    it('blocks deleting a category that still has products (active or not)', async () => {
      categoryRepo.findOne.mockResolvedValue({ id: 'cat-1', businessId: 'biz-1' });
      productRepo.count.mockResolvedValue(2);

      const error = await service.remove('cat-1', admin).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toEqual(
        expect.objectContaining({ errorCode: 'CATEGORY_HAS_PRODUCTS', count: 2 }),
      );
      // Unlike the deactivate check, this counts every non-deleted product,
      // not just active:true ones — no `active` key in the where clause.
      expect(productRepo.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: { categoryId: 'cat-1' } }),
      );
      expect(categoryRepo.softDelete).not.toHaveBeenCalled();
    });

    it('rejects removing a category belonging to another business', async () => {
      categoryRepo.findOne.mockResolvedValue({ id: 'cat-1', businessId: 'other-biz' });

      await expect(service.remove('cat-1', admin)).rejects.toBeInstanceOf(ForbiddenException);
      expect(categoryRepo.softDelete).not.toHaveBeenCalled();
    });

    it('a second delete attempt 404s instead of deleting again', async () => {
      categoryRepo.findOne.mockResolvedValue(null);

      await expect(service.remove('cat-1', admin)).rejects.toBeInstanceOf(NotFoundException);
      expect(categoryRepo.softDelete).not.toHaveBeenCalled();
    });
  });

  it('a soft-deleted category cannot be edited afterward (404, same as never existing)', async () => {
    categoryRepo.findOne.mockResolvedValue(null);

    await expect(service.update('cat-1', { name: 'renamed' }, admin)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('admin listing never opts back into seeing soft-deleted rows (no withDeleted)', async () => {
    categoryRepo.find.mockResolvedValue([]);

    await service.findAllAdmin({}, admin);

    const callArgs = categoryRepo.find.mock.calls.at(-1)[0];
    expect(callArgs).not.toHaveProperty('withDeleted');
  });
});
