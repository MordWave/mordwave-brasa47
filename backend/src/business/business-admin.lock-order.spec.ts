import { ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { User } from '../user/user.entity.js';
import { UserRole } from '../user/user-role.enum.js';
import { BusinessAdminService } from './business-admin.service.js';
import { Business } from './business.entity.js';

const BUSINESS_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const actor = { id: 'a', email: 'root@x.test', role: UserRole.SUPER_ADMIN, businessId: null, active: true, mustChangePassword: false };
const client = { ipAddress: null, userAgent: null };
const target = () =>
  Object.assign(new User(), { id: USER_ID, email: 'admin@x.test', role: UserRole.ADMIN, businessId: BUSINESS_ID, active: true, credentialsVersion: 3, mustChangePassword: false, createdAt: new Date(), updatedAt: new Date() });

interface Hooks {
  failAt?: string; // step name at which the fake database raises `error`
  error?: unknown;
  updateRows?: number;
  businessMissing?: boolean;
  activeAdmins?: number;
}

// A fake EntityManager that records, in order, every locking read and every write: the lock ORDER is the property under test.
function build(hooks: Hooks = {}) {
  const calls: string[] = [];
  const step = (name: string) => {
    calls.push(name);
    if (hooks.failAt === name) throw hooks.error;
  };
  const repo = (entity: unknown) => ({
    findOne: async (opts: { lock?: { mode: string } }) => {
      if (entity === Business) {
        step(opts.lock ? `lock:business:${opts.lock.mode}` : 'read:business');
        return hooks.businessMissing ? null : { id: BUSINESS_ID };
      }
      step(opts.lock ? `lock:user:${opts.lock.mode}` : 'read:user');
      return target();
    },
    findOneOrFail: async () => {
      step('read:fresh-user');
      return target();
    },
    count: async () => hooks.activeAdmins ?? 2,
    exists: async () => true,
    create: (value: object) => value,
    save: async (value: object) => {
      step('insert:user');
      return Object.assign(target(), value);
    },
    createQueryBuilder: () => {
      const q = { where: () => q, getCount: async () => 0 };
      return q;
    },
  });
  const manager = {
    getRepository: repo,
    createQueryBuilder: () => {
      const chain = {
        update: () => chain,
        set: () => chain,
        where: () => chain,
        returning: () => chain,
        execute: async () => {
          step('update:users');
          return { raw: Array.from({ length: hooks.updateRows ?? 1 }, () => ({ id: USER_ID })) };
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
  const limits = { assertCanCreate: vi.fn(async () => step('lock:business:create')) };
  const userRepository = { manager: { getRepository: repo }, findOne: async () => target() };
  const service = new BusinessAdminService(userRepository as never, { transaction } as unknown as DataSource, limits as never, audit as never);
  return { service, calls, transaction, audit };
}

const reset = (s: BusinessAdminService) => s.resetPassword(BUSINESS_ID, USER_ID, actor, client);

describe('BusinessAdminService — lock order Business -> User -> writes -> audit', () => {
  it('resetPassword locks the business FOR UPDATE, then the account, and only then writes and audits', async () => {
    const { service, calls } = build();
    const result = await reset(service);
    expect(calls).toEqual(['lock:business:pessimistic_write', 'lock:user:pessimistic_write', 'update:users', 'audit', 'read:fresh-user']);
    expect(result.temporaryPassword).toEqual(expect.any(String));
  });

  it('setActive (deactivate) keeps the same order', async () => {
    const { service, calls } = build();
    await service.setActive(BUSINESS_ID, USER_ID, false, actor, client);
    expect(calls.slice(0, 2)).toEqual(['lock:business:pessimistic_write', 'lock:user:pessimistic_write']);
    expect(calls.indexOf('update:users')).toBeGreaterThan(1);
    expect(calls.indexOf('audit')).toBeGreaterThan(calls.indexOf('update:users'));
  });

  it('resetPassword: a business that vanished is 404 BUSINESS_NOT_FOUND and nothing is written', async () => {
    const { service, calls, audit } = build({ businessMissing: true });
    await expect(reset(service)).rejects.toBeInstanceOf(NotFoundException);
    expect(calls).not.toContain('update:users');
    expect(audit.recordInTransaction).not.toHaveBeenCalled();
  });

  it('resetPassword: the compare-and-set still refuses a changed version with 409 CREDENTIALS_CHANGED, no audit, no password', async () => {
    const { service, audit } = build({ updateRows: 0 });
    const error = await reset(service).then(
      (value) => ({ value }),
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({ errorCode: 'CREDENTIALS_CHANGED' });
    expect(JSON.stringify(error)).not.toMatch(/temporaryPassword/);
    expect(audit.recordInTransaction).not.toHaveBeenCalled();
  });

  it('resetPassword: the audit stays mandatory — if it fails the request fails with that error (not a 409) and returns no password', async () => {
    const boom = new Error('audit store down');
    const { service } = build({ failAt: 'audit', error: boom });
    await expect(reset(service)).rejects.toBe(boom);
  });
});

describe('concurrency failures are 409 ADMIN_CONCURRENT_MODIFICATION in every operation, at any step', () => {
  const sqlError = (code: string) => Object.assign(new Error(`pg ${code}`), { driverError: { code } });
  const operations: Array<[string, string[], (s: BusinessAdminService) => Promise<unknown>]> = [
    ['resetPassword', ['lock:business:pessimistic_write', 'lock:user:pessimistic_write', 'update:users', 'audit'], reset],
    ['setActive', ['lock:business:pessimistic_write', 'lock:user:pessimistic_write', 'update:users', 'audit'], (s) => s.setActive(BUSINESS_ID, USER_ID, false, actor, client)],
    ['create', ['lock:business:create', 'insert:user', 'audit'], (s) => s.create(BUSINESS_ID, { email: 'new@x.test' }, actor, client)],
  ];

  for (const [name, steps, run] of operations) {
    for (const code of ['40001', '40P01', '55P03']) {
      it(`${name}: SQLSTATE ${code} at each step (${steps.join(', ')}) -> 409, one attempt, nothing returned`, async () => {
        for (const failAt of steps) {
          const { service, transaction } = build({ failAt, error: sqlError(code) });
          const error = await run(service).then(
            (value) => ({ resolved: value }),
            (e: unknown) => e,
          );
          expect(error, `${name}@${failAt}`).toBeInstanceOf(ConflictException);
          expect((error as ConflictException).getResponse()).toMatchObject({ errorCode: 'ADMIN_CONCURRENT_MODIFICATION' });
          expect(transaction).toHaveBeenCalledTimes(1); // no automatic retry
        }
      });
    }

    it(`${name}: other database errors are not disguised as conflicts (same error object)`, async () => {
      for (const [failAt, boom] of [[steps[0]!, sqlError('23505')], [steps[steps.length - 1]!, new Error('audit store down')], [steps[1]!, sqlError('57014')]] as const) {
        const { service } = build({ failAt, error: boom });
        await expect(run(service), `${name}@${failAt}`).rejects.toBe(boom);
      }
    });
  }
});
