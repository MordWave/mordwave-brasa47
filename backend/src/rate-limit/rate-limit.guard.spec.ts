import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RATE_LIMITS } from './rate-limit.config.js';
import { RateLimit, SkipRateLimit } from './rate-limit.decorator.js';
import { RateLimitGuard } from './rate-limit.guard.js';
import type { RateLimitCheck, RateLimitService } from './rate-limit.service.js';
import { UserRateLimitInterceptor } from './user-rate-limit.interceptor.js';

class SampleController {
  @RateLimit('ordersCreate')
  orders() {}

  @RateLimit('tableStatus')
  status() {}

  @RateLimit('upload')
  upload() {}

  @RateLimit('publicMenu')
  menu() {}

  @SkipRateLimit()
  health() {}

  plain() {}
}

function makeContext(handler: () => void, req: Record<string, unknown>): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => SampleController,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
  } as unknown as ExecutionContext;
}

// Looked up by name so lint doesn't flag every `prototype.method` as unbound.
const handler = (name: keyof SampleController) =>
  Reflect.get(SampleController.prototype, name) as () => void;
const baseReq = (extra: Record<string, unknown> = {}) => ({
  headers: {},
  ip: '203.0.113.7',
  body: {},
  ...extra,
});

describe('RateLimitGuard (global, pre-auth)', () => {
  let enforce: ReturnType<typeof vi.fn>;
  let guard: RateLimitGuard;

  const checksOf = (): RateLimitCheck[] => enforce.mock.calls[0][1];

  beforeEach(() => {
    enforce = vi.fn().mockResolvedValue(undefined);
    guard = new RateLimitGuard(
      new Reflector(),
      { enforce } as unknown as RateLimitService,
      DEFAULT_RATE_LIMITS,
    );
  });

  afterEach(() => {
    delete process.env.CLIENT_IP_HEADER;
  });

  it('applies only the global IP ceiling to a route without a policy', async () => {
    await guard.canActivate(makeContext(handler('plain'), baseReq()));
    expect(checksOf()).toEqual([
      { bucketId: 'global:ip', tracker: 'ip:203.0.113.7', bucket: DEFAULT_RATE_LIMITS.globalIp },
    ]);
  });

  it('evaluates global IP, then route IP, then session — in that order', async () => {
    await guard.canActivate(
      makeContext(handler('orders'), baseReq({ body: { sessionToken: 'tok-1' } })),
    );
    expect(checksOf().map((c) => [c.bucketId, c.tracker])).toEqual([
      ['global:ip', 'ip:203.0.113.7'],
      ['ordersCreate:SampleController.orders:ip', 'ip:203.0.113.7'],
      ['ordersCreate:SampleController.orders:session', 'session:tok-1'],
    ]);
    expect(checksOf().map((c) => c.bucket.limit)).toEqual([300, 120, 10]);
  });

  it('falls back to the IP for the session counter when there is no usable sessionToken', async () => {
    await guard.canActivate(makeContext(handler('orders'), baseReq({ body: { sessionToken: 5 } })));
    expect(checksOf()[2].tracker).toBe('ip:203.0.113.7');
  });

  it('keeps two sessions behind one IP on different session counters', async () => {
    await guard.canActivate(makeContext(handler('orders'), baseReq({ body: { sessionToken: 'a' } })));
    await guard.canActivate(makeContext(handler('orders'), baseReq({ body: { sessionToken: 'b' } })));
    const [first, second] = enforce.mock.calls.map((call) => call[1] as RateLimitCheck[]);
    expect(first[2].tracker).not.toBe(second[2].tracker);
    expect(first[1].tracker).toBe(second[1].tracker);
  });

  it('exempts table status from the global IP ceiling but keeps its own IP + session counters', async () => {
    await guard.canActivate(makeContext(handler('status'), baseReq({ body: { sessionToken: 's' } })));
    expect(checksOf().map((c) => [c.bucketId.split(':').pop(), c.bucket.limit])).toEqual([
      ['ip', 600],
      ['session', 60],
    ]);
  });

  it('does not add per-user counters (those need the verified user, post-auth)', async () => {
    await guard.canActivate(makeContext(handler('upload'), baseReq({ user: { id: 'u-1' } })));
    expect(checksOf().map((c) => c.bucketId)).toEqual(['global:ip']);
  });

  it('uses the same IP the audit log uses (CLIENT_IP_HEADER)', async () => {
    process.env.CLIENT_IP_HEADER = 'x-real-ip';
    await guard.canActivate(
      makeContext(handler('menu'), baseReq({ headers: { 'x-real-ip': '198.51.100.4' } })),
    );
    expect(checksOf().every((c) => c.tracker === 'ip:198.51.100.4')).toBe(true);
  });

  it('does nothing for @SkipRateLimit() routes', async () => {
    await guard.canActivate(makeContext(handler('health'), baseReq()));
    expect(enforce).not.toHaveBeenCalled();
  });

  it('propagates the 429 thrown by the service', async () => {
    enforce.mockRejectedValue(new Error('limited'));
    await expect(guard.canActivate(makeContext(handler('menu'), baseReq()))).rejects.toThrow('limited');
  });
});

