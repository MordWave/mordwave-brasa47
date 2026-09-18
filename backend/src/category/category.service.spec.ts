import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SafeUser } from '../auth/safe-user.js';
import { Business } from '../business/business.entity.js';
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

describe('CategoryService', () => {
  let service: CategoryService;
  let categoryRepo: ReturnType<typeof createRepoMock>;
  let businessRepo: ReturnType<typeof createRepoMock>;
  let productRepo: ReturnType<typeof createRepoMock>;

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

    const moduleRef = await Test.createTestingModule({
      providers: [
        CategoryService,
        { provide: getRepositoryToken(Category), useValue: categoryRepo },
        { provide: getRepositoryToken(Business), useValue: businessRepo },
        { provide: getRepositoryToken(Product), useValue: productRepo },
      ],
    }).compile();

    service = moduleRef.get(CategoryService);
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

  it('findAllPublic always filters by active:true', async () => {
    categoryRepo.find.mockResolvedValue([]);

    await service.findAllPublic({});

    expect(categoryRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ active: true }) }),
    );
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
