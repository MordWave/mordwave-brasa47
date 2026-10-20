import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SafeUser } from '../auth/safe-user.js';
import { Business } from '../business/business.entity.js';
import { BusinessPresenter } from '../business/business.presenter.js';
import { businessCoverKey } from '../media/media-key.util.js';
import { MediaUrlService } from '../media/media-url.service.js';
import { UserRole } from '../user/user-role.enum.js';
import { RestaurantTable } from './table.entity.js';
import { TableSession } from './table-session.entity.js';
import { TableSessionStatus } from './table-session-status.enum.js';
import { TableSessionService } from './table-session.service.js';

const LOGO_KEY =
  'businesses/aaaaaaaa-1111-4abc-8def-111111111abc/logo/cccccccc-3333-4abc-8def-333333333abc.webp';

function createRepoMock() {
  return {
    findOne: vi.fn(),
    save: vi.fn(async (entity: unknown) => entity),
    create: vi.fn((entity: unknown) => entity),
  };
}

function getErrorBody(error: unknown): Record<string, unknown> {
  return (error as { getResponse: () => Record<string, unknown> }).getResponse();
}

describe('TableSessionService', () => {
  let service: TableSessionService;
  let tableRepo: ReturnType<typeof createRepoMock>;
  let sessionRepo: ReturnType<typeof createRepoMock>;
  let businessRepo: ReturnType<typeof createRepoMock>;
  // What manager.getRepository() hands back inside a transaction — same
  // mocks as the plain injected ones, so a test can set up either the
  // "outside the transaction" or "inside, under lock" read with one mock.
  let dataSource: { transaction: ReturnType<typeof vi.fn> };

  const admin: SafeUser = {
    id: 'admin-1',
    email: 'admin@brasa47.cl',
    role: UserRole.ADMIN,
    businessId: 'biz-1',
    active: true,
  };

  afterEach(() => {
    delete process.env.MEDIA_PUBLIC_BASE_URL;
  });

  beforeEach(async () => {
    process.env.MEDIA_PUBLIC_BASE_URL = 'https://api.example.test';
    tableRepo = createRepoMock();
    sessionRepo = createRepoMock();
    businessRepo = createRepoMock();
    businessRepo.findOne.mockResolvedValue({
      id: 'biz-1',
      slug: 'brasa-47',
      name: 'Brasa 47',
      active: true,
      logoStorageKey: null,
      primaryColor: null,
      accentColor: null,
    });

    // Runs the transaction callback for real against a fake EntityManager,
    // same approach as OrderService's own spec — manager.getRepository()
    // routes to whichever mock matches the entity class asked for.
    dataSource = {
      transaction: vi.fn(async (cb: (manager: unknown) => unknown) => {
        const manager = {
          getRepository: vi.fn((entity: unknown) => {
            if (entity === RestaurantTable) return tableRepo;
            if (entity === TableSession) return sessionRepo;
            if (entity === Business) return businessRepo;
            throw new Error(`unexpected entity in manager.getRepository: ${String(entity)}`);
          }),
        };
        return cb(manager);
      }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        TableSessionService,
        BusinessPresenter,
        MediaUrlService,
        { provide: getRepositoryToken(RestaurantTable), useValue: tableRepo },
        { provide: getRepositoryToken(TableSession), useValue: sessionRepo },
        { provide: getRepositoryToken(Business), useValue: businessRepo },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = moduleRef.get(TableSessionService);
  });

  describe('open', () => {
    it('opens a session for an active table owned by the caller', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'biz-1', active: true });

      const result = await service.open('t1', admin);

      expect(sessionRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ tableId: 't1', businessId: 'biz-1', status: TableSessionStatus.OPEN }),
      );
      expect(result.status).toBe(TableSessionStatus.OPEN);
    });

    it('never returns sessionToken — reserved for the public join endpoint', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'biz-1', active: true });

      const result = await service.open('t1', admin);

      expect(result).not.toHaveProperty('sessionToken');
      expect(sessionRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ sessionToken: expect.any(String) }),
      );
    });

    it('rejects opening a session on an inactive table (re-checked under lock, not just the ownership read)', async () => {
      // Ownership check (outside the transaction) sees an active table...
      tableRepo.findOne.mockResolvedValueOnce({ id: 't1', businessId: 'biz-1', active: true });
      // ...but the locked re-fetch inside the transaction is what actually
      // decides, and here it's inactive (e.g. deactivated in between).
      tableRepo.findOne.mockResolvedValueOnce({ id: 't1', businessId: 'biz-1', active: false });

      const error = await service.open('t1', admin).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(getErrorBody(error)).toEqual(expect.objectContaining({ errorCode: 'TABLE_INACTIVE' }));
      expect(sessionRepo.save).not.toHaveBeenCalled();
    });

    it('locks the RestaurantTable row (pessimistic_write / FOR UPDATE) before checking active', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'biz-1', active: true });

      await service.open('t1', admin);

      // Second call is the locked re-fetch inside the transaction.
      expect(tableRepo.findOne).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ where: { id: 't1' }, lock: { mode: 'pessimistic_write' } }),
      );
    });

    it('rejects an ADMIN opening a session on another business\' table', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'other-biz', active: true });

      await expect(service.open('t1', admin)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404s when the table does not exist', async () => {
      tableRepo.findOne.mockResolvedValue(null);

      await expect(service.open('missing', admin)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('translates a unique-violation (second concurrent open) into 409 TABLE_SESSION_ALREADY_OPEN', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'biz-1', active: true });
      dataSource.transaction.mockRejectedValueOnce(
        Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }),
      );

      const error = await service.open('t1', admin).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ConflictException);
      expect(getErrorBody(error)).toEqual(
        expect.objectContaining({ errorCode: 'TABLE_SESSION_ALREADY_OPEN' }),
      );
    });

    it('does not swallow unrelated transaction failures', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'biz-1', active: true });
      dataSource.transaction.mockRejectedValueOnce(new Error('storage down'));

      await expect(service.open('t1', admin)).rejects.toThrow('storage down');
    });

    it('mints a different sessionToken each time a table is reopened', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'biz-1', active: true });

      await service.open('t1', admin);
      const firstToken = sessionRepo.save.mock.calls[0][0].sessionToken;

      await service.open('t1', admin);
      const secondToken = sessionRepo.save.mock.calls[1][0].sessionToken;

      expect(firstToken).not.toBe(secondToken);
    });
  });

  describe('close', () => {
    it('closes the currently open session, locking the row (pessimistic_write / FOR UPDATE)', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'biz-1', active: true });
      sessionRepo.findOne.mockResolvedValue({
        id: 's1',
        tableId: 't1',
        status: TableSessionStatus.OPEN,
      });

      const result = await service.close('t1', admin);

      expect(sessionRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tableId: 't1', status: TableSessionStatus.OPEN },
          lock: { mode: 'pessimistic_write' },
        }),
      );
      expect(sessionRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: TableSessionStatus.CLOSED, closedAt: expect.any(Date) }),
      );
      expect(result.status).toBe(TableSessionStatus.CLOSED);
    });

    it('rejects closing a table with no open session', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'biz-1', active: true });
      sessionRepo.findOne.mockResolvedValue(null);

      const error = await service.close('t1', admin).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ConflictException);
      expect(getErrorBody(error)).toEqual(
        expect.objectContaining({ errorCode: 'TABLE_SESSION_NOT_OPEN' }),
      );
      expect(sessionRepo.save).not.toHaveBeenCalled();
    });

    it('rejects an ADMIN closing a session on another business\' table', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'other-biz', active: true });

      await expect(service.close('t1', admin)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('join', () => {
    // These two cover resolveOpenSession's shared vagueness guarantee
    // (previously exercised via the now-removed public `resolve` endpoint —
    // join is its only remaining caller).
    it('never reveals which of "table missing" / "inactive" / "no open session" applies', async () => {
      tableRepo.findOne.mockResolvedValue(null);

      const error = await service.join('unknown-token').catch((err: unknown) => err);

      expect(error).toBeInstanceOf(NotFoundException);
      expect(getErrorBody(error)).toEqual(
        expect.objectContaining({ errorCode: 'TABLE_SESSION_UNAVAILABLE' }),
      );
    });

    it('returns TABLE_SESSION_UNAVAILABLE when the table exists but has no open session', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', name: 'Mesa 1', active: true });
      sessionRepo.findOne.mockResolvedValue(null);

      const error = await service.join('qr-abc').catch((err: unknown) => err);

      expect(getErrorBody(error)).toEqual(
        expect.objectContaining({ errorCode: 'TABLE_SESSION_UNAVAILABLE' }),
      );
    });

    it('returns the existing sessionToken, tableName, businessSlug and branding without writing anything', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'biz-1', name: 'Mesa 1', active: true });
      sessionRepo.findOne.mockResolvedValue({
        id: 's1',
        tableId: 't1',
        status: TableSessionStatus.OPEN,
        sessionToken: 'session-xyz',
      });

      const result = await service.join('qr-abc');

      expect(result).toEqual({
        sessionToken: 'session-xyz',
        tableName: 'Mesa 1',
        businessSlug: 'brasa-47',
        businessName: 'Brasa 47',
        logoUrl: null,
        coverUrl: null,
        primaryColor: null,
        accentColor: null,
      });
      expect(sessionRepo.save).not.toHaveBeenCalled();
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('includes the real businessName/logoUrl/primaryColor/accentColor when the business has set them', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'biz-1', name: 'Mesa 1', active: true });
      sessionRepo.findOne.mockResolvedValue({
        id: 's1',
        tableId: 't1',
        status: TableSessionStatus.OPEN,
        sessionToken: 'session-xyz',
      });
      businessRepo.findOne.mockResolvedValue({
        id: 'biz-1',
        slug: 'brasa-47',
        name: 'Brasa 47',
        active: true,
        logoStorageKey: LOGO_KEY,
        primaryColor: '#D94A2B',
        accentColor: '#E9B44C',
      });

      const result = await service.join('qr-abc');

      expect(result).toEqual(
        expect.objectContaining({
          businessName: 'Brasa 47',
          logoUrl: `https://api.example.test/media/${LOGO_KEY}`,
          primaryColor: '#D94A2B',
          accentColor: '#E9B44C',
        }),
      );
    });

    it('returns the stable /media coverUrl when the business has a cover, and never its storage key', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'biz-1', name: 'Mesa 1', active: true });
      sessionRepo.findOne.mockResolvedValue({ id: 's1', tableId: 't1', status: TableSessionStatus.OPEN, sessionToken: 'session-xyz' });
      const coverKey = businessCoverKey('11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333');
      businessRepo.findOne.mockResolvedValue({
        id: 'biz-1',
        slug: 'brasa-47',
        name: 'Brasa 47',
        active: true,
        logoStorageKey: null,
        coverStorageKey: coverKey,
        primaryColor: null,
        accentColor: null,
      });

      const result = await service.join('qr-abc');

      expect(result.coverUrl).toBe(`https://api.example.test/media/${coverKey}`);
      expect(result.logoUrl).toBeNull();
      expect(result).not.toHaveProperty('coverStorageKey');
      expect(JSON.stringify(result)).not.toContain('coverStorageKey');
      expect(Object.keys(result).sort()).toEqual(
        ['accentColor', 'businessName', 'businessSlug', 'coverUrl', 'logoUrl', 'primaryColor', 'sessionToken', 'tableName'],
      );
    });

    it('never returns businessId, tableId or sessionId — only the public slug and branding', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'biz-1', name: 'Mesa 1', active: true });
      sessionRepo.findOne.mockResolvedValue({
        id: 's1',
        tableId: 't1',
        status: TableSessionStatus.OPEN,
        sessionToken: 'session-xyz',
      });

      const result = await service.join('qr-abc');

      expect(result).not.toHaveProperty('businessId');
      expect(result).not.toHaveProperty('tableId');
      expect(result).not.toHaveProperty('id');
      expect(result).not.toHaveProperty('qrToken');
    });

    it('two devices joining the same session get the identical sessionToken', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'biz-1', name: 'Mesa 1', active: true });
      sessionRepo.findOne.mockResolvedValue({
        id: 's1',
        tableId: 't1',
        status: TableSessionStatus.OPEN,
        sessionToken: 'session-xyz',
      });

      const first = await service.join('qr-abc');
      const second = await service.join('qr-abc');

      expect(first.sessionToken).toBe(second.sessionToken);
    });
  });

  describe('status', () => {
    it('reports open:true for a valid, currently-open sessionToken', async () => {
      sessionRepo.findOne.mockResolvedValue({ id: 's1', status: TableSessionStatus.OPEN });

      const result = await service.status('some-session-token');

      expect(result).toEqual({ open: true });
      expect(sessionRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { sessionToken: 'some-session-token', status: TableSessionStatus.OPEN, business: { active: true } },
        }),
      );
    });

    it('reports open:false for an unknown or closed token', async () => {
      sessionRepo.findOne.mockResolvedValue(null);

      const result = await service.status('stale-token');

      expect(result).toEqual({ open: false });
    });
  });

  describe('suspended business (Business.active = false)', () => {
    const inactiveBusiness = { id: 'biz-1', slug: 'brasa-47', name: 'Brasa 47', active: false };

    it('join: a suspended business admits no new session — same vague TABLE_SESSION_UNAVAILABLE, no token', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'biz-1', name: 'Mesa 1', active: true });
      sessionRepo.findOne.mockResolvedValue({ id: 's1', sessionToken: 'tok', status: TableSessionStatus.OPEN });
      businessRepo.findOne.mockResolvedValue(inactiveBusiness);

      const error = await service.join('qr-1').catch((err: unknown) => err);

      expect(error).toBeInstanceOf(NotFoundException);
      expect(getErrorBody(error)).toEqual(expect.objectContaining({ errorCode: 'TABLE_SESSION_UNAVAILABLE' }));
      expect(JSON.stringify(getErrorBody(error))).not.toMatch(/tok|suspend|inactive/i);
    });

    it('join: an active business still joins normally', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'biz-1', name: 'Mesa 1', active: true });
      sessionRepo.findOne.mockResolvedValue({ id: 's1', sessionToken: 'tok', status: TableSessionStatus.OPEN });

      await expect(service.join('qr-1')).resolves.toMatchObject({ sessionToken: 'tok', businessSlug: 'brasa-47' });
    });

    it('status: only an OPEN session of an ACTIVE business reports open', async () => {
      sessionRepo.findOne.mockResolvedValue(null);

      await expect(service.status('tok')).resolves.toEqual({ open: false });
      expect(sessionRepo.findOne).toHaveBeenCalledWith({
        where: { sessionToken: 'tok', status: TableSessionStatus.OPEN, business: { active: true } },
      });

      sessionRepo.findOne.mockResolvedValue({ id: 's1' });
      await expect(service.status('tok')).resolves.toEqual({ open: true });
    });

    it('open: refused with 403 BUSINESS_INACTIVE for an ADMIN and for a SUPER_ADMIN alike; nothing is locked or written after it', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'biz-1', active: true });
      businessRepo.findOne.mockResolvedValue(inactiveBusiness);
      const superAdmin: SafeUser = { id: 'su', email: 'su@mordwave.cl', role: UserRole.SUPER_ADMIN, businessId: null, active: true };

      for (const user of [admin, superAdmin]) {
        tableRepo.findOne.mockClear();
        const error = await service.open('t1', user).catch((err: unknown) => err);

        expect(error).toBeInstanceOf(ForbiddenException);
        expect(getErrorBody(error)).toEqual(expect.objectContaining({ errorCode: 'BUSINESS_INACTIVE' }));
        expect(tableRepo.findOne).toHaveBeenCalledTimes(1); // only the unlocked ownership read, never the locked one
        expect(sessionRepo.save).not.toHaveBeenCalled();
      }
    });

    it('open: locks the Business (FOR SHARE) before the RestaurantTable', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'biz-1', active: true });

      await service.open('t1', admin);

      expect(businessRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'biz-1' }, lock: { mode: 'pessimistic_read' } }),
      );
      // tableRepo.findOne: call 1 = unlocked ownership read, call 2 = the locked one inside the transaction
      expect(businessRepo.findOne.mock.invocationCallOrder[0]).toBeLessThan(tableRepo.findOne.mock.invocationCallOrder[1]!);
    });
  });
});
