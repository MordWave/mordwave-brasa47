import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SafeUser } from '../auth/safe-user.js';
import { UserRole } from '../user/user-role.enum.js';
import { AuditLog } from './audit-log.entity.js';
import { AuditService } from './audit.service.js';

function createRepoMock() {
  return {
    create: vi.fn((entity: unknown) => entity),
    save: vi.fn(async (entity: unknown) => entity),
    find: vi.fn(),
  };
}

describe('AuditService', () => {
  let service: AuditService;
  let auditLogRepo: ReturnType<typeof createRepoMock>;

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
    auditLogRepo = createRepoMock();

    const moduleRef = await Test.createTestingModule({
      providers: [AuditService, { provide: getRepositoryToken(AuditLog), useValue: auditLogRepo }],
    }).compile();

    service = moduleRef.get(AuditService);
  });

  describe('record', () => {
    it('saves an entry with sanitized metadata', async () => {
      await service.record({
        businessId: 'biz-1',
        userId: 'admin-1',
        userEmail: 'admin@brasa47.cl',
        action: 'PRODUCT_CREATED',
        entityType: 'Product',
        entityId: 'p1',
        metadata: { name: 'Clásica Brasa', password: 'should-be-stripped' },
        ipAddress: '1.2.3.4',
        userAgent: 'test-agent',
      });

      expect(auditLogRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          businessId: 'biz-1',
          userId: 'admin-1',
          userEmail: 'admin@brasa47.cl',
          action: 'PRODUCT_CREATED',
          entityType: 'Product',
          entityId: 'p1',
          metadata: { name: 'Clásica Brasa' },
          ipAddress: '1.2.3.4',
          userAgent: 'test-agent',
        }),
      );
    });

    it('defaults entityId/ipAddress/userAgent to null when omitted', async () => {
      await service.record({
        businessId: 'biz-1',
        userId: null,
        userEmail: 'admin@brasa47.cl',
        action: 'BUSINESS_UPDATED',
        entityType: 'Business',
      });

      expect(auditLogRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ entityId: null, ipAddress: null, userAgent: null, metadata: {} }),
      );
    });

    it('truncates an oversized userAgent to 2000 characters', async () => {
      const longUserAgent = 'x'.repeat(5000);

      await service.record({
        businessId: 'biz-1',
        userId: 'admin-1',
        userEmail: 'admin@brasa47.cl',
        action: 'PRODUCT_CREATED',
        entityType: 'Product',
        userAgent: longUserAgent,
      });

      const saved = auditLogRepo.save.mock.calls[0][0];
      expect(saved.userAgent).toHaveLength(2000);
      expect(saved.userAgent).toBe(longUserAgent.slice(0, 2000));
    });

    it('leaves a normal-length userAgent untouched', async () => {
      await service.record({
        businessId: 'biz-1',
        userId: 'admin-1',
        userEmail: 'admin@brasa47.cl',
        action: 'PRODUCT_CREATED',
        entityType: 'Product',
        userAgent: 'Mozilla/5.0 (test)',
      });

      expect(auditLogRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ userAgent: 'Mozilla/5.0 (test)' }),
      );
    });

    it('never throws when the repository save rejects — best-effort logging only', async () => {
      auditLogRepo.save.mockRejectedValue(new Error('db down'));

      await expect(
        service.record({
          businessId: 'biz-1',
          userId: 'admin-1',
          userEmail: 'admin@brasa47.cl',
          action: 'PRODUCT_CREATED',
          entityType: 'Product',
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('findAllForBusiness', () => {
    it('ADMIN always sees only their own business, ignoring a foreign businessId in the query', async () => {
      auditLogRepo.find.mockResolvedValue([]);

      await service.findAllForBusiness({ businessId: 'other-biz' }, admin);

      expect(auditLogRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ businessId: 'biz-1' }) }),
      );
    });

    it('SUPER_ADMIN with no businessId gets an unfiltered (all-business) query', async () => {
      auditLogRepo.find.mockResolvedValue([]);

      await service.findAllForBusiness({}, superAdmin);

      const callArgs = auditLogRepo.find.mock.calls[0][0];
      expect(callArgs.where).not.toHaveProperty('businessId');
    });

    it('SUPER_ADMIN can scope to a specific business', async () => {
      auditLogRepo.find.mockResolvedValue([]);

      await service.findAllForBusiness({ businessId: 'biz-2' }, superAdmin);

      expect(auditLogRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ businessId: 'biz-2' }) }),
      );
    });

    it('passes userId/action/entityType/entityId filters through to the query', async () => {
      auditLogRepo.find.mockResolvedValue([]);

      await service.findAllForBusiness(
        { userId: 'admin-1', action: 'PRODUCT_DELETED', entityType: 'Product', entityId: 'p1' },
        admin,
      );

      expect(auditLogRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: 'admin-1',
            action: 'PRODUCT_DELETED',
            entityType: 'Product',
            entityId: 'p1',
          }),
        }),
      );
    });

    it('orders by createdAt DESC, id DESC (stable pagination)', async () => {
      auditLogRepo.find.mockResolvedValue([]);

      await service.findAllForBusiness({}, admin);

      expect(auditLogRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ order: { createdAt: 'DESC', id: 'DESC' } }),
      );
    });

    it('reports hasMore correctly and never leaks the extra probe row', async () => {
      const rows = Array.from({ length: 3 }, (_, i) => ({ id: `log-${i}` }));
      auditLogRepo.find.mockResolvedValue(rows);

      const result = await service.findAllForBusiness({ limit: 2 }, admin);

      expect(result.items).toHaveLength(2);
      expect(result.hasMore).toBe(true);
    });

    it('hasMore is false when there is no extra row', async () => {
      auditLogRepo.find.mockResolvedValue([{ id: 'log-1' }]);

      const result = await service.findAllForBusiness({ limit: 20 }, admin);

      expect(result.items).toHaveLength(1);
      expect(result.hasMore).toBe(false);
    });

    it('defaults to page 1, limit 20 (shared pagination defaults) when none are given', async () => {
      auditLogRepo.find.mockResolvedValue([]);

      await service.findAllForBusiness({}, admin);

      expect(auditLogRepo.find).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 21 }));
    });

    it('applies page/limit as skip/take', async () => {
      auditLogRepo.find.mockResolvedValue([]);

      await service.findAllForBusiness({ page: 3, limit: 10 }, admin);

      expect(auditLogRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 11 }),
      );
    });
  });
});
