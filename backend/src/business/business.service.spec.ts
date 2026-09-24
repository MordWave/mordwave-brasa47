import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SafeUser } from '../auth/safe-user.js';
import { ImageStorageService } from '../storage/image-storage.service.js';
import { UserRole } from '../user/user-role.enum.js';
import { Business } from './business.entity.js';
import { BusinessService } from './business.service.js';

function createRepoMock() {
  return {
    findOne: vi.fn(),
    save: vi.fn(async (entity: unknown) => entity),
  };
}

describe('BusinessService', () => {
  let service: BusinessService;
  let businessRepo: ReturnType<typeof createRepoMock>;
  let imageStorage: { upload: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };

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

  const existingBusiness = {
    id: 'biz-1',
    name: 'Brasa 47',
    slug: 'brasa-47',
    active: true,
    address: null,
    phone: null,
    hours: null,
    logoUrl: null,
    primaryColor: null,
    accentColor: null,
  };

  beforeEach(async () => {
    businessRepo = createRepoMock();
    imageStorage = { upload: vi.fn(), remove: vi.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        BusinessService,
        { provide: getRepositoryToken(Business), useValue: businessRepo },
        { provide: ImageStorageService, useValue: imageStorage },
      ],
    }).compile();

    service = moduleRef.get(BusinessService);
  });

  describe('getMe', () => {
    it('ADMIN gets their own business, ignoring any businessId query', async () => {
      businessRepo.findOne.mockResolvedValue(existingBusiness);

      const result = await service.getMe({ businessId: 'other-biz' }, admin);

      expect(result).toBe(existingBusiness);
      expect(businessRepo.findOne).toHaveBeenCalledWith({ where: { id: 'biz-1' } });
    });

    it('SUPER_ADMIN must specify businessId — rejected with 400 if omitted', async () => {
      const error = await service.getMe({}, superAdmin).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(businessRepo.findOne).not.toHaveBeenCalled();
    });

    it('SUPER_ADMIN with an explicit businessId gets that business', async () => {
      businessRepo.findOne.mockResolvedValue({ ...existingBusiness, id: 'biz-2' });

      const result = await service.getMe({ businessId: 'biz-2' }, superAdmin);

      expect(result).toEqual(expect.objectContaining({ id: 'biz-2' }));
      expect(businessRepo.findOne).toHaveBeenCalledWith({ where: { id: 'biz-2' } });
    });

    it('404s when the resolved business does not exist', async () => {
      businessRepo.findOne.mockResolvedValue(null);

      await expect(service.getMe({}, admin)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateMe', () => {
    it("ADMIN updates their own business", async () => {
      businessRepo.findOne.mockResolvedValue({ ...existingBusiness });

      const result = await service.updateMe({}, { name: 'Brasa 47 Renovado' }, admin);

      expect(businessRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'biz-1', name: 'Brasa 47 Renovado' }),
      );
      expect(result).toEqual(expect.objectContaining({ name: 'Brasa 47 Renovado' }));
    });

    it('ADMIN cannot edit another tenant even by passing a foreign businessId — their own always wins', async () => {
      businessRepo.findOne.mockResolvedValue({ ...existingBusiness });

      await service.updateMe({ businessId: 'other-biz' }, { name: 'Hijack' }, admin);

      // resolveBusinessIdForRead ignores the query for a non-SUPER_ADMIN —
      // the lookup/save still targets the ADMIN's own business only.
      expect(businessRepo.findOne).toHaveBeenCalledWith({ where: { id: 'biz-1' } });
      expect(businessRepo.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'biz-1' }));
    });

    it('SUPER_ADMIN updates a specific business via ?businessId=, following the existing read-resolution pattern', async () => {
      businessRepo.findOne.mockResolvedValue({ ...existingBusiness, id: 'biz-2' });

      await service.updateMe({ businessId: 'biz-2' }, { name: 'Otro Negocio' }, superAdmin);

      expect(businessRepo.findOne).toHaveBeenCalledWith({ where: { id: 'biz-2' } });
      expect(businessRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'biz-2', name: 'Otro Negocio' }),
      );
    });

    it('SUPER_ADMIN without businessId is rejected with 400', async () => {
      await expect(service.updateMe({}, { name: 'x' }, superAdmin)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(businessRepo.findOne).not.toHaveBeenCalled();
    });

    it('a partial PATCH never overwrites fields it did not send', async () => {
      businessRepo.findOne.mockResolvedValue({
        ...existingBusiness,
        address: 'Av. Siempre Viva 123',
        phone: '+56 9 1234 5678',
      });

      await service.updateMe({}, { hours: 'Lun-Dom 12:00-23:00' }, admin);

      expect(businessRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          address: 'Av. Siempre Viva 123',
          phone: '+56 9 1234 5678',
          hours: 'Lun-Dom 12:00-23:00',
        }),
      );
    });
  });

  describe('uploadLogo', () => {
    const file = { buffer: Buffer.from('png-bytes'), size: 100 };

    it('uploads to a path built from the resolved businessId and updates logoUrl', async () => {
      businessRepo.findOne.mockResolvedValue({ ...existingBusiness });
      imageStorage.upload.mockResolvedValue('https://cdn.example/business-logos/biz-1/logo.webp?v=1');

      const result = await service.uploadLogo({}, admin, file);

      expect(imageStorage.upload).toHaveBeenCalledWith('business-logos/biz-1/logo.webp', file);
      expect(businessRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ logoUrl: 'https://cdn.example/business-logos/biz-1/logo.webp?v=1' }),
      );
      expect(result).toEqual(
        expect.objectContaining({ logoUrl: 'https://cdn.example/business-logos/biz-1/logo.webp?v=1' }),
      );
    });

    it('re-uploading replaces the previous logo (new URL overwrites the old one)', async () => {
      businessRepo.findOne.mockResolvedValue({
        ...existingBusiness,
        logoUrl: 'https://cdn.example/business-logos/biz-1/logo.webp?v=1',
      });
      imageStorage.upload.mockResolvedValue('https://cdn.example/business-logos/biz-1/logo.webp?v=2');

      const result = await service.uploadLogo({}, admin, file);

      expect(result).toEqual(
        expect.objectContaining({ logoUrl: 'https://cdn.example/business-logos/biz-1/logo.webp?v=2' }),
      );
    });

    it('propagates a validation/processing rejection from ImageStorageService unchanged (e.g. invalid format)', async () => {
      businessRepo.findOne.mockResolvedValue({ ...existingBusiness });
      const rejection = new Error('IMAGE_INVALID_FORMAT');
      imageStorage.upload.mockRejectedValue(rejection);

      await expect(service.uploadLogo({}, admin, file)).rejects.toBe(rejection);
      expect(businessRepo.save).not.toHaveBeenCalled();
    });

    it("never exposes Supabase credentials — the service only ever passes the path and file to ImageStorageService", async () => {
      businessRepo.findOne.mockResolvedValue({ ...existingBusiness });
      imageStorage.upload.mockResolvedValue('https://cdn.example/business-logos/biz-1/logo.webp?v=1');

      await service.uploadLogo({}, admin, file);

      // BusinessService never touches SUPABASE_SECRET_KEY/config directly —
      // it only calls the injected ImageStorageService with a path + file,
      // confirmed by the mock's exact call signature above (no third
      // argument, nothing resembling a secret).
      expect(imageStorage.upload).toHaveBeenCalledTimes(1);
      expect(imageStorage.upload.mock.calls[0]).toHaveLength(2);
    });

    it('SUPER_ADMIN uploads a logo for a specific business via ?businessId=', async () => {
      businessRepo.findOne.mockResolvedValue({ ...existingBusiness, id: 'biz-2' });
      imageStorage.upload.mockResolvedValue('https://cdn.example/business-logos/biz-2/logo.webp?v=1');

      await service.uploadLogo({ businessId: 'biz-2' }, superAdmin, file);

      expect(imageStorage.upload).toHaveBeenCalledWith('business-logos/biz-2/logo.webp', file);
    });
  });
});
