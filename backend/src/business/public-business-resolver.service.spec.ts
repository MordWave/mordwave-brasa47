import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Business } from './business.entity.js';
import { PublicBusinessResolverService } from './public-business-resolver.service.js';

describe('PublicBusinessResolverService', () => {
  let service: PublicBusinessResolverService;
  let businessRepo: { findOne: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    businessRepo = { findOne: vi.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        PublicBusinessResolverService,
        { provide: getRepositoryToken(Business), useValue: businessRepo },
      ],
    }).compile();

    service = moduleRef.get(PublicBusinessResolverService);
  });

  it('rejects when neither businessId nor businessSlug is provided', async () => {
    await expect(service.resolve({})).rejects.toBeInstanceOf(BadRequestException);
    expect(businessRepo.findOne).not.toHaveBeenCalled();
  });

  it('rejects when both businessId and businessSlug are provided', async () => {
    await expect(
      service.resolve({ businessId: 'biz-1', businessSlug: 'brasa-47' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(businessRepo.findOne).not.toHaveBeenCalled();
  });

  it('resolves by businessId when the business exists and is active', async () => {
    businessRepo.findOne.mockResolvedValue({ id: 'biz-1', active: true });

    const result = await service.resolve({ businessId: 'biz-1' });

    expect(result).toBe('biz-1');
    expect(businessRepo.findOne).toHaveBeenCalledWith({
      where: { id: 'biz-1', active: true },
    });
  });

  it('resolves by businessSlug to the matching business id', async () => {
    businessRepo.findOne.mockResolvedValue({ id: 'biz-1', slug: 'brasa-47', active: true });

    const result = await service.resolve({ businessSlug: 'brasa-47' });

    expect(result).toBe('biz-1');
    expect(businessRepo.findOne).toHaveBeenCalledWith({
      where: { slug: 'brasa-47', active: true },
    });
  });

  it('404s with BUSINESS_NOT_FOUND when businessId matches nothing', async () => {
    businessRepo.findOne.mockResolvedValue(null);

    const error = await service.resolve({ businessId: 'unknown' }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getResponse()).toEqual(
      expect.objectContaining({ errorCode: 'BUSINESS_NOT_FOUND' }),
    );
  });

  it('404s with BUSINESS_NOT_FOUND when businessSlug matches nothing', async () => {
    businessRepo.findOne.mockResolvedValue(null);

    await expect(service.resolve({ businessSlug: 'unknown-biz' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('404s when the business exists but is inactive (query already filters active:true)', async () => {
    // The repository mock simulates the where:{active:true} filter itself
    // returning nothing — this documents that an inactive business is
    // treated as not found, not as a distinct error.
    businessRepo.findOne.mockResolvedValue(null);

    await expect(service.resolve({ businessSlug: 'brasa-47' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(businessRepo.findOne).toHaveBeenCalledWith({
      where: { slug: 'brasa-47', active: true },
    });
  });
});
