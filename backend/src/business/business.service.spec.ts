import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
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
    create: vi.fn((entity: unknown) => ({ ...(entity as object) })),
    save: vi.fn(async (entity: unknown) => entity),
    insert: vi.fn(async () => ({
      identifiers: [{ id: 'new-id' }],
      generatedMaps: [{ id: 'new-id', createdAt: new Date(0), updatedAt: new Date(0) }],
    })),
  };
}

const SLUG_CONSTRAINT = 'UQ_82ca19bc20713fdfa72626a5da0';

describe('BusinessService', () => {
  let service: BusinessService;
  let businessRepo: ReturnType<typeof createRepoMock>;
  let imageStorage: { upload: ReturnType<typeof vi.fn> };

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
    logoStorageKey: null,
    primaryColor: null,
    accentColor: null,
  };

  beforeEach(async () => {
    businessRepo = createRepoMock();
    imageStorage = { upload: vi.fn() };

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
    const BIZ1 = 'aaaaaaaa-1111-4abc-8def-111111111abc';
    const BIZ2 = 'dddddddd-4444-4abc-8def-444444444abc';
    const LOGO_KEY = `businesses/${BIZ1}/logo/cccccccc-3333-4abc-8def-333333333abc.webp`;
    const LOGO_KEY_2 = `businesses/${BIZ1}/logo/eeeeeeee-5555-4abc-8def-555555555abc.webp`;
    const uuidAdmin: SafeUser = { ...admin, businessId: BIZ1 };

    it('uploads under a key built from the resolved businessId and saves logoStorageKey', async () => {
      businessRepo.findOne.mockResolvedValue({ ...existingBusiness, id: BIZ1 });
      imageStorage.upload.mockImplementation(async (key: string) => key);

      const result = await service.uploadLogo({}, uuidAdmin, file);

      const [key, passedFile] = imageStorage.upload.mock.calls[0];
      expect(key).toMatch(new RegExp(`^businesses/${BIZ1}/logo/[0-9a-f-]{36}\\.webp$`));
      expect(passedFile).toBe(file);
      expect(businessRepo.save).toHaveBeenCalledWith(expect.objectContaining({ logoStorageKey: key }));
      expect(result.logoStorageKey).toBe(key);
      expect(businessRepo.save.mock.calls[0][0]).not.toHaveProperty('logoUrl');
    });

    it('re-uploading stores a different key each time (nothing is overwritten or deleted)', async () => {
      businessRepo.findOne.mockResolvedValue({ ...existingBusiness, id: BIZ1, logoStorageKey: LOGO_KEY });
      imageStorage.upload.mockResolvedValue(LOGO_KEY_2);

      const result = await service.uploadLogo({}, uuidAdmin, file);

      expect(result.logoStorageKey).toBe(LOGO_KEY_2);
      expect(imageStorage).not.toHaveProperty('remove');
    });

    it('two uploads ask the storage for two different keys', async () => {
      businessRepo.findOne.mockResolvedValue({ ...existingBusiness, id: BIZ1 });
      imageStorage.upload.mockImplementation(async (key: string) => key);

      await service.uploadLogo({}, uuidAdmin, file);
      await service.uploadLogo({}, uuidAdmin, file);

      expect(imageStorage.upload.mock.calls[0][0]).not.toBe(imageStorage.upload.mock.calls[1][0]);
    });

    it('propagates a validation/processing/storage rejection unchanged and never touches the DB', async () => {
      businessRepo.findOne.mockResolvedValue({ ...existingBusiness, id: BIZ1 });
      const rejection = new Error('IMAGE_INVALID_FORMAT');
      imageStorage.upload.mockRejectedValue(rejection);

      await expect(service.uploadLogo({}, uuidAdmin, file)).rejects.toBe(rejection);
      expect(businessRepo.save).not.toHaveBeenCalled();
    });

    it('a DB failure after a successful upload is reported and deletes nothing', async () => {
      businessRepo.findOne.mockResolvedValue({ ...existingBusiness, id: BIZ1, logoStorageKey: LOGO_KEY_2 });
      imageStorage.upload.mockResolvedValue(LOGO_KEY);
      businessRepo.save.mockRejectedValueOnce(new Error('db down'));

      await expect(service.uploadLogo({}, uuidAdmin, file)).rejects.toThrow('db down');
      expect(imageStorage).not.toHaveProperty('remove');
    });

    it('only passes the key and file to ImageStorageService (no credentials, nothing client-supplied)', async () => {
      businessRepo.findOne.mockResolvedValue({ ...existingBusiness, id: BIZ1 });
      imageStorage.upload.mockResolvedValue(LOGO_KEY);

      await service.uploadLogo({}, uuidAdmin, file);

      expect(imageStorage.upload).toHaveBeenCalledTimes(1);
      expect(imageStorage.upload.mock.calls[0]).toHaveLength(2);
    });

    it('SUPER_ADMIN uploads a logo for a specific business via ?businessId=', async () => {
      businessRepo.findOne.mockResolvedValue({ ...existingBusiness, id: BIZ2 });
      imageStorage.upload.mockImplementation(async (key: string) => key);

      await service.uploadLogo({ businessId: BIZ2 }, superAdmin, file);

      expect(imageStorage.upload.mock.calls[0][0]).toMatch(new RegExp(`^businesses/${BIZ2}/logo/`));
    });
  });

  describe('create', () => {
    const dto = { name: 'Nuevo Grill', slug: 'nuevo-grill' };

    it('inserts exactly the DTO fields plus explicit server-side defaults', async () => {
      const result = await service.create({ ...dto, address: 'Calle 1', phone: '+56 9 0000', hours: 'Lun-Dom' });

      expect(businessRepo.create).toHaveBeenCalledWith({
        name: 'Nuevo Grill',
        slug: 'nuevo-grill',
        active: true,
        address: 'Calle 1',
        phone: '+56 9 0000',
        hours: 'Lun-Dom',
        logoStorageKey: null,
        coverStorageKey: null,
        primaryColor: null,
        accentColor: null,
      });
      expect(businessRepo.insert).toHaveBeenCalledTimes(1);
      expect(businessRepo.save).not.toHaveBeenCalled();
      // the generated id and timestamps come back from the INSERT ... RETURNING
      expect(result).toMatchObject({ id: 'new-id', slug: 'nuevo-grill', createdAt: new Date(0) });
    });

    it('optional fields default to null and no id is ever supplied', async () => {
      await service.create(dto);

      const created = businessRepo.create.mock.calls[0]![0] as Record<string, unknown>;
      expect(created.address).toBeNull();
      expect(created.phone).toBeNull();
      expect(created.hours).toBeNull();
      expect(created).not.toHaveProperty('id');
      expect(businessRepo.findOne).not.toHaveBeenCalled(); // no read-then-write race
    });

    it('a unique violation (23505) becomes 409 BUSINESS_SLUG_TAKEN', async () => {
      businessRepo.insert.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505', constraint: SLUG_CONSTRAINT }));

      const error = await service.create(dto).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ errorCode: 'BUSINESS_SLUG_TAKEN' });
    });

    it('a race: the database lets exactly one INSERT win, every loser becomes 409 and nothing is read first', async () => {
      // Model of N requests for the same slug reaching the INSERT together: UNIQUE(slug) accepts the first and
      // answers every other with 23505. The service must turn exactly those into 409 — and must never have
      // looked the slug up beforehand (a read-then-write check would let two requests both pass).
      let taken = false;
      businessRepo.insert.mockImplementation(async () => {
        await Promise.resolve();
        if (taken) throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505', constraint: SLUG_CONSTRAINT });
        taken = true;
        return { identifiers: [{ id: 'winner' }], generatedMaps: [{ id: 'winner', createdAt: new Date(0), updatedAt: new Date(0) }] };
      });

      const results = await Promise.allSettled(Array.from({ length: 8 }, () => service.create(dto)));

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(rejected).toHaveLength(7);
      for (const r of rejected) {
        expect(r.reason).toBeInstanceOf(ConflictException);
        expect((r.reason as ConflictException).getResponse()).toMatchObject({ errorCode: 'BUSINESS_SLUG_TAKEN' });
      }
      expect(businessRepo.findOne).not.toHaveBeenCalled();
    });

    it.each([
      ['a different unique constraint', { code: '23505', constraint: 'UQ_some_other_constraint' }],
      ['a unique violation with no constraint information', { code: '23505' }],
      ['another integrity error (not null)', { code: '23502', constraint: SLUG_CONSTRAINT }],
    ])('%s is NOT reported as a taken slug', async (_label, fields) => {
      const original = Object.assign(new Error('db error'), fields);
      businessRepo.insert.mockRejectedValueOnce(original);

      const error = await service.create(dto).catch((err: unknown) => err);

      expect(error).toBe(original);
      expect(error).not.toBeInstanceOf(ConflictException);
    });

    it('any other database error is not disguised as a conflict', async () => {
      const boom = Object.assign(new Error('connection lost'), { code: '08006' });
      businessRepo.insert.mockRejectedValueOnce(boom);

      await expect(service.create(dto)).rejects.toBe(boom);
    });
  });
});
