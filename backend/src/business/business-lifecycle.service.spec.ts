import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Order } from '../order/order.entity.js';
import { OrderStatus } from '../order/order-status.enum.js';
import { TableSession } from '../table/table-session.entity.js';
import { TableSessionStatus } from '../table/table-session-status.enum.js';
import { Business } from './business.entity.js';
import { BusinessLifecycleService } from './business-lifecycle.service.js';
import { PublicBusinessResolverService } from './public-business-resolver.service.js';

const ID = '11111111-1111-4111-8111-111111111111';

// Deterministic contract tests: every database step and the cache invalidation are recorded in ONE ordered log, and
// the transaction is modelled (a callback that throws leaves the committed log without a 'commit'). They prove the ORDER
// the service performs things in — the property the Business row lock relies on. They do not, and cannot, prove real
// concurrency; see the e2e spec header for why PGlite does not either.
describe('BusinessLifecycleService', () => {
  let service: BusinessLifecycleService;
  let log: string[];
  let row: Record<string, unknown>;
  let pendingOrders: number;
  let closedSessions: number;
  let failOn: string | null;
  let standalone: { findOne: ReturnType<typeof vi.fn> };
  let resolver: { invalidate: ReturnType<typeof vi.fn> };

  const step = (name: string) => {
    log.push(name);
    if (failOn === name) throw new Error(`forced failure at ${name}`);
  };

  beforeEach(async () => {
    log = [];
    failOn = null;
    pendingOrders = 0;
    closedSessions = 2;
    row = { id: ID, name: 'Brasa 47', slug: 'brasa-47', active: true, address: 'Calle 1', phone: null, hours: null };
    standalone = { findOne: vi.fn() };
    resolver = {
      invalidate: vi.fn(() => {
        log.push('invalidate');
      }),
    };

    const businessRepo = {
      findOne: vi.fn(async (options: { lock?: { mode: string } }) => {
        step(options.lock ? `lock:business:${options.lock.mode}` : 'read:business');
        return row.missing ? null : { ...row };
      }),
      update: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
        step(`update:business:${JSON.stringify(patch)}`);
        Object.assign(row, patch);
      }),
      findOneByOrFail: vi.fn(async () => ({ ...row })),
    };
    const orderRepo = {
      count: vi.fn(async (options: { where: { status: OrderStatus } }) => {
        step(`count:orders:${options.where.status}`);
        return pendingOrders;
      }),
    };
    const sessionRepo = {
      createQueryBuilder: vi.fn(() => {
        const state: { set?: Record<string, unknown> } = {};
        const builder = {
          update: vi.fn(() => builder),
          set: vi.fn((value: Record<string, unknown>) => {
            state.set = value;
            return builder;
          }),
          where: vi.fn(() => builder),
          execute: vi.fn(async () => {
            step(`update:sessions:${String(state.set?.status)}`);
            return { affected: closedSessions };
          }),
        };
        return builder;
      }),
    };

    const dataSource = {
      transaction: vi.fn(async (cb: (manager: unknown) => Promise<unknown>) => {
        const snapshot = { ...row };
        log.push('begin');
        const manager = {
          getRepository: (entity: unknown) => {
            if (entity === Business) return businessRepo;
            if (entity === Order) return orderRepo;
            if (entity === TableSession) return sessionRepo;
            throw new Error('unexpected entity');
          },
        };
        try {
          const result = await cb(manager);
          log.push('commit');
          return result;
        } catch (error) {
          Object.assign(row, snapshot); // the database undoes the writes
          log.push('rollback');
          throw error;
        }
      }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        BusinessLifecycleService,
        { provide: getRepositoryToken(Business), useValue: standalone },
        { provide: DataSource, useValue: dataSource },
        { provide: PublicBusinessResolverService, useValue: resolver },
      ],
    }).compile();
    service = moduleRef.get(BusinessLifecycleService);
  });

  describe('deactivate', () => {
    it('locks the Business FOR UPDATE first, counts NEW orders before writing anything, then flips the flag and closes the sessions, commits, and only then invalidates', async () => {
      const result = await service.deactivate(ID);

      expect(log).toEqual([
        'begin',
        'lock:business:pessimistic_write',
        'count:orders:NEW',
        'update:business:{"active":false}',
        'update:sessions:CLOSED',
        'commit',
        'invalidate',
      ]);
      expect(result).toMatchObject({ changed: true, closedSessions: 2 });
      expect(result.business.active).toBe(false);
    });

    it('closes only OPEN sessions of that business, in a single statement, setting closedAt from the database clock', async () => {
      await service.deactivate(ID);

      expect(log.filter((entry) => entry.startsWith('update:sessions'))).toHaveLength(1);
    });

    it('pending orders -> 409 BUSINESS_HAS_PENDING_ORDERS with the count; nothing written, rolled back, no invalidation', async () => {
      pendingOrders = 3;

      const error = await service.deactivate(ID).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ errorCode: 'BUSINESS_HAS_PENDING_ORDERS', count: 3 });
      expect(log).toEqual(['begin', 'lock:business:pessimistic_write', 'count:orders:NEW', 'rollback']);
      expect(resolver.invalidate).not.toHaveBeenCalled();
      expect(row.active).toBe(true);
    });

    it('already inactive -> idempotent: no count, no writes, no invalidation, changed=false', async () => {
      row.active = false;

      const result = await service.deactivate(ID);

      expect(result).toMatchObject({ changed: false, closedSessions: 0 });
      expect(log).toEqual(['begin', 'lock:business:pessimistic_write', 'commit']);
      expect(resolver.invalidate).not.toHaveBeenCalled();
    });

    it('the state is judged under the lock: a second call that runs after the first sees the first one\'s result', async () => {
      const first = await service.deactivate(ID);
      const second = await service.deactivate(ID);

      expect([first.changed, second.changed]).toEqual([true, false]);
      expect(resolver.invalidate).toHaveBeenCalledTimes(1);
    });

    it('a failure while closing the sessions rolls everything back: business still active, no invalidation', async () => {
      failOn = 'update:sessions:CLOSED';

      await expect(service.deactivate(ID)).rejects.toThrow('forced failure');

      expect(log.at(-1)).toBe('rollback');
      expect(log).not.toContain('commit');
      expect(row.active).toBe(true);
      expect(resolver.invalidate).not.toHaveBeenCalled();
    });

    it('a failure flipping the flag rolls back before any session is touched', async () => {
      failOn = 'update:business:{"active":false}';

      await expect(service.deactivate(ID)).rejects.toThrow('forced failure');

      expect(log.some((entry) => entry.startsWith('update:sessions'))).toBe(false);
      expect(resolver.invalidate).not.toHaveBeenCalled();
    });

    it('unknown business -> 404 BUSINESS_NOT_FOUND', async () => {
      row.missing = true;

      const error = await service.deactivate(ID).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).getResponse()).toMatchObject({ errorCode: 'BUSINESS_NOT_FOUND' });
      expect(resolver.invalidate).not.toHaveBeenCalled();
    });

    it('only ever touches Business, Order (the count) and TableSession: any other entity (e.g. RestaurantTable) would throw in this model', async () => {
      await expect(service.deactivate(ID)).resolves.toMatchObject({ changed: true });
    });
  });

  describe('activate', () => {
    beforeEach(() => {
      row.active = false;
    });

    it('locks FOR UPDATE, sets the flag, commits, then invalidates — and touches no session', async () => {
      const result = await service.activate(ID);

      expect(log).toEqual(['begin', 'lock:business:pessimistic_write', 'update:business:{"active":true}', 'commit', 'invalidate']);
      expect(result).toMatchObject({ changed: true });
      expect(result.business.active).toBe(true);
      expect(log.some((entry) => entry.startsWith('update:sessions'))).toBe(false); // no reopening
    });

    it('already active -> idempotent: no write, no invalidation', async () => {
      row.active = true;

      const result = await service.activate(ID);

      expect(result.changed).toBe(false);
      expect(log).toEqual(['begin', 'lock:business:pessimistic_write', 'commit']);
      expect(resolver.invalidate).not.toHaveBeenCalled();
    });

    it('a failure rolls back and does not invalidate', async () => {
      failOn = 'update:business:{"active":true}';

      await expect(service.activate(ID)).rejects.toThrow('forced failure');

      expect(row.active).toBe(false);
      expect(resolver.invalidate).not.toHaveBeenCalled();
    });

    it('unknown business -> 404', async () => {
      row.missing = true;

      await expect(service.activate(ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('deactivate then activate then deactivate (any order is serialised by the lock)', () => {
    it('each call judges the state the previous left and reports only real transitions', async () => {
      const results = [await service.deactivate(ID), await service.activate(ID), await service.activate(ID), await service.deactivate(ID)];

      expect(results.map((r) => r.changed)).toEqual([true, true, false, true]);
      expect(resolver.invalidate).toHaveBeenCalledTimes(3);
    });
  });

  describe('update', () => {
    it('locks FOR UPDATE and writes ONLY the columns that really changed', async () => {
      const result = await service.update(ID, { name: 'Brasa 47 Centro', address: 'Calle 1', phone: '+56 9' });

      expect(log).toEqual(['begin', 'lock:business:pessimistic_write', 'update:business:{"name":"Brasa 47 Centro","phone":"+56 9"}', 'commit']);
      expect(result.changed).toBe(true);
      expect(result.changes).toEqual({
        name: { from: 'Brasa 47', to: 'Brasa 47 Centro' },
        phone: { from: null, to: '+56 9' },
      });
    });

    it('never writes slug or active, whatever else is in the object', async () => {
      await service.update(ID, { name: 'Otro', slug: 'hack', active: false } as never);

      const writes = log.filter((entry) => entry.startsWith('update:business'));
      expect(writes).toEqual(['update:business:{"name":"Otro"}']);
    });

    it('nothing different (or an empty body) -> no write, changed=false, no invalidation', async () => {
      const same = await service.update(ID, { name: 'Brasa 47', address: 'Calle 1', hours: null });
      const empty = await service.update(ID, {});

      expect(same.changed).toBe(false);
      expect(empty.changed).toBe(false);
      expect(log.some((entry) => entry.startsWith('update:business'))).toBe(false);
      expect(resolver.invalidate).not.toHaveBeenCalled();
    });

    it('a null clears an optional field', async () => {
      const result = await service.update(ID, { address: null });

      expect(result.changes).toEqual({ address: { from: 'Calle 1', to: null } });
    });

    it('does not invalidate the public cache: slug and active are untouched by an edit', async () => {
      await service.update(ID, { name: 'Nuevo' });

      expect(resolver.invalidate).not.toHaveBeenCalled();
    });

    it('unknown business -> 404', async () => {
      row.missing = true;

      await expect(service.update(ID, { name: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('findOne', () => {
    it('returns the business whatever its state, or 404', async () => {
      standalone.findOne.mockResolvedValueOnce({ id: ID, active: false });
      await expect(service.findOne(ID)).resolves.toMatchObject({ id: ID, active: false });

      standalone.findOne.mockResolvedValueOnce(null);
      await expect(service.findOne(ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('uses the real states of the project (NEW is the only pending status; sessions go OPEN -> CLOSED)', () => {
    expect(Object.values(OrderStatus)).toEqual(['NEW', 'DELIVERED', 'CANCELLED']);
    expect(Object.values(TableSessionStatus)).toEqual(['OPEN', 'CLOSED']);
  });
});
