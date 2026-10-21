import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '../audit/audit-actions.const.js';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import type { SafeUser } from '../auth/safe-user.js';
import { isBusinessCoverKey } from '../media/media-key.util.js';
import { RATE_LIMIT_POLICY_KEY } from '../rate-limit/rate-limit.decorator.js';
import { UserRole } from '../user/user-role.enum.js';
import { BUSINESS_INACTIVE_ERROR_CODE } from './business-active.js';
import { BUSINESS_CONCURRENT_MODIFICATION, BusinessImageService } from './business-image.service.js';
import { BusinessController } from './business.controller.js';

const BIZ = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const client = { ipAddress: '203.0.113.9', userAgent: 'vitest' };
const file = { buffer: Buffer.from('png'), size: 321 };
const admin: SafeUser = { id: 'admin-1', email: 'a@x.test', role: UserRole.ADMIN, businessId: BIZ, active: true, mustChangePassword: false } as SafeUser;
const superAdmin: SafeUser = { id: 'super-1', email: 's@x.test', role: UserRole.SUPER_ADMIN, businessId: null, active: true, mustChangePassword: false } as SafeUser;
const COVER = `businesses/${BIZ}/cover/33333333-3333-4333-8333-333333333333.webp`;
const LOGO = `businesses/${BIZ}/logo/44444444-4444-4444-8444-444444444444.webp`;

function setup(row: Record<string, unknown> | null = { id: BIZ, active: true, logoStorageKey: null, coverStorageKey: null }) {
  // the row as seen inside the transaction (mutated by update) and the lightweight one used by the pre-checks
  const locked = row ? { ...row } : null;
  const insideRepo = {
    findOne: vi.fn(async () => locked),
    findOneByOrFail: vi.fn(async () => ({ ...locked })),
    update: vi.fn(async (_where: unknown, patch: Record<string, unknown>) => {
      Object.assign(locked!, patch);
    }),
  };
  const manager = { query: vi.fn(async () => undefined), getRepository: vi.fn(() => insideRepo) };
  const outsideRepo = { findOne: vi.fn(async () => (row ? { id: row.id, active: row.active } : null)) };
  const dataSource = {
    getRepository: vi.fn(() => outsideRepo),
    transaction: vi.fn(async (work: (m: typeof manager) => unknown) => work(manager)),
  };
  const imageStorage = { upload: vi.fn(async (key: string) => key) };
  const audit = { recordInTransaction: vi.fn(async () => undefined) };
  const service = new BusinessImageService(dataSource as never, imageStorage as never, audit as never);
  return { service, dataSource, manager, insideRepo, outsideRepo, imageStorage, audit, locked };
}

