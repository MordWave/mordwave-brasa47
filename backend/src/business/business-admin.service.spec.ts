import { ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
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
