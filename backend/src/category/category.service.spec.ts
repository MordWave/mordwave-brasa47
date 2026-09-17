import { ConflictException, ForbiddenException } from '@nestjs/common';
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

    await expect(
      service.update('cat-1', { active: false }, admin),
    ).rejects.toBeInstanceOf(ConflictException);

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
});
