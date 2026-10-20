import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { BusinessAdminService } from './business-admin.service.js';

const actor = { id: 'a', email: 'root@x.test', role: 'SUPER_ADMIN', businessId: null, active: true, mustChangePassword: false } as never;
const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'] as const;

const serviceFailingWith = (error: unknown) => {
  const dataSource = { transaction: () => Promise.reject(error) } as unknown as DataSource;
  return new BusinessAdminService({} as never, dataSource, {} as never, {} as never);
};

describe('BusinessAdminService.remove — failures of the transaction itself', () => {
  it.each(['40001', '40P01', '55P03'])('SQLSTATE %s (serialization, deadlock, lock unavailable) is a retryable 409 ADMIN_CONCURRENT_MODIFICATION', async (code) => {
    const service = serviceFailingWith(Object.assign(new Error('db'), { driverError: { code } }));
    const error = await service.remove(ids[0], ids[1], 'a@b.test', actor, {} as never).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({ errorCode: 'ADMIN_CONCURRENT_MODIFICATION' });
  });

  it('any other database error is NOT disguised: it propagates (a 500) so a real fault is never reported as a conflict', async () => {
    const boom = Object.assign(new Error('foreign key'), { driverError: { code: '23503' } });
    await expect(serviceFailingWith(boom).remove(ids[0], ids[1], 'a@b.test', actor, {} as never)).rejects.toBe(boom);
  });
});

// ---- remove(): lock order and concurrency translation, step by step ----------------------------------------------------------
const BUSINESS_ID = ids[0];
const USER_ID = ids[1];
const target = { id: USER_ID, email: 'admin@x.test', role: 'ADMIN', businessId: BUSINESS_ID, active: false, mustChangePassword: true, credentialsVersion: 1 };

function buildRemove(opts: { failAt?: string; error?: unknown; deletedRows?: number } = {}) {
  const calls: string[] = [];
  const step = (name: string) => {
    calls.push(name);
    if (opts.failAt === name) throw opts.error;
  };
  const manager = {
    getRepository: (entity: { name?: string }) => ({
      findOne: async (o: { lock?: { mode: string } }) => {
        if (entity.name === 'Business') {
          step(`lock:business:${o.lock?.mode}`);
          return { id: BUSINESS_ID };
        }
        step(`lock:user:${o.lock?.mode}`);
        return { ...target };
      },
      count: async () => 2,
    }),
    query: async (sql: string) => {
      if (sql.includes('platform_audit_logs')) {
        step('read:platform-trail');
        return [{ n: '0' }];
      }
      if (sql.includes('GROUP BY action')) {
        step('read:history');
        return ['USER_ADMIN_CREATED', 'USER_ADMIN_DEACTIVATED'].map((action) => ({ action, entity_type: 'User', business_id: BUSINESS_ID, email: target.email, n: '1' }));
      }
      step('read:attributed-rows');
      return [{ n: '0' }];
    },
    createQueryBuilder: () => {
      const chain = {
        delete: () => chain,
        from: () => chain,
        where: () => chain,
        returning: () => chain,
        execute: async () => {
          step('delete:user');
          return { raw: Array.from({ length: opts.deletedRows ?? 1 }, () => ({ id: USER_ID })) };
        },
      };
      return chain;
    },
  };
  const transaction = vi.fn((work: (m: unknown) => Promise<unknown>) => work(manager));
  const audit = {
    recordInTransaction: vi.fn(async () => {
      step('audit');
    }),
  };
  const service = new BusinessAdminService({} as never, { transaction } as unknown as DataSource, {} as never, audit as never);
  return { service, calls, transaction, audit };
}

const run = (s: BusinessAdminService) => s.remove(BUSINESS_ID, USER_ID, 'admin@x.test', actor, {} as never);

describe('BusinessAdminService.remove — Business -> User -> reads -> delete -> audit, inside the shared concurrency guard', () => {
  const STEPS = ['lock:business:pessimistic_write', 'lock:user:pessimistic_write', 'read:attributed-rows', 'read:platform-trail', 'read:history', 'delete:user', 'audit'];

  it('takes the business FOR UPDATE first, then the account, and only then judges, deletes and audits', async () => {
    const { service, calls } = buildRemove();
    const result = await run(service);
    expect(calls).toEqual(STEPS);
    expect(result).toEqual({ deleted: true, alreadyDeleted: false, id: USER_ID, email: 'admin@x.test', businessId: BUSINESS_ID });
  });

  it.each(['40001', '40P01', '55P03'])('SQLSTATE %s at ANY step is 409 ADMIN_CONCURRENT_MODIFICATION, in one attempt', async (code) => {
    for (const failAt of STEPS) {
      const { service, transaction } = buildRemove({ failAt, error: Object.assign(new Error(`pg ${code}`), { driverError: { code } }) });
      const error = await run(service).then(
        (value) => ({ resolved: value }),
        (e: unknown) => e,
      );
      expect(error, failAt).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ errorCode: 'ADMIN_CONCURRENT_MODIFICATION' });
      expect(transaction).toHaveBeenCalledTimes(1); // never retried
    }
  });

  it('a conditional DELETE that affects no row is the same 409 (someone changed the account) and writes no audit', async () => {
    const { service, audit } = buildRemove({ deletedRows: 0 });
    const error = await run(service).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({ errorCode: 'ADMIN_CONCURRENT_MODIFICATION' });
    expect(audit.recordInTransaction).not.toHaveBeenCalled();
  });

  it('the audit stays mandatory and is never disguised: its failure propagates as is, with no deletion result', async () => {
    const boom = new Error('audit store down');
    const { service } = buildRemove({ failAt: 'audit', error: boom });
    await expect(run(service)).rejects.toBe(boom);
  });

  it('other database errors (constraint, statement timeout) are not turned into conflicts', async () => {
    for (const [failAt, code] of [['delete:user', '23503'], ['read:history', '57014'], ['lock:user:pessimistic_write', '23505']] as const) {
      const boom = Object.assign(new Error(`pg ${code}`), { driverError: { code } });
      await expect(run(buildRemove({ failAt, error: boom }).service), failAt).rejects.toBe(boom);
    }
  });
});
