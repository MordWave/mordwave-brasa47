import type { ExecutionContext } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RateLimitCheck } from './rate-limit.service.js';
import { RateLimitService } from './rate-limit.service.js';
import { RateLimitedException } from './rate-limited.exception.js';

function makeContext() {
  const header = vi.fn();
  const context = {
    switchToHttp: () => ({ getResponse: () => ({ header }) }),
  } as unknown as ExecutionContext;
  return { context, header };
}

const bucket = (limit: number) => ({ limit, ttlMs: 60_000 });
const check = (bucketId: string, tracker: string, limit: number): RateLimitCheck => ({
  bucketId,
  tracker,
  bucket: bucket(limit),
});

describe('RateLimitService.enforce', () => {
  const stores: ThrottlerStorageService[] = [];
  const makeService = () => {
    const storage = new ThrottlerStorageService();
    stores.push(storage);
    return new RateLimitService(storage as ThrottlerStorage);
  };

  afterEach(() => {
    stores.splice(0).forEach((s) => s.onApplicationShutdown());
  });

  it('lets requests through up to the limit and blocks the next with Retry-After', async () => {
    const service = makeService();
    const { context, header } = makeContext();

    await service.enforce(context, [check('b', 'ip:1', 2)]);
    await service.enforce(context, [check('b', 'ip:1', 2)]);
    expect(header).not.toHaveBeenCalled();

    await expect(service.enforce(context, [check('b', 'ip:1', 2)])).rejects.toBeInstanceOf(
      RateLimitedException,
    );
    expect(header).toHaveBeenCalledWith('Retry-After', expect.stringMatching(/^\d+$/));
    const seconds = Number(header.mock.calls[0][1]);
    expect(seconds).toBeGreaterThanOrEqual(1);
    expect(seconds).toBeLessThanOrEqual(60);
  });

  it('keeps separate counters per tracker and per bucket id', async () => {
    const service = makeService();
    const { context } = makeContext();

    await service.enforce(context, [check('b', 'ip:1', 1)]);
    await service.enforce(context, [check('b', 'ip:2', 1)]); // other tracker
    await service.enforce(context, [check('c', 'ip:1', 1)]); // other bucket
    await expect(service.enforce(context, [check('b', 'ip:1', 1)])).rejects.toBeInstanceOf(
      RateLimitedException,
    );
  });

  it('stops at the first exhausted check without counting the ones after it', async () => {
    const storage = { increment: vi.fn() };
    storage.increment
      .mockResolvedValueOnce({ totalHits: 2, timeToExpire: 30, isBlocked: true, timeToBlockExpire: 30 });
    const service = new RateLimitService(storage as unknown as ThrottlerStorage);
    const { context } = makeContext();

    await expect(
      service.enforce(context, [check('ip', 'ip:1', 1), check('session', 'session:x', 1)]),
    ).rejects.toBeInstanceOf(RateLimitedException);
    expect(storage.increment).toHaveBeenCalledTimes(1);
  });

  it('never puts the raw tracker (IP, user id, session token) in the storage key', async () => {
    const storage = {
      increment: vi.fn().mockResolvedValue({
        totalHits: 1,
        timeToExpire: 60,
        isBlocked: false,
        timeToBlockExpire: 0,
      }),
    };
    const service = new RateLimitService(storage as unknown as ThrottlerStorage);
    const { context } = makeContext();

    await service.enforce(context, [check('orders:ip', 'session:SECRET-TOKEN', 5)]);

    const [key] = storage.increment.mock.calls[0];
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain('SECRET-TOKEN');
  });

  it('is a no-op for an empty list of checks', async () => {
    const service = makeService();
    const { context } = makeContext();
    await expect(service.enforce(context, [])).resolves.toBeUndefined();
  });
});