describe('UserRateLimitInterceptor (post-auth)', () => {
  let enforce: ReturnType<typeof vi.fn>;
  let interceptor: UserRateLimitInterceptor;
  const next = { handle: vi.fn(() => 'handled') };

  const checksOf = (): RateLimitCheck[] => enforce.mock.calls[0][1];

  beforeEach(() => {
    enforce = vi.fn().mockResolvedValue(undefined);
    next.handle.mockClear();
    interceptor = new UserRateLimitInterceptor(
      new Reflector(),
      { enforce } as unknown as RateLimitService,
      DEFAULT_RATE_LIMITS,
    );
  });

  it('applies the authenticated-user ceiling, keyed by user id', async () => {
    await interceptor.intercept(
      makeContext(handler('plain'), baseReq({ user: { id: 'u-1' } })),
      next as never,
    );
    expect(checksOf()).toEqual([
      { bucketId: 'authenticated:user', tracker: 'user:u-1', bucket: DEFAULT_RATE_LIMITS.authenticatedUser },
    ]);
    expect(next.handle).toHaveBeenCalled();
  });

  it('adds the route user bucket for uploads (30/min/user)', async () => {
    await interceptor.intercept(
      makeContext(handler('upload'), baseReq({ user: { id: 'u-1' } })),
      next as never,
    );
    expect(checksOf().map((c) => [c.bucketId, c.bucket.limit])).toEqual([
      ['authenticated:user', 300],
      ['upload:SampleController.upload:user', 30],
    ]);
  });

  it('gives two users on the same IP different trackers', async () => {
    await interceptor.intercept(makeContext(handler('plain'), baseReq({ user: { id: 'u-1' } })), next as never);
    await interceptor.intercept(makeContext(handler('plain'), baseReq({ user: { id: 'u-2' } })), next as never);
    const [a, b] = enforce.mock.calls.map((call) => (call[1] as RateLimitCheck[])[0].tracker);
    expect(a).not.toBe(b);
  });

  it('applies nothing on a route with no authenticated user and no user policy', async () => {
    await interceptor.intercept(makeContext(handler('menu'), baseReq()), next as never);
    expect(checksOf()).toEqual([]);
    expect(next.handle).toHaveBeenCalled();
  });

  it('falls back to the IP for a user-policy route that has no user', async () => {
    await interceptor.intercept(makeContext(handler('upload'), baseReq()), next as never);
    expect(checksOf()).toEqual([
      expect.objectContaining({ bucketId: 'upload:SampleController.upload:user', tracker: 'ip:203.0.113.7' }),
    ]);
  });

  it('never reads or decodes an Authorization header itself', async () => {
    await interceptor.intercept(
      makeContext(handler('plain'), baseReq({ headers: { authorization: 'Bearer forged.jwt.value' } })),
      next as never,
    );
    expect(checksOf()).toEqual([]);
  });

  it('does not call the handler when the limit is exceeded', async () => {
    enforce.mockRejectedValue(new Error('limited'));
    await expect(
      interceptor.intercept(makeContext(handler('plain'), baseReq({ user: { id: 'u-1' } })), next as never),
    ).rejects.toThrow('limited');
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('does nothing for @SkipRateLimit() routes', async () => {
    await interceptor.intercept(
      makeContext(handler('health'), baseReq({ user: { id: 'u-1' } })),
      next as never,
    );
    expect(enforce).not.toHaveBeenCalled();
    expect(next.handle).toHaveBeenCalled();
  });
});
