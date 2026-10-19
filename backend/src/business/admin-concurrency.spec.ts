import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ADMIN_CONCURRENT_MODIFICATION, isConcurrencyConflict, withAdminConcurrencyGuard } from './admin-concurrency.js';

const driverError = (code: string) => Object.assign(new Error(`pg ${code}`), { driverError: { code } });

describe('admin concurrency errors', () => {
  it.each(['40001', '40P01', '55P03'])('SQLSTATE %s is a concurrency conflict (TypeORM-wrapped or raw pg error)', (code) => {
    expect(isConcurrencyConflict(driverError(code))).toBe(true);
    expect(isConcurrencyConflict(Object.assign(new Error('raw'), { code }))).toBe(true);
  });

  it.each([
    ['unique violation', driverError('23505')],
    ['foreign key violation', driverError('23503')],
    ['statement timeout', driverError('57014')],
    ['connection failure', driverError('08006')],
    ['a plain Error', new Error('audit store down')],
    ['ECONNRESET', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
    ['an HttpException', new BadRequestException('x')],
    ['a string', '40P01'],
    ['null', null],
  ])('%s is NOT a concurrency conflict', (_label, error) => {
    expect(isConcurrencyConflict(error)).toBe(false);
  });

  it('translates a conflict into 409 ADMIN_CONCURRENT_MODIFICATION without leaking the database message', async () => {
    const error = await withAdminConcurrencyGuard(() => Promise.reject(driverError('40P01'))).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    const body = (error as ConflictException).getResponse() as { errorCode: string; message: string };
    expect(body.errorCode).toBe(ADMIN_CONCURRENT_MODIFICATION);
    expect(body.message).not.toMatch(/40P01|pg /);
  });

  it('passes every other error through untouched (same object) and returns successful results as they are', async () => {
    const boom = driverError('23505');
    await expect(withAdminConcurrencyGuard(() => Promise.reject(boom))).rejects.toBe(boom);
    await expect(withAdminConcurrencyGuard(() => Promise.resolve(7))).resolves.toBe(7);
  });

  it('never retries: the work runs exactly once even when it conflicts', async () => {
    const work = vi.fn(() => Promise.reject(driverError('40001')));
    await withAdminConcurrencyGuard(work).catch(() => undefined);
    expect(work).toHaveBeenCalledTimes(1);
  });
});
