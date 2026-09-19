import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SafeUser } from '../auth/safe-user.js';
import { PublicBusinessResolverService } from '../business/public-business-resolver.service.js';
import { Product } from '../product/product.entity.js';
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
  let publicBusinessResolver: { resolve: ReturnType<typeof vi.fn> };
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
    publicBusinessResolver = { resolve: vi.fn() };

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
        { provide: DataSource, useValue: dataSource },
        { provide: PublicBusinessResolverService, useValue: publicBusinessResolver },
      ],
    }).compile();

    service = moduleRef.get(OrderService);
  });

  describe('create', () => {
    const baseDto = {
      businessSlug: 'brasa-47',
      clientRequestId: 'req-1',
      table: '7',
      items: [{ productId: 'p1', quantity: 2, removed: ['Cebolla'], added: ['Tocino'] }],
    };

    it('is idempotent: returns the existing order for the same businessId + clientRequestId without opening a transaction', async () => {
      publicBusinessResolver.resolve.mockResolvedValue('biz-1');
      const existing = { id: 'order-1', businessId: 'biz-1', clientRequestId: 'req-1' };
      orderRepo.findOne.mockResolvedValue(existing);

      const result = await service.create(baseDto);

      expect(result).toBe(existing);
      expect(orderRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { businessId: 'biz-1', clientRequestId: 'req-1' } }),
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('never matches an existing order by clientRequestId alone across businesses (composite lookup only)', async () => {
      publicBusinessResolver.resolve.mockResolvedValue('biz-1');
      orderRepo.findOne.mockResolvedValue(null);
      productRepo.findOne.mockResolvedValue({
        id: 'p1',
        businessId: 'biz-1',
        name: 'Clásica Brasa',
        price: 6900,
        active: true,
        available: true,
      });

      await service.create(baseDto);

      // Every findOne against the composite key includes businessId — a
      // clientRequestId collision with another tenant's order can never
      // match this where clause.
      for (const call of orderRepo.findOne.mock.calls) {
        expect(call[0].where).toEqual(
          expect.objectContaining({ businessId: 'biz-1', clientRequestId: 'req-1' }),
        );
      }
    });

    it('computes the total from the real Product price, ignoring anything price-related the client could have sent', async () => {
      publicBusinessResolver.resolve.mockResolvedValue('biz-1');
      orderRepo.findOne.mockResolvedValue(null);
      productRepo.findOne.mockResolvedValue({
        id: 'p1',
        businessId: 'biz-1',
        name: 'Clásica Brasa',
        price: 6900,
        active: true,
        available: true,
      });

      await service.create(baseDto);

      expect(orderRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          total: 13800, // 6900 * 2 — CreateOrderItemDto never carries a price at all
          status: OrderStatus.NEW,
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

    it('rejects an item whose product does not exist (or belongs to another business)', async () => {
      publicBusinessResolver.resolve.mockResolvedValue('biz-1');
      orderRepo.findOne.mockResolvedValue(null);
      productRepo.findOne.mockResolvedValue(null);

      const error = await service.create(baseDto).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(getErrorBody(error)).toEqual(expect.objectContaining({ errorCode: 'PRODUCT_NOT_FOUND' }));
      expect(orderRepo.save).not.toHaveBeenCalled();
    });

    it('rejects an item whose product is not available', async () => {
      publicBusinessResolver.resolve.mockResolvedValue('biz-1');
      orderRepo.findOne.mockResolvedValue(null);
      productRepo.findOne.mockResolvedValue({
        id: 'p1',
        businessId: 'biz-1',
        name: 'Clásica Brasa',
        price: 6900,
        active: true,
        available: false,
      });

      const error = await service.create(baseDto).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(getErrorBody(error)).toEqual(
        expect.objectContaining({ errorCode: 'PRODUCT_UNAVAILABLE', productName: 'Clásica Brasa' }),
      );
      expect(orderRepo.save).not.toHaveBeenCalled();
    });

    it('recovers from a racing duplicate submit (unique violation) by returning the order the other request created', async () => {
      publicBusinessResolver.resolve.mockResolvedValue('biz-1');
      const raced = { id: 'order-1', businessId: 'biz-1', clientRequestId: 'req-1' };
      // First lookup (pre-transaction fast path): nothing yet. Second
      // lookup (post-violation recovery): the row the other request won.
      orderRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(raced);
      productRepo.findOne.mockResolvedValue({
        id: 'p1',
        businessId: 'biz-1',
        name: 'Clásica Brasa',
        price: 6900,
        active: true,
        available: true,
      });
      dataSource.transaction.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505' }));

      const result = await service.create(baseDto);

      expect(result).toBe(raced);
      expect(orderRepo.findOne).toHaveBeenCalledTimes(2);
    });

    it('does not swallow unrelated transaction failures', async () => {
      publicBusinessResolver.resolve.mockResolvedValue('biz-1');
      orderRepo.findOne.mockResolvedValue(null);
      productRepo.findOne.mockResolvedValue({
        id: 'p1',
        businessId: 'biz-1',
        name: 'Clásica Brasa',
        price: 6900,
        active: true,
        available: true,
      });
      dataSource.transaction.mockRejectedValueOnce(new Error('storage down'));

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
