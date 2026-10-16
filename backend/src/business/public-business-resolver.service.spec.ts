import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
      select: { id: true },
      where: { id: 'biz-1', active: true },
    });
  });

  it('resolves by businessSlug to the matching business id', async () => {
    businessRepo.findOne.mockResolvedValue({ id: 'biz-1', slug: 'brasa-47', active: true });

    const result = await service.resolve({ businessSlug: 'brasa-47' });

    expect(result).toBe('biz-1');
    expect(businessRepo.findOne).toHaveBeenCalledWith({
      select: { id: true },
      where: { slug: 'brasa-47', active: true },
    });
  });

  it('only ever selects id — never name/slug/active/anything else from the row', async () => {
    businessRepo.findOne.mockResolvedValue({ id: 'biz-1' });

    await service.resolve({ businessSlug: 'brasa-47' });

    expect(businessRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ select: { id: true } }),
    );
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
      select: { id: true },
      where: { slug: 'brasa-47', active: true },
    });
  });

  describe('caching', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('resolves the same slug twice within the TTL with a single query to Business', async () => {
      businessRepo.findOne.mockResolvedValue({ id: 'biz-1', slug: 'brasa-47', active: true });

      const first = await service.resolve({ businessSlug: 'brasa-47' });
      const second = await service.resolve({ businessSlug: 'brasa-47' });

      expect(first).toBe('biz-1');
      expect(second).toBe('biz-1');
      expect(businessRepo.findOne).toHaveBeenCalledTimes(1);
    });

    it('resolves different slugs with independent queries', async () => {
      businessRepo.findOne.mockImplementation(async ({ where }: { where: { slug?: string } }) =>
        where.slug === 'brasa-47' ? { id: 'biz-1', slug: 'brasa-47', active: true } : { id: 'biz-2', slug: 'otro-negocio', active: true },
      );

      const a = await service.resolve({ businessSlug: 'brasa-47' });
      const b = await service.resolve({ businessSlug: 'otro-negocio' });

      expect(a).toBe('biz-1');
      expect(b).toBe('biz-2');
      expect(businessRepo.findOne).toHaveBeenCalledTimes(2);
    });

    it('never caches a nonexistent slug — a second lookup still hits the database', async () => {
      businessRepo.findOne.mockResolvedValue(null);

      await expect(service.resolve({ businessSlug: 'no-existe' })).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.resolve({ businessSlug: 'no-existe' })).rejects.toBeInstanceOf(NotFoundException);

      expect(businessRepo.findOne).toHaveBeenCalledTimes(2);
    });

    it('re-queries once the TTL has expired', async () => {
      businessRepo.findOne.mockResolvedValue({ id: 'biz-1', slug: 'brasa-47', active: true });

      await service.resolve({ businessSlug: 'brasa-47' });
      vi.advanceTimersByTime(30_001); // just past the 30s TTL
      await service.resolve({ businessSlug: 'brasa-47' });

      expect(businessRepo.findOne).toHaveBeenCalledTimes(2);
    });

    describe('invalidate(businessId)', () => {
      const rowFor = (where: { slug?: string; id?: string }) =>
        where.slug === 'otro-negocio' || where.id === 'biz-2'
          ? { id: 'biz-2', active: true }
          : { id: 'biz-1', active: true };

      it('drops every cached key of that business (id and slug) so the next read goes back to the database', async () => {
        businessRepo.findOne.mockImplementation(async ({ where }: { where: { slug?: string; id?: string } }) => rowFor(where));
        await service.resolve({ businessSlug: 'brasa-47' });
        await service.resolve({ businessId: 'biz-1' });
        expect(businessRepo.findOne).toHaveBeenCalledTimes(2);

        service.invalidate('biz-1');
        // the business is suspended now: the next lookups must see the database, not the cache
        businessRepo.findOne.mockResolvedValue(null);

        await expect(service.resolve({ businessSlug: 'brasa-47' })).rejects.toBeInstanceOf(NotFoundException);
        await expect(service.resolve({ businessId: 'biz-1' })).rejects.toBeInstanceOf(NotFoundException);
        expect(businessRepo.findOne).toHaveBeenCalledTimes(4);
      });

      it('leaves other businesses cached', async () => {
        businessRepo.findOne.mockImplementation(async ({ where }: { where: { slug?: string; id?: string } }) => rowFor(where));
        await service.resolve({ businessSlug: 'brasa-47' });
        await service.resolve({ businessSlug: 'otro-negocio' });

        service.invalidate('biz-1');
        await service.resolve({ businessSlug: 'otro-negocio' }); // still cached
        await service.resolve({ businessSlug: 'brasa-47' }); // re-queried

        expect(businessRepo.findOne).toHaveBeenCalledTimes(3);
      });

      it('is harmless for an unknown business and does not raise the TTL', async () => {
        expect(() => service.invalidate('nobody')).not.toThrow();

        businessRepo.findOne.mockResolvedValue({ id: 'biz-1', active: true });
        await service.resolve({ businessSlug: 'brasa-47' });
        vi.advanceTimersByTime(30_001);
        await service.resolve({ businessSlug: 'brasa-47' });
        expect(businessRepo.findOne).toHaveBeenCalledTimes(2); // TTL unchanged: 30 s
      });
    });
  });
});
