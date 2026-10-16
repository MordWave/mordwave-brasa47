import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Category } from '../category/category.entity.js';
import { Product } from '../product/product.entity.js';
import { RestaurantTable } from '../table/table.entity.js';
import { User } from '../user/user.entity.js';
import type { SafeUser } from '../auth/safe-user.js';
import { UserRole } from '../user/user-role.enum.js';
import { Business } from './business.entity.js';
import { BusinessLimitsService } from './business-limits.service.js';

const LIMITS = { product: 500, category: 50, table: 200, user: 20 };
const ADMIN: Pick<SafeUser, 'role'> = { role: UserRole.ADMIN };
const SUPER_ADMIN: Pick<SafeUser, 'role'> = { role: UserRole.SUPER_ADMIN };

describe('BusinessLimitsService', () => {
  let service: BusinessLimitsService;
  let calls: string[];
  let businessRepo: { findOne: ReturnType<typeof vi.fn> };
  let countRepos: Map<unknown, { count: ReturnType<typeof vi.fn> }>;
  let manager: EntityManager;
  let getRepository: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    calls = [];
    businessRepo = {
      findOne: vi.fn(async () => {
        calls.push('lock');
        return { id: 'biz-1', active: true };
      }),
    };
    countRepos = new Map(
      [Product, Category, RestaurantTable, User].map((entity) => [
        entity,
        {
          count: vi.fn(async () => {
            calls.push(`count:${(entity as { name: string }).name}`);
            return 0;
          }),
        },
      ]),
    );
    getRepository = vi.fn((entity: unknown) => {
      if (entity === Business) return businessRepo;
      const repo = countRepos.get(entity);
      if (!repo) throw new Error(`unexpected entity: ${String(entity)}`);
      return repo;
    });
    manager = { getRepository } as unknown as EntityManager;
    service = new BusinessLimitsService({ business: { ...LIMITS } });
  });

  describe('assertCanCreate', () => {
    it('locks the Business row FOR UPDATE (pessimistic_write) BEFORE counting', async () => {
      await service.assertCanCreate(manager, 'biz-1', 'product', ADMIN);

      expect(businessRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'biz-1' },
        lock: { mode: 'pessimistic_write' },
      });
      expect(calls).toEqual(['lock', 'count:Product']);
    });

    it('counts only that Business’s rows (tenant isolation)', async () => {
      await service.assertCanCreate(manager, 'biz-1', 'category', ADMIN);

      expect(countRepos.get(Category)!.count).toHaveBeenCalledWith({ where: { businessId: 'biz-1' } });
    });

    it.each([
      ['product', Product],
      ['category', Category],
      ['table', RestaurantTable],
      ['user', User],
    ] as const)('counts the right entity for %s', async (resource, entity) => {
      await service.assertCanCreate(manager, 'biz-1', resource, ADMIN);

      expect(countRepos.get(entity)!.count).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['product', 500, 'BUSINESS_PRODUCT_LIMIT_REACHED'],
      ['category', 50, 'BUSINESS_CATEGORY_LIMIT_REACHED'],
      ['table', 200, 'BUSINESS_TABLE_LIMIT_REACHED'],
      ['user', 20, 'BUSINESS_USER_LIMIT_REACHED'],
    ] as const)('allows one below the %s limit and rejects at it', async (resource, limit, errorCode) => {
      const entity = { product: Product, category: Category, table: RestaurantTable, user: User }[resource];

      countRepos.get(entity)!.count.mockResolvedValue(limit - 1);
      await expect(service.assertCanCreate(manager, 'biz-1', resource, ADMIN)).resolves.toBeUndefined();

      countRepos.get(entity)!.count.mockResolvedValue(limit);
      const error = await service.assertCanCreate(manager, 'biz-1', resource, ADMIN).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getStatus()).toBe(409);
      expect((error as ConflictException).getResponse()).toEqual({
        message: expect.stringContaining(String(limit)),
        errorCode,
        limit,
      });
    });

    it('exposes nothing internal: only message, errorCode and limit — no counts, ids or tenant data', async () => {
      countRepos.get(Product)!.count.mockResolvedValue(9999);

      const error = (await service.assertCanCreate(manager, 'biz-1', 'product', ADMIN).catch((e: unknown) => e)) as ConflictException;
      const body = error.getResponse() as Record<string, unknown>;

      expect(Object.keys(body).sort()).toEqual(['errorCode', 'limit', 'message']);
      expect(JSON.stringify(body)).not.toContain('biz-1');
      expect(JSON.stringify(body)).not.toContain('9999');
    });

    it('supports reserving several slots at once', async () => {
      countRepos.get(Product)!.count.mockResolvedValue(498);

      await expect(service.assertCanCreate(manager, 'biz-1', 'product', ADMIN, 2)).resolves.toBeUndefined();
      await expect(service.assertCanCreate(manager, 'biz-1', 'product', ADMIN, 3)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('404s for a Business that does not exist, without counting anything', async () => {
      businessRepo.findOne.mockResolvedValue(null);

      await expect(service.assertCanCreate(manager, 'nope', 'product', ADMIN)).rejects.toBeInstanceOf(NotFoundException);
      expect(countRepos.get(Product)!.count).not.toHaveBeenCalled();
    });

    it('uses the configured limit, not a hardcoded one', async () => {
      service = new BusinessLimitsService({ business: { ...LIMITS, product: 3 } });
      countRepos.get(Product)!.count.mockResolvedValue(3);

      await expect(service.assertCanCreate(manager, 'biz-1', 'product', ADMIN)).rejects.toBeInstanceOf(ConflictException);
    });

    it('logs a warning when the limit is hit (no PII)', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      countRepos.get(Product)!.count.mockResolvedValue(500);

      await service.assertCanCreate(manager, 'biz-1', 'product', ADMIN).catch(() => undefined);

      expect(warn).toHaveBeenCalledWith('business_limit_reached businessId=biz-1 resource=product limit=500');
      warn.mockRestore();
    });
  });

  describe('getLimit', () => {
    it('returns the configured limit per resource', () => {
      expect(service.getLimit('product')).toBe(500);
      expect(service.getLimit('category')).toBe(50);
      expect(service.getLimit('table')).toBe(200);
      expect(service.getLimit('user')).toBe(20);
    });
  });

  describe('getListFetchSize', () => {
    it('is one more than the limit, per resource (the extra row is the truncation probe)', () => {
      expect(service.getListFetchSize('product')).toBe(501);
      expect(service.getListFetchSize('category')).toBe(51);
      expect(service.getListFetchSize('table')).toBe(201);
    });
  });

  describe('capList', () => {
    const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i }));
    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      warn.mockRestore();
    });

    it('below the limit: returns the rows untouched and logs nothing', () => {
      const rows = rowsOf(499);

      expect(service.capList('product', 'biz-1', rows)).toBe(rows);
      expect(warn).not.toHaveBeenCalled();
    });

    it('exactly at the limit: returns every row and does NOT log a truncation', () => {
      const rows = rowsOf(500);

      const result = service.capList('product', 'biz-1', rows);

      expect(result).toHaveLength(500);
      expect(warn).not.toHaveBeenCalled();
    });

    it('above the limit (the probe row exists): returns only the first `limit`, in order, and logs once', () => {
      const rows = rowsOf(501);

      const result = service.capList('product', 'biz-1', rows);

      expect(result).toHaveLength(500);
      expect(result[0]).toEqual({ id: 0 });
      expect(result.at(-1)).toEqual({ id: 499 });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('business_list_capped businessId=biz-1 resource=product cap=500');
    });

    it('uses each resource’s own limit', () => {
      expect(service.capList('category', 'biz-1', rowsOf(50))).toHaveLength(50);
      expect(warn).not.toHaveBeenCalled();

      expect(service.capList('category', 'biz-1', rowsOf(51))).toHaveLength(50);
      expect(warn).toHaveBeenCalledWith('business_list_capped businessId=biz-1 resource=category cap=50');

      expect(service.capList('table', 'biz-1', rowsOf(201))).toHaveLength(200);
      expect(warn).toHaveBeenLastCalledWith('business_list_capped businessId=biz-1 resource=table cap=200');
    });

    it('labels an unscoped (SUPER_ADMIN, all businesses) list as "all"', () => {
      service.capList('table', undefined, rowsOf(201));

      expect(warn).toHaveBeenCalledWith('business_list_capped businessId=all resource=table cap=200');
    });

    it('does not issue any query: it is a pure function over the rows it is given', () => {
      service.capList('product', 'biz-1', rowsOf(501));

      expect(getRepository).not.toHaveBeenCalled();
    });

    describe('suspended business (Business.active = false) — judged on the locked row', () => {
      beforeEach(() => {
        businessRepo.findOne.mockImplementation(async () => {
          calls.push('lock');
          return { id: 'biz-1', active: false };
        });
      });

      it.each(['product', 'category', 'table', 'user'] as const)('ADMIN cannot create a %s: 403 BUSINESS_INACTIVE, nothing is counted', async (resource) => {
        const error = await service.assertCanCreate(manager, 'biz-1', resource, ADMIN).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ForbiddenException);
        expect((error as ForbiddenException).getResponse()).toMatchObject({ errorCode: 'BUSINESS_INACTIVE' });
        expect(calls).toEqual(['lock']);
      });

      it('SUPER_ADMIN keeps managing a suspended business: allowed, and the quota still applies to them', async () => {
        await expect(service.assertCanCreate(manager, 'biz-1', 'product', SUPER_ADMIN)).resolves.toBeUndefined();
        expect(calls).toEqual(['lock', 'count:Product']);

        countRepos.get(Product)!.count.mockResolvedValue(500);
        await expect(service.assertCanCreate(manager, 'biz-1', 'product', SUPER_ADMIN)).rejects.toBeInstanceOf(ConflictException);
      });

      it('the suspension is reported before the quota (an ADMIN at the limit of a suspended business gets 403, not 409)', async () => {
        countRepos.get(Product)!.count.mockResolvedValue(9999);

        await expect(service.assertCanCreate(manager, 'biz-1', 'product', ADMIN)).rejects.toBeInstanceOf(ForbiddenException);
      });

      it('any role other than SUPER_ADMIN is subject to it (fails closed)', async () => {
        await expect(service.assertCanCreate(manager, 'biz-1', 'product', { role: 'FUTURE_ROLE' as UserRole })).rejects.toBeInstanceOf(ForbiddenException);
      });
    });

    describe('active business: current behaviour is unchanged', () => {
      it('ADMIN and SUPER_ADMIN pass, locking the Business FIRST and counting after; the limits still apply', async () => {
        await service.assertCanCreate(manager, 'biz-1', 'category', ADMIN);
        await service.assertCanCreate(manager, 'biz-1', 'category', SUPER_ADMIN);
        expect(calls).toEqual(['lock', 'count:Category', 'lock', 'count:Category']);

        countRepos.get(Category)!.count.mockResolvedValue(50);
        await expect(service.assertCanCreate(manager, 'biz-1', 'category', ADMIN)).rejects.toBeInstanceOf(ConflictException);
      });

      it('takes the row with FOR UPDATE (pessimistic_write) and reads Business.active from that same locked read', async () => {
        await service.assertCanCreate(manager, 'biz-1', 'table', ADMIN);

        expect(businessRepo.findOne).toHaveBeenCalledTimes(1);
        expect(businessRepo.findOne).toHaveBeenCalledWith({ where: { id: 'biz-1' }, lock: { mode: 'pessimistic_write' } });
      });
    });
  });
});
