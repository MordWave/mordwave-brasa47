import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SafeUser } from '../auth/safe-user.js';
import { Business } from '../business/business.entity.js';
import { UserRole } from '../user/user-role.enum.js';
import { RestaurantTable } from './table.entity.js';
import { TableSession } from './table-session.entity.js';
import { TableService } from './table.service.js';

function createRepoMock() {
  return {
    create: vi.fn((entity: unknown) => entity),
    save: vi.fn(async (entity: unknown) => entity),
    findOne: vi.fn(),
    find: vi.fn(),
    exists: vi.fn(),
    softDelete: vi.fn(),
  };
}

function getErrorBody(error: unknown): Record<string, unknown> {
  return (error as { getResponse: () => Record<string, unknown> }).getResponse();
}

describe('TableService', () => {
  let service: TableService;
  let tableRepo: ReturnType<typeof createRepoMock>;
  let businessRepo: ReturnType<typeof createRepoMock>;
  let tableSessionRepo: ReturnType<typeof createRepoMock>;
  let dataSource: { transaction: ReturnType<typeof vi.fn> };

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
    tableRepo = createRepoMock();
    businessRepo = createRepoMock();
    tableSessionRepo = createRepoMock();
    tableSessionRepo.exists.mockResolvedValue(false); // no open session, unless a test says otherwise
    tableSessionRepo.find.mockResolvedValue([]); // no open sessions, unless a test says otherwise

    // update() runs inside a transaction — manager.getRepository() routes
    // to the same mocks as the plain injected ones, same approach as
    // TableSessionService's own spec.
    dataSource = {
      transaction: vi.fn(async (cb: (manager: unknown) => unknown) => {
        const manager = {
          getRepository: vi.fn((entity: unknown) => {
            if (entity === RestaurantTable) return tableRepo;
            if (entity === TableSession) return tableSessionRepo;
            throw new Error(`unexpected entity in manager.getRepository: ${String(entity)}`);
          }),
        };
        return cb(manager);
      }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        TableService,
        { provide: getRepositoryToken(RestaurantTable), useValue: tableRepo },
        { provide: getRepositoryToken(Business), useValue: businessRepo },
        { provide: getRepositoryToken(TableSession), useValue: tableSessionRepo },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = moduleRef.get(TableService);
  });

  describe('create', () => {
    it('ADMIN create ignores a foreign businessId from the body and uses their own', async () => {
      businessRepo.findOne.mockResolvedValue({ id: 'biz-1' });

      await service.create({ name: 'Mesa 1', businessId: 'other-biz' }, admin);

      expect(tableRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Mesa 1', businessId: 'biz-1' }),
      );
    });

    it('defaults active to true when not specified', async () => {
      businessRepo.findOne.mockResolvedValue({ id: 'biz-1' });

      await service.create({ name: 'Mesa 1', businessId: 'biz-1' }, admin);

      expect(tableRepo.save).toHaveBeenCalledWith(expect.objectContaining({ active: true }));
    });

    it('respects an explicit active:false on create', async () => {
      businessRepo.findOne.mockResolvedValue({ id: 'biz-1' });

      await service.create({ name: 'Mesa 1', businessId: 'biz-1', active: false }, admin);

      expect(tableRepo.save).toHaveBeenCalledWith(expect.objectContaining({ active: false }));
    });

    it('rejects create for an ADMIN with no businessId', async () => {
      const adminNoBusiness: SafeUser = { ...admin, businessId: null };

      await expect(
        service.create({ name: 'Mesa 1', businessId: 'biz-1' }, adminNoBusiness),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('never returns qrToken — reserved for the dedicated GET /tables/:id/qr endpoint', async () => {
      businessRepo.findOne.mockResolvedValue({ id: 'biz-1' });

      const result = await service.create({ name: 'Mesa 1', businessId: 'biz-1' }, admin);

      expect(result).not.toHaveProperty('qrToken');
      // It really was generated and persisted — just not handed back here.
      expect(tableRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ qrToken: expect.any(String) }),
      );
    });

    it('generates a qrToken that is neither the table name nor predictable/repeated across tables', async () => {
      businessRepo.findOne.mockResolvedValue({ id: 'biz-1' });

      await service.create({ name: 'Mesa 1', businessId: 'biz-1' }, admin);
      const firstToken = tableRepo.save.mock.calls[0][0].qrToken;

      await service.create({ name: 'Mesa 1', businessId: 'biz-1' }, admin);
      const secondToken = tableRepo.save.mock.calls[1][0].qrToken;

      expect(typeof firstToken).toBe('string');
      expect(firstToken.length).toBeGreaterThan(16);
      expect(firstToken).not.toBe('Mesa 1');
      expect(firstToken).not.toBe(secondToken); // two tables never collide
    });
  });

  describe('findAllAdmin', () => {
    it('ADMIN ignores a foreign businessId from the query and sees only their own', async () => {
      tableRepo.find.mockResolvedValue([]);

      await service.findAllAdmin({ businessId: 'other-biz' }, admin);

      expect(tableRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { businessId: 'biz-1' } }),
      );
    });

    it('SUPER_ADMIN with no businessId gets an unfiltered (all-business) query', async () => {
      tableRepo.find.mockResolvedValue([]);

      await service.findAllAdmin({}, superAdmin);

      const callArgs = tableRepo.find.mock.calls[0][0];
      expect(callArgs.where).not.toHaveProperty('businessId');
    });

    it('SUPER_ADMIN can scope to a specific business', async () => {
      tableRepo.find.mockResolvedValue([]);

      await service.findAllAdmin({ businessId: 'biz-2' }, superAdmin);

      expect(tableRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { businessId: 'biz-2' } }),
      );
    });

    it('never returns qrToken in the listing', async () => {
      tableRepo.find.mockResolvedValue([
        { id: 't1', businessId: 'biz-1', name: 'Mesa 1', active: true, qrToken: 'secret-token' },
      ]);

      const result = await service.findAllAdmin({}, admin);

      expect(result[0]).not.toHaveProperty('qrToken');
    });

    it('marks a table sessionOpen:true with its openedAt when it has an OPEN session', async () => {
      const openedAt = new Date('2026-01-01T20:14:00Z');
      tableRepo.find.mockResolvedValue([
        { id: 't1', businessId: 'biz-1', name: 'Mesa 1', active: true },
      ]);
      tableSessionRepo.find.mockResolvedValue([
        { id: 's1', tableId: 't1', status: 'OPEN', openedAt },
      ]);

      const result = await service.findAllAdmin({}, admin);

      expect(result).toEqual([
        { id: 't1', name: 'Mesa 1', active: true, sessionOpen: true, openedAt },
      ]);
    });

    it('marks a table sessionOpen:false with openedAt:null when it has no OPEN session', async () => {
      tableRepo.find.mockResolvedValue([
        { id: 't1', businessId: 'biz-1', name: 'Mesa 1', active: true },
      ]);
      tableSessionRepo.find.mockResolvedValue([]);

      const result = await service.findAllAdmin({}, admin);

      expect(result).toEqual([
        { id: 't1', name: 'Mesa 1', active: true, sessionOpen: false, openedAt: null },
      ]);
    });

    it('never returns businessId, and skips the session lookup entirely for an empty table list', async () => {
      tableRepo.find.mockResolvedValue([]);

      const result = await service.findAllAdmin({}, admin);

      expect(result).toEqual([]);
      expect(tableSessionRepo.find).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('updates name/active for a table the ADMIN owns', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'biz-1', name: 'Mesa 1', active: true });

      await service.update('t1', { name: 'Terraza 1', active: false }, admin);

      expect(tableRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Terraza 1', active: false }),
      );
    });

    it('locks the RestaurantTable row (pessimistic_write / FOR UPDATE) before writing', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'biz-1', name: 'Mesa 1', active: true });

      await service.update('t1', { name: 'Terraza 1' }, admin);

      // Second call is the locked re-fetch inside the transaction (the
      // first is the unlocked ownership check).
      expect(tableRepo.findOne).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ where: { id: 't1' }, lock: { mode: 'pessimistic_write' } }),
      );
    });

    it('rejects an ADMIN updating a table belonging to another business', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'other-biz' });

      await expect(service.update('t1', { name: 'x' }, admin)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(tableRepo.save).not.toHaveBeenCalled();
    });

    it('SUPER_ADMIN can update a table in any business', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'other-biz', name: 'Mesa 1' });

      await service.update('t1', { name: 'Mesa renombrada' }, superAdmin);

      expect(tableRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Mesa renombrada' }),
      );
    });

    it('blocks deactivating a table that has an open session', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'biz-1', active: true });
      tableSessionRepo.exists.mockResolvedValue(true);

      const error = await service.update('t1', { active: false }, admin).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ConflictException);
      expect(getErrorBody(error)).toEqual(
        expect.objectContaining({ errorCode: 'TABLE_HAS_OPEN_SESSION' }),
      );
      expect(tableSessionRepo.exists).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tableId: 't1', status: 'OPEN' } }),
      );
      expect(tableRepo.save).not.toHaveBeenCalled();
    });

    it('allows deactivating a table with no open session', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'biz-1', active: true });
      tableSessionRepo.exists.mockResolvedValue(false);

      await service.update('t1', { active: false }, admin);

      expect(tableRepo.save).toHaveBeenCalledWith(expect.objectContaining({ active: false }));
    });

    it('does not check for an open session on an unrelated edit to an already-active table', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'biz-1', active: true, name: 'Mesa 1' });

      await service.update('t1', { name: 'Mesa renombrada' }, admin);

      expect(tableSessionRepo.exists).not.toHaveBeenCalled();
    });

    it('allows reactivating a table without checking for an open session', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'biz-1', active: false });

      await service.update('t1', { active: true }, admin);

      expect(tableSessionRepo.exists).not.toHaveBeenCalled();
      expect(tableRepo.save).toHaveBeenCalledWith(expect.objectContaining({ active: true }));
    });
  });

  describe('getQr', () => {
    it('returns only the qrToken for a table the ADMIN owns', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'biz-1', qrToken: 'qr-abc' });

      const result = await service.getQr('t1', admin);

      expect(result).toEqual({ qrToken: 'qr-abc' });
    });

    it('rejects an ADMIN requesting the QR of another business\' table', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'other-biz', qrToken: 'qr-abc' });

      await expect(service.getQr('t1', admin)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404s when the table does not exist', async () => {
      tableRepo.findOne.mockResolvedValue(null);

      await expect(service.getQr('missing', admin)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('rotateQr', () => {
    it('replaces the qrToken and persists it', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'biz-1', qrToken: 'old-qr' });

      const result = await service.rotateQr('t1', admin);

      expect(result.qrToken).not.toBe('old-qr');
      expect(typeof result.qrToken).toBe('string');
      expect(tableRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 't1', qrToken: result.qrToken }),
      );
    });

    it('never touches TableSession — no session is opened/closed by rotating the QR', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'biz-1', qrToken: 'old-qr' });

      await service.rotateQr('t1', admin);

      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(tableSessionRepo.save).not.toHaveBeenCalled();
      expect(tableSessionRepo.exists).not.toHaveBeenCalled();
    });

    it('rejects an ADMIN rotating the QR of another business\' table', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'other-biz', qrToken: 'old-qr' });

      await expect(service.rotateQr('t1', admin)).rejects.toBeInstanceOf(ForbiddenException);
      expect(tableRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('soft-deletes a table the ADMIN owns with no open session', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'biz-1' });
      tableSessionRepo.exists.mockResolvedValue(false);

      await service.remove('t1', admin);

      expect(tableRepo.softDelete).toHaveBeenCalledWith('t1');
    });

    it('locks the RestaurantTable row (pessimistic_write / FOR UPDATE) before deleting', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'biz-1' });
      tableSessionRepo.exists.mockResolvedValue(false);

      await service.remove('t1', admin);

      // Second call is the locked re-fetch inside the transaction (the
      // first is the unlocked ownership check).
      expect(tableRepo.findOne).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ where: { id: 't1' }, lock: { mode: 'pessimistic_write' } }),
      );
    });

    it('rejects deleting a table with an open session', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'biz-1' });
      tableSessionRepo.exists.mockResolvedValue(true);

      const error = await service.remove('t1', admin).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ConflictException);
      expect(getErrorBody(error)).toEqual(
        expect.objectContaining({ errorCode: 'TABLE_HAS_OPEN_SESSION' }),
      );
      expect(tableSessionRepo.exists).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tableId: 't1', status: 'OPEN' } }),
      );
      expect(tableRepo.softDelete).not.toHaveBeenCalled();
    });

    it('allows deleting an already-inactive (closed) table', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'biz-1', active: false });
      tableSessionRepo.exists.mockResolvedValue(false);

      await service.remove('t1', admin);

      expect(tableRepo.softDelete).toHaveBeenCalledWith('t1');
    });

    it('rejects an ADMIN deleting a table belonging to another business', async () => {
      tableRepo.findOne.mockResolvedValue({ id: 't1', businessId: 'other-biz' });

      await expect(service.remove('t1', admin)).rejects.toBeInstanceOf(ForbiddenException);
      expect(tableRepo.softDelete).not.toHaveBeenCalled();
    });

    it('404s when the table does not exist', async () => {
      tableRepo.findOne.mockResolvedValue(null);

      await expect(service.remove('missing', admin)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