describe('BusinessImageService', () => {
  let loggerError: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    loggerError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    loggerError.mockClear(); // vi.spyOn returns the same spy on every call: start each test with an empty history
  });

  describe('uploadCover', () => {
    it('validates first, then uploads under a server-built cover key of THIS business, then writes row + audit in one transaction', async () => {
      const { service, dataSource, manager, insideRepo, imageStorage, audit } = setup();
      const business = await service.uploadCover({}, admin, file, client);

      const key = imageStorage.upload.mock.calls[0]![0] as string;
      expect(isBusinessCoverKey(key)).toBe(true);
      expect(key.startsWith(`businesses/${BIZ}/cover/`)).toBe(true);
      expect(imageStorage.upload).toHaveBeenCalledWith(key, file);
      // order: pre-check (outside), upload, transaction
      expect(dataSource.getRepository.mock.invocationCallOrder[0]).toBeLessThan(imageStorage.upload.mock.invocationCallOrder[0]!);
      expect(imageStorage.upload.mock.invocationCallOrder[0]).toBeLessThan(dataSource.transaction.mock.invocationCallOrder[0]!);
      // inside the transaction: bounded lock wait, row lock, one column written
      expect(manager.query).toHaveBeenCalledWith(`SET LOCAL lock_timeout = '5s'`);
      expect(insideRepo.findOne).toHaveBeenCalledWith({ where: { id: BIZ }, lock: { mode: 'pessimistic_write' } });
      expect(insideRepo.update).toHaveBeenCalledWith({ id: BIZ }, { coverStorageKey: key });
      expect(business).toMatchObject({ id: BIZ, coverStorageKey: key });
    });

    it('audits BUSINESS_COVER_UPDATED through the CALLER\'S transaction with minimal metadata (no key, no file name, no URL)', async () => {
      const { service, manager, audit } = setup();
      await service.uploadCover({}, admin, file, client);
      expect(audit.recordInTransaction).toHaveBeenCalledTimes(1);
      const [m, input] = audit.recordInTransaction.mock.calls[0]! as [unknown, Record<string, unknown>];
      expect(m).toBe(manager);
      expect(input).toEqual({
        businessId: BIZ,
        userId: 'admin-1',
        userEmail: 'a@x.test',
        action: AUDIT_ACTIONS.BUSINESS_COVER_UPDATED,
        entityType: AUDIT_ENTITY_TYPES.BUSINESS,
        entityId: BIZ,
        metadata: { sizeBytes: 321, replaced: false },
        ipAddress: '203.0.113.9',
        userAgent: 'vitest',
      });
      expect(JSON.stringify(input)).not.toMatch(/businesses\/|storage|\.webp/);
    });

    it('records replaced: true when the business already had a cover', async () => {
      const { service, audit } = setup({ id: BIZ, active: true, logoStorageKey: null, coverStorageKey: COVER });
      await service.uploadCover({}, admin, file, client);
      expect((audit.recordInTransaction.mock.calls[0]![1] as { metadata: unknown }).metadata).toEqual({ sizeBytes: 321, replaced: true });
    });

    it('an ADMIN always acts on their own business: a businessId in the query is ignored', async () => {
      const { service, imageStorage } = setup();
      await service.uploadCover({ businessId: OTHER }, admin, file, client);
      expect((imageStorage.upload.mock.calls[0]![0] as string).startsWith(`businesses/${BIZ}/`)).toBe(true);
    });

    it('a SUPER_ADMIN must name the business (400, nothing processed) and then acts on exactly that one', async () => {
      const first = setup();
      await expect(first.service.uploadCover({}, superAdmin, file, client)).rejects.toBeInstanceOf(BadRequestException);
      expect(first.imageStorage.upload).not.toHaveBeenCalled();
      expect(first.dataSource.transaction).not.toHaveBeenCalled();

      const second = setup({ id: OTHER, active: true, logoStorageKey: null, coverStorageKey: null });
      await second.service.uploadCover({ businessId: OTHER }, superAdmin, file, client);
      expect((second.imageStorage.upload.mock.calls[0]![0] as string).startsWith(`businesses/${OTHER}/cover/`)).toBe(true);
      expect((second.audit.recordInTransaction.mock.calls[0]![1] as { businessId: string; userId: string }).userId).toBe('super-1');
    });

    it('an ADMIN without a business is refused', async () => {
      const { service, imageStorage } = setup();
      await expect(service.uploadCover({}, { ...admin, businessId: null }, file, client)).rejects.toBeInstanceOf(ForbiddenException);
      expect(imageStorage.upload).not.toHaveBeenCalled();
    });

    it('404 for a business that does not exist, BEFORE any image is processed', async () => {
      const { service, imageStorage, dataSource } = setup(null);
      await expect(service.uploadCover({}, admin, file, client)).rejects.toBeInstanceOf(NotFoundException);
      expect(imageStorage.upload).not.toHaveBeenCalled();
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('a suspended business: an ADMIN is refused (403 BUSINESS_INACTIVE) before any image is processed; a SUPER_ADMIN may proceed', async () => {
      const suspended = { id: BIZ, active: false, logoStorageKey: null, coverStorageKey: null };
      const a = setup(suspended);
      const error = await a.service.uploadCover({}, admin, file, client).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({ errorCode: BUSINESS_INACTIVE_ERROR_CODE });
      expect(a.imageStorage.upload).not.toHaveBeenCalled();
      expect(a.audit.recordInTransaction).not.toHaveBeenCalled();

      const s = setup(suspended);
      await expect(s.service.uploadCover({ businessId: BIZ }, superAdmin, file, client)).resolves.toMatchObject({ id: BIZ });
      expect(s.audit.recordInTransaction).toHaveBeenCalledTimes(1);
    });

    it('a suspension that begins between the checks and the write is honoured UNDER THE LOCK: nothing is written or audited, the upload is logged as an orphan', async () => {
      const { service, insideRepo, audit, outsideRepo } = setup({ id: BIZ, active: false, logoStorageKey: null, coverStorageKey: null });
      outsideRepo.findOne.mockResolvedValue({ id: BIZ, active: true }); // the pre-check still saw it active
      const error = await service.uploadCover({}, admin, file, client).catch((e: unknown) => e);
      expect((error as ForbiddenException).getResponse()).toMatchObject({ errorCode: BUSINESS_INACTIVE_ERROR_CODE });
      expect(insideRepo.update).not.toHaveBeenCalled();
      expect(audit.recordInTransaction).not.toHaveBeenCalled();
      expect(loggerError).toHaveBeenCalledWith(expect.stringMatching(/orphan candidate key=businesses\/.*\/cover\//));
    });

    it('when the image is rejected nothing else happens: no transaction, no write, no audit', async () => {
      const { service, imageStorage, dataSource, audit } = setup();
      imageStorage.upload.mockRejectedValue(new BadRequestException({ errorCode: 'IMAGE_INVALID_FORMAT' }));
      await expect(service.uploadCover({}, admin, file, client)).rejects.toBeInstanceOf(BadRequestException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(audit.recordInTransaction).not.toHaveBeenCalled();
      expect(loggerError).not.toHaveBeenCalled(); // no object was stored, so there is no orphan to report
    });

    it('a bucket failure (502) leaves everything untouched', async () => {
      const { service, imageStorage, dataSource } = setup();
      imageStorage.upload.mockRejectedValue(new BadGatewayException({ errorCode: 'IMAGE_UPLOAD_FAILED' }));
      await expect(service.uploadCover({}, admin, file, client)).rejects.toBeInstanceOf(BadGatewayException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('FAIL-CLOSED audit: if the audit insert fails the error propagates (no success is announced), the row write was inside the same transaction, and the orphan key is logged', async () => {
      const { service, audit, dataSource } = setup();
      audit.recordInTransaction.mockRejectedValue(new Error('audit insert failed'));
      await expect(service.uploadCover({}, admin, file, client)).rejects.toThrow('audit insert failed');
      // the whole unit of work ran in ONE transaction callback: it was rejected, so TypeORM rolls the UPDATE back
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(loggerError).toHaveBeenCalledWith(expect.stringMatching(/Cover uploaded but not saved; orphan candidate key=businesses\//));
      expect(JSON.stringify(loggerError.mock.calls)).not.toMatch(/password|token|secret/i);
    });

    it.each(['40001', '40P01', '55P03'])('SQLSTATE %s becomes 409 BUSINESS_CONCURRENT_MODIFICATION (nothing applied, never retried)', async (code) => {
      const { service, dataSource } = setup();
      dataSource.transaction.mockRejectedValue(Object.assign(new Error('x'), { driverError: { code } }));
      const error = await service.uploadCover({}, admin, file, client).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ errorCode: BUSINESS_CONCURRENT_MODIFICATION });
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it('any other database error keeps propagating unchanged (it is a real fault, not a harmless conflict)', async () => {
      const { service, dataSource } = setup();
      const boom = Object.assign(new Error('connection terminated'), { driverError: { code: '57P01' } });
      dataSource.transaction.mockRejectedValue(boom);
      await expect(service.uploadCover({}, admin, file, client)).rejects.toBe(boom);
    });
  });

  describe('removeCover / removeLogo', () => {
    it('removeCover writes NULL and audits BUSINESS_COVER_REMOVED in the same transaction', async () => {
      const { service, insideRepo, audit, manager, imageStorage } = setup({ id: BIZ, active: true, logoStorageKey: LOGO, coverStorageKey: COVER });
      const business = await service.removeCover({}, admin, client);
      expect(insideRepo.update).toHaveBeenCalledWith({ id: BIZ }, { coverStorageKey: null });
      expect(business).toMatchObject({ coverStorageKey: null, logoStorageKey: LOGO }); // the logo is untouched
      expect(audit.recordInTransaction).toHaveBeenCalledWith(manager, expect.objectContaining({ action: AUDIT_ACTIONS.BUSINESS_COVER_REMOVED, businessId: BIZ, metadata: {} }));
      expect(imageStorage.upload).not.toHaveBeenCalled(); // and nothing touches the bucket (no delete exists)
    });

    it('removeLogo writes NULL to the logo only and audits BUSINESS_LOGO_REMOVED', async () => {
      const { service, insideRepo, audit } = setup({ id: BIZ, active: true, logoStorageKey: LOGO, coverStorageKey: COVER });
      const business = await service.removeLogo({}, admin, client);
      expect(insideRepo.update).toHaveBeenCalledWith({ id: BIZ }, { logoStorageKey: null });
      expect(business).toMatchObject({ logoStorageKey: null, coverStorageKey: COVER });
      expect(audit.recordInTransaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: AUDIT_ACTIONS.BUSINESS_LOGO_REMOVED }));
    });

    it('removing what is not there is a harmless no-op: no write and no audit entry', async () => {
      const { service, insideRepo, audit } = setup();
      await expect(service.removeCover({}, admin, client)).resolves.toMatchObject({ coverStorageKey: null });
      await expect(service.removeLogo({}, admin, client)).resolves.toMatchObject({ logoStorageKey: null });
      expect(insideRepo.update).not.toHaveBeenCalled();
      expect(audit.recordInTransaction).not.toHaveBeenCalled();
    });

    it('fail-closed: a failed audit insert propagates and the removal is not announced', async () => {
      const { service, audit } = setup({ id: BIZ, active: true, logoStorageKey: LOGO, coverStorageKey: COVER });
      audit.recordInTransaction.mockRejectedValue(new Error('audit insert failed'));
      await expect(service.removeCover({}, admin, client)).rejects.toThrow('audit insert failed');
      expect(loggerError).not.toHaveBeenCalled(); // no object was uploaded, nothing to report as orphan
    });

    it('same scoping and state rules as the upload: SUPER_ADMIN needs businessId, suspended + ADMIN is refused, unknown business is 404', async () => {
      await expect(setup().service.removeCover({}, superAdmin, client)).rejects.toBeInstanceOf(BadRequestException);
      const suspended = setup({ id: BIZ, active: false, logoStorageKey: LOGO, coverStorageKey: COVER });
      await expect(suspended.service.removeLogo({}, admin, client)).rejects.toBeInstanceOf(ForbiddenException);
      expect(suspended.insideRepo.update).not.toHaveBeenCalled();
      await expect(suspended.service.removeLogo({ businessId: BIZ }, superAdmin, client)).resolves.toMatchObject({ logoStorageKey: null });
      await expect(setup(null).service.removeCover({}, admin, client)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('route metadata (guards, roles and the upload rate limit are declared on the controller)', () => {
    const proto = BusinessController.prototype as unknown as Record<string, object>;
    it.each(['uploadCover', 'removeCover', 'removeLogo'])('%s is ADMIN/SUPER_ADMIN only', (name) => {
      expect(Reflect.getMetadata(ROLES_KEY, proto[name]!)).toEqual([UserRole.ADMIN, UserRole.SUPER_ADMIN]);
      const guards = Reflect.getMetadata('__guards__', proto[name]!) as Array<{ name: string }>;
      expect(guards.map((g) => g.name)).toEqual(['JwtAuthGuard', 'RolesGuard']);
    });
    it('uploading a cover uses the same per-user "upload" policy as the logo and product images; the cheap removals do not need it', () => {
      expect(Reflect.getMetadata(RATE_LIMIT_POLICY_KEY, proto.uploadCover!)).toBe('upload');
      expect(Reflect.getMetadata(RATE_LIMIT_POLICY_KEY, proto.uploadLogo!)).toBe('upload');
    });
  });
});
