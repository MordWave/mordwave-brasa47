import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { And, DataSource, ILike, In, LessThan, MoreThanOrEqual } from 'typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SafeUser } from '../auth/safe-user.js';
import { Product } from '../product/product.entity.js';
import { RestaurantTable } from '../table/table.entity.js';
import { TableSession } from '../table/table-session.entity.js';
import { TableSessionStatus } from '../table/table-session-status.enum.js';
import { UserRole } from '../user/user-role.enum.js';
import { Order } from './order.entity.js';
import { OrderService } from './order.service.js';
import { OrderStatus } from './order-status.enum.js';

function createRepoMock() {
  return {
    findOne: vi.fn(),
    find: vi.fn(),
    save: vi.fn(async (entity: unknown) => entity),
  };
}

function getErrorBody(error: unknown): Record<string, unknown> {
  return (error as { getResponse: () => Record<string, unknown> }).getResponse();
}

describe('OrderService', () => {
  let service: OrderService;
  let orderRepo: ReturnType<typeof createRepoMock>;
  let productRepo: ReturnType<typeof createRepoMock>;
  let tableSessionRepo: ReturnType<typeof createRepoMock>;
  let tableRepo: ReturnType<typeof createRepoMock>;
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
    orderRepo = createRepoMock();
    productRepo = createRepoMock();
    tableSessionRepo = createRepoMock();
    tableRepo = createRepoMock();

    // Runs the transaction callback for real, against a fake EntityManager
    // whose getRepository() hands back the same mocks — mirrors how
    // OrderService actually uses `manager.getRepository(...)` inside the
    // transaction instead of the plain injected repositories.
    dataSource = {
      transaction: vi.fn(async (cb: (manager: unknown) => unknown) => {
        const manager = {
          getRepository: vi.fn((entity: unknown) => {
            if (entity === Product) return productRepo;
            if (entity === Order) return orderRepo;
            if (entity === TableSession) return tableSessionRepo;
            if (entity === RestaurantTable) return tableRepo;
            throw new Error(`unexpected entity in manager.getRepository: ${String(entity)}`);
          }),
        };
        return cb(manager);
      }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        OrderService,
        { provide: getRepositoryToken(Order), useValue: orderRepo },
        { provide: getRepositoryToken(TableSession), useValue: tableSessionRepo },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = moduleRef.get(OrderService);
  });

  describe('create', () => {
    const baseDto = {
      sessionToken: 'session-abc',
      clientRequestId: 'req-1',
      items: [{ productId: 'p1', quantity: 2, removed: ['Cebolla'], added: ['Tocino'] }],
    };

    const openSession = {
      id: 'sess-1',
      tableId: 't1',
      businessId: 'biz-1',
      sessionToken: 'session-abc',
      status: TableSessionStatus.OPEN,
    };

    const activeTable = { id: 't1', businessId: 'biz-1', name: 'Mesa 7', active: true };

    const validProduct = {
      id: 'p1',
      businessId: 'biz-1',
      name: 'Clásica Brasa',
      price: 6900,
      active: true,
      available: true,
    };

    // Sets up the "everything valid" path through resolveSession (one
    // unlocked call) and the locked re-checks inside the transaction (one
    // call each) — individual tests override specific calls to exercise a
    // rejection branch.
    function mockHappyPathLookups() {
      tableSessionRepo.findOne.mockResolvedValueOnce(openSession); // unlocked pre-check
      tableRepo.findOne.mockResolvedValueOnce(activeTable); // locked, inside tx
      tableSessionRepo.findOne.mockResolvedValueOnce(openSession); // locked, inside tx
      orderRepo.findOne.mockResolvedValueOnce(null); // idempotency check, inside tx
    }

    it('creates an order for a valid, currently-open sessionToken — businessId/table/tableSessionId all come from the session', async () => {
      mockHappyPathLookups();
      productRepo.findOne.mockResolvedValue(validProduct);

      await service.create(baseDto);

      expect(orderRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          businessId: 'biz-1',
          table: 'Mesa 7',
          tableSessionId: 'sess-1',
          status: OrderStatus.NEW,
        }),
      );
    });

    it('two different devices sharing the same sessionToken can create independent orders', async () => {
      tableSessionRepo.findOne.mockResolvedValue(openSession);
      tableRepo.findOne.mockResolvedValue(activeTable);
      orderRepo.findOne.mockResolvedValue(null);
      productRepo.findOne.mockResolvedValue(validProduct);

      await service.create({ ...baseDto, clientRequestId: 'req-device-a' });
      await service.create({ ...baseDto, clientRequestId: 'req-device-b' });

      expect(orderRepo.save).toHaveBeenCalledTimes(2);
      expect(orderRepo.save).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ clientRequestId: 'req-device-a', tableSessionId: 'sess-1' }),
      );
      expect(orderRepo.save).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ clientRequestId: 'req-device-b', tableSessionId: 'sess-1' }),
      );
    });

    it('rejects with 404 TABLE_SESSION_UNAVAILABLE for an unknown sessionToken (also covers a CLOSED session — indistinguishable by design)', async () => {
      tableSessionRepo.findOne.mockResolvedValueOnce(null); // unlocked pre-check: no match

      const error = await service.create(baseDto).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(NotFoundException);
      expect(getErrorBody(error)).toEqual(expect.objectContaining({ errorCode: 'TABLE_SESSION_UNAVAILABLE' }));
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('locks RestaurantTable before TableSession, and rejects if the table is inactive under lock', async () => {
      tableSessionRepo.findOne.mockResolvedValueOnce(openSession); // unlocked pre-check
      tableRepo.findOne.mockResolvedValueOnce({ ...activeTable, active: false }); // locked: inactive

      const error = await service.create(baseDto).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(NotFoundException);
      expect(getErrorBody(error)).toEqual(expect.objectContaining({ errorCode: 'TABLE_SESSION_UNAVAILABLE' }));
      // The locked TableSession lookup must never run once the table check
      // already failed under lock.
      expect(tableSessionRepo.findOne).toHaveBeenCalledTimes(1);
      expect(orderRepo.save).not.toHaveBeenCalled();
    });

    it('re-checks the TableSession under lock — a session closed between the unlocked check and the lock is rejected', async () => {
      tableSessionRepo.findOne.mockResolvedValueOnce(openSession); // unlocked pre-check: still looked valid
      tableRepo.findOne.mockResolvedValueOnce(activeTable); // locked table: fine
      tableSessionRepo.findOne.mockResolvedValueOnce(null); // locked session: closed by now

      const error = await service.create(baseDto).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(NotFoundException);
      expect(getErrorBody(error)).toEqual(expect.objectContaining({ errorCode: 'TABLE_SESSION_UNAVAILABLE' }));
      expect(orderRepo.save).not.toHaveBeenCalled();
    });

    it('locks RestaurantTable strictly before TableSession (lock ordering)', async () => {
      mockHappyPathLookups();
      productRepo.findOne.mockResolvedValue(validProduct);

      await service.create(baseDto);

      // tableRepo.findOne's only call is the locked one inside the
      // transaction; tableSessionRepo.findOne's second call (index 1) is
      // the locked one — the first (index 0) is the unlocked pre-check.
      expect(tableRepo.findOne.mock.invocationCallOrder[0]).toBeLessThan(
        tableSessionRepo.findOne.mock.invocationCallOrder[1],
      );
      expect(tableRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 't1' }, lock: { mode: 'pessimistic_write' } }),
      );
      expect(tableSessionRepo.findOne).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: { sessionToken: 'session-abc', status: TableSessionStatus.OPEN },
          lock: { mode: 'pessimistic_write' },
        }),
      );
    });

    it('checks idempotency only after both locks succeed, and returns the existing order without duplicating it', async () => {
      const existing = { id: 'order-1', businessId: 'biz-1', clientRequestId: 'req-1' };
      tableSessionRepo.findOne.mockResolvedValueOnce(openSession);
      tableRepo.findOne.mockResolvedValueOnce(activeTable);
      tableSessionRepo.findOne.mockResolvedValueOnce(openSession);
      orderRepo.findOne.mockResolvedValueOnce(existing);

      const result = await service.create(baseDto);

      expect(result).toBe(existing);
      expect(orderRepo.save).not.toHaveBeenCalled();
      // The idempotency lookup must come after both locked lookups, not
      // before — see order.service.ts's comment on why.
      expect(orderRepo.findOne.mock.invocationCallOrder[0]).toBeGreaterThan(
        tableSessionRepo.findOne.mock.invocationCallOrder[1],
      );
    });

    it('a retry against a revoked sessionToken fails closed instead of returning the old Order, even if one already exists', async () => {
      tableSessionRepo.findOne.mockResolvedValueOnce(openSession); // unlocked pre-check: still looked valid
      tableRepo.findOne.mockResolvedValueOnce(activeTable);
      tableSessionRepo.findOne.mockResolvedValueOnce(null); // locked: revoked by now

      const error = await service.create(baseDto).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(NotFoundException);
      expect(getErrorBody(error)).toEqual(expect.objectContaining({ errorCode: 'TABLE_SESSION_UNAVAILABLE' }));
      // The idempotency lookup (which would have found the old Order) must
      // never even run once the session fails to re-validate under lock.
      expect(orderRepo.findOne).not.toHaveBeenCalled();
    });

    it('rejects an item whose product does not exist (or belongs to another business), using the session\'s businessId', async () => {
      mockHappyPathLookups();
      productRepo.findOne.mockResolvedValue(null);

      const error = await service.create(baseDto).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(getErrorBody(error)).toEqual(expect.objectContaining({ errorCode: 'PRODUCT_NOT_FOUND' }));
      expect(productRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ businessId: 'biz-1' }) }),
      );
      expect(orderRepo.save).not.toHaveBeenCalled();
    });

    it('rejects an item whose product is not available', async () => {
      mockHappyPathLookups();
      productRepo.findOne.mockResolvedValue({ ...validProduct, available: false });

      const error = await service.create(baseDto).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(getErrorBody(error)).toEqual(
        expect.objectContaining({ errorCode: 'PRODUCT_UNAVAILABLE', productName: 'Clásica Brasa' }),
      );
      expect(orderRepo.save).not.toHaveBeenCalled();
    });

    it('computes the total from the real Product price, ignoring anything price-related the client could have sent', async () => {
      mockHappyPathLookups();
      productRepo.findOne.mockResolvedValue(validProduct);

      await service.create(baseDto);

      expect(orderRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          total: 13800, // 6900 * 2 — CreateOrderItemDto never carries a price at all
          items: [
            expect.objectContaining({
              productId: 'p1',
              name: 'Clásica Brasa',
              unitPrice: 6900,
              quantity: 2,
              removed: ['Cebolla'],
              added: ['Tocino'],
            }),
          ],
        }),
      );
    });

    it('recovers from a racing duplicate submit (unique violation) by returning the order the other request created', async () => {
      const raced = { id: 'order-1', businessId: 'biz-1', clientRequestId: 'req-1' };
      mockHappyPathLookups();
      productRepo.findOne.mockResolvedValue(validProduct);
      orderRepo.save.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505' }));
      orderRepo.findOne.mockResolvedValueOnce(raced); // post-violation recovery lookup

      const result = await service.create(baseDto);

      expect(result).toBe(raced);
    });

    it('does not swallow unrelated save failures', async () => {
      mockHappyPathLookups();
      productRepo.findOne.mockResolvedValue(validProduct);
      orderRepo.save.mockRejectedValueOnce(new Error('storage down'));

      await expect(service.create(baseDto)).rejects.toThrow('storage down');
    });
  });

  describe('findAllAdmin', () => {
    it('ADMIN ignores a foreign businessId from the query and sees only their own', async () => {
      orderRepo.find.mockResolvedValue([]);

      await service.findAllAdmin({ businessId: 'other-biz' }, admin);

      expect(orderRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ businessId: 'biz-1' }), take: 50 }),
      );
    });

    it('SUPER_ADMIN with no businessId gets an unfiltered (all-business) query', async () => {
      orderRepo.find.mockResolvedValue([]);

      await service.findAllAdmin({}, superAdmin);

      const callArgs = orderRepo.find.mock.calls[0][0];
      expect(callArgs.where).not.toHaveProperty('businessId');
    });

    it('passes the status filter and a custom limit through', async () => {
      orderRepo.find.mockResolvedValue([]);

      await service.findAllAdmin({ status: OrderStatus.NEW, limit: 10 }, admin);

      expect(orderRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: OrderStatus.NEW }),
          take: 10,
        }),
      );
    });
  });

  describe('findHistoryAdmin', () => {
    it('defaults to DELIVERED + CANCELLED (never NEW) when no status filter is given', async () => {
      orderRepo.find.mockResolvedValue([]);

      await service.findHistoryAdmin({}, admin);

      expect(orderRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: In([OrderStatus.DELIVERED, OrderStatus.CANCELLED]) }),
        }),
      );
    });

    it('narrows to a single status when one is requested', async () => {
      orderRepo.find.mockResolvedValue([]);

      await service.findHistoryAdmin({ status: OrderStatus.CANCELLED }, admin);

      expect(orderRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: OrderStatus.CANCELLED }) }),
      );
    });

    it('ADMIN ignores a foreign businessId and sees only their own', async () => {
      orderRepo.find.mockResolvedValue([]);

      await service.findHistoryAdmin({ businessId: 'other-biz' }, admin);

      expect(orderRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ businessId: 'biz-1' }) }),
      );
    });

    it('filters by a partial, case-insensitive match on the table snapshot', async () => {
      orderRepo.find.mockResolvedValue([]);

      await service.findHistoryAdmin({ table: 'terraza' }, admin);

      expect(orderRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ table: ILike('%terraza%') }) }),
      );
    });

    it('filters by an inclusive from/to date range', async () => {
      orderRepo.find.mockResolvedValue([]);

      await service.findHistoryAdmin({ from: '2026-01-10', to: '2026-01-12' }, admin);

      expect(orderRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: And(
              MoreThanOrEqual(new Date('2026-01-10')),
              LessThan(new Date('2026-01-13')), // exclusive: the day after `to`
            ),
          }),
        }),
      );
    });

    it('paginates with page/limit, fetching one extra row to detect a next page', async () => {
      orderRepo.find.mockResolvedValue([]);

      await service.findHistoryAdmin({ page: 3, limit: 20 }, admin);

      expect(orderRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 40, take: 21, order: { createdAt: 'DESC' } }),
      );
    });

    it('reports hasMore:true and trims the extra row when more results exist', async () => {
      const rows = Array.from({ length: 21 }, (_, i) => ({ id: `o${i}` }));
      orderRepo.find.mockResolvedValue(rows);

      const result = await service.findHistoryAdmin({ limit: 20 }, admin);

      expect(result.hasMore).toBe(true);
      expect(result.items).toHaveLength(20);
    });

    it('reports hasMore:false when the page is not full', async () => {
      orderRepo.find.mockResolvedValue([{ id: 'o1' }]);

      const result = await service.findHistoryAdmin({ limit: 20 }, admin);

      expect(result.hasMore).toBe(false);
      expect(result.items).toHaveLength(1);
    });
  });

  describe('updateStatus', () => {
    it('allows NEW -> DELIVERED', async () => {
      orderRepo.findOne.mockResolvedValue({ id: 'o1', businessId: 'biz-1', status: OrderStatus.NEW });

      await service.updateStatus('o1', { status: OrderStatus.DELIVERED }, admin);

      expect(orderRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: OrderStatus.DELIVERED }),
      );
    });

    it('allows NEW -> CANCELLED', async () => {
      orderRepo.findOne.mockResolvedValue({ id: 'o1', businessId: 'biz-1', status: OrderStatus.NEW });

      await service.updateStatus('o1', { status: OrderStatus.CANCELLED }, admin);

      expect(orderRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: OrderStatus.CANCELLED }),
      );
    });

    it('rejects a transition out of a terminal status (DELIVERED -> CANCELLED)', async () => {
      orderRepo.findOne.mockResolvedValue({ id: 'o1', businessId: 'biz-1', status: OrderStatus.DELIVERED });

      const error = await service
        .updateStatus('o1', { status: OrderStatus.CANCELLED }, admin)
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ConflictException);
      expect(getErrorBody(error)).toEqual(
        expect.objectContaining({ errorCode: 'INVALID_ORDER_TRANSITION' }),
      );
      expect(orderRepo.save).not.toHaveBeenCalled();
    });

    it('rejects an ADMIN updating an order belonging to another business', async () => {
      orderRepo.findOne.mockResolvedValue({ id: 'o1', businessId: 'other-biz', status: OrderStatus.NEW });

      await expect(
        service.updateStatus('o1', { status: OrderStatus.DELIVERED }, admin),
      ).rejects.toThrow();
      expect(orderRepo.save).not.toHaveBeenCalled();
    });
  });
});
