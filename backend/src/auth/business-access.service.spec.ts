import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Business } from '../business/business.entity.js';
import { UserRole } from '../user/user-role.enum.js';
import { BusinessAccessService } from './business-access.service.js';

describe('BusinessAccessService', () => {
  let service: BusinessAccessService;
  let businessRepo: { findOne: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    businessRepo = { findOne: vi.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [BusinessAccessService, { provide: getRepositoryToken(Business), useValue: businessRepo }],
    }).compile();
    service = moduleRef.get(BusinessAccessService);
  });

  it('an ADMIN of an active business passes, with a single primary-key lookup of one column', async () => {
    businessRepo.findOne.mockResolvedValue({ id: 'biz-1', active: true });

    await expect(service.assertBusinessActive({ role: UserRole.ADMIN, businessId: 'biz-1' })).resolves.toBeUndefined();
    expect(businessRepo.findOne).toHaveBeenCalledTimes(1);
    expect(businessRepo.findOne).toHaveBeenCalledWith({ select: { id: true, active: true }, where: { id: 'biz-1' } });
  });

  it('an ADMIN of a suspended business -> 403 BUSINESS_INACTIVE', async () => {
    businessRepo.findOne.mockResolvedValue({ id: 'biz-1', active: false });

    const error = await service.assertBusinessActive({ role: UserRole.ADMIN, businessId: 'biz-1' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getStatus()).toBe(403);
    expect((error as ForbiddenException).getResponse()).toMatchObject({ errorCode: 'BUSINESS_INACTIVE' });
  });

  it('a business that does not exist is treated as suspended (fails closed)', async () => {
    businessRepo.findOne.mockResolvedValue(null);

    await expect(service.assertBusinessActive({ role: UserRole.ADMIN, businessId: 'biz-1' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a SUPER_ADMIN is never limited by a business, even one assigned to their own row: no lookup at all', async () => {
    businessRepo.findOne.mockResolvedValue({ id: 'biz-1', active: false });

    await expect(service.assertBusinessActive({ role: UserRole.SUPER_ADMIN, businessId: 'biz-1' })).resolves.toBeUndefined();
    await expect(service.assertBusinessActive({ role: UserRole.SUPER_ADMIN, businessId: null })).resolves.toBeUndefined();
    expect(businessRepo.findOne).not.toHaveBeenCalled();
  });

  it('an account with no business is not a suspension (the per-route tenant checks keep answering that case)', async () => {
    await expect(service.assertBusinessActive({ role: UserRole.ADMIN, businessId: null })).resolves.toBeUndefined();
    expect(businessRepo.findOne).not.toHaveBeenCalled();
  });
});
