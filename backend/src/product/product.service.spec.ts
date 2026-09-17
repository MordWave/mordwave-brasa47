import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SafeUser } from '../auth/safe-user.js';
import { Business } from '../business/business.entity.js';
import { Category } from '../category/category.entity.js';
import { UserRole } from '../user/user-role.enum.js';
import { Product } from './product.entity.js';
import { ProductService } from './product.service.js';

function createRepoMock() {
  return {
    create: vi.fn((entity: unknown) => entity),
    save: vi.fn(async (entity: unknown) => entity),
    findOne: vi.fn(),
    find: vi.fn(),
  };
}

describe('ProductService', () => {
  let service: ProductService;
  let productRepo: ReturnType<typeof createRepoMock>;
  let categoryRepo: ReturnType<typeof createRepoMock>;
  let businessRepo: ReturnType<typeof createRepoMock>;

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

    const moduleRef = await Test.createTestingModule({
      providers: [
        ProductService,
        { provide: getRepositoryToken(Product), useValue: productRepo },
        { provide: getRepositoryToken(Category), useValue: categoryRepo },
        { provide: getRepositoryToken(Business), useValue: businessRepo },
      ],
    }).compile();

    service = moduleRef.get(ProductService);
  });

  it('ADMIN create ignores a foreign businessId from the body and uses their own', async () => {
    businessRepo.findOne.mockResolvedValue({ id: 'biz-1' });
    categoryRepo.findOne.mockResolvedValue({ id: 'cat-1', businessId: 'biz-1' });

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
    categoryRepo.findOne.mockResolvedValue({ id: 'cat-1', businessId: 'other-biz' });

    await expect(
      service.create(
        { name: 'Producto', price: 1000, businessId: 'biz-1', categoryId: 'cat-1' },
        admin,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ADMIN cannot update a product belonging to another business', async () => {
    productRepo.findOne.mockResolvedValue({ id: 'p1', businessId: 'other-biz', categoryId: 'cat-1' });

    await expect(service.update('p1', { name: 'renamed' }, admin)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('ADMIN update rejects a category from a different business', async () => {
    productRepo.findOne.mockResolvedValue({ id: 'p1', businessId: 'biz-1', categoryId: 'cat-1' });
    categoryRepo.findOne.mockResolvedValue({ id: 'cat-2', businessId: 'other-biz' });

    await expect(
      service.update('p1', { categoryId: 'cat-2' }, admin),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('SUPER_ADMIN moving a product to another business must also move its category', async () => {
    productRepo.findOne.mockResolvedValue({ id: 'p1', businessId: 'biz-1', categoryId: 'cat-1' });
    businessRepo.findOne.mockResolvedValue({ id: 'biz-2' });
    // The existing category still belongs to the OLD business.
    categoryRepo.findOne.mockResolvedValue({ id: 'cat-1', businessId: 'biz-1' });

    await expect(
      service.update('p1', { businessId: 'biz-2' }, superAdmin),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('SUPER_ADMIN update keeps the current business when none is sent', async () => {
    productRepo.findOne.mockResolvedValue({ id: 'p1', businessId: 'biz-1', categoryId: 'cat-1' });

    await service.update('p1', { name: 'renamed' }, superAdmin);

    expect(businessRepo.findOne).not.toHaveBeenCalled();
    expect(productRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: 'biz-1', name: 'renamed' }),
    );
  });
});
