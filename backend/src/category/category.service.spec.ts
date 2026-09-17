import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SafeUser } from '../auth/safe-user.js';
import { Business } from '../business/business.entity.js';
import { UserRole } from '../user/user-role.enum.js';
import { Category } from './category.entity.js';
import { CategoryService } from './category.service.js';

function createRepoMock() {
  return {
    create: vi.fn((entity: unknown) => entity),
    save: vi.fn(async (entity: unknown) => entity),
    findOne: vi.fn(),
    find: vi.fn(),
  };
}

describe('CategoryService', () => {
  let service: CategoryService;
  let categoryRepo: ReturnType<typeof createRepoMock>;
  let businessRepo: ReturnType<typeof createRepoMock>;

  const admin: SafeUser = {
    id: 'admin-1',
    email: 'admin@brasa47.cl',
    role: UserRole.ADMIN,
    businessId: 'biz-1',
    active: true,
  };

  beforeEach(async () => {
    categoryRepo = createRepoMock();
    businessRepo = createRepoMock();

    const moduleRef = await Test.createTestingModule({
      providers: [
        CategoryService,
        { provide: getRepositoryToken(Category), useValue: categoryRepo },
        { provide: getRepositoryToken(Business), useValue: businessRepo },
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
});
