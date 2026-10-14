import { describe, expect, it } from 'vitest';
import { DEFAULT_RATE_LIMITS } from './rate-limit.config.js';
import { RateLimitedException } from './rate-limited.exception.js';

describe('DEFAULT_RATE_LIMITS', () => {
  it('uses the approved per-minute values', () => {
    const minute = 60_000;
    expect(DEFAULT_RATE_LIMITS.globalIp).toEqual({ limit: 300, ttlMs: minute });
    expect(DEFAULT_RATE_LIMITS.authenticatedUser).toEqual({ limit: 300, ttlMs: minute });
    expect(DEFAULT_RATE_LIMITS.policies).toEqual({
      publicMenu: { ip: { limit: 120, ttlMs: minute } },
      login: { ip: { limit: 5, ttlMs: minute } },
      upload: { user: { limit: 30, ttlMs: minute } },
      ordersCreate: {
        session: { limit: 10, ttlMs: minute },
        ip: { limit: 120, ttlMs: minute },
      },
      tableJoin: { ip: { limit: 120, ttlMs: minute } },
      tableStatus: {
        session: { limit: 60, ttlMs: minute },
        ip: { limit: 600, ttlMs: minute },
        skipGlobalIp: true,
      },
      media: { ip: { limit: 1200, ttlMs: minute }, skipGlobalIp: true },
    });
  });

  it('only exempts from the global IP ceiling a route whose own IP bucket is higher than it', () => {
    const { globalIp, policies } = DEFAULT_RATE_LIMITS;
    for (const [name, policy] of Object.entries(policies)) {
      if (policy.skipGlobalIp) {
        expect(policy.ip!.limit, name).toBeGreaterThan(globalIp.limit);
      }
    }
  });
});

describe('RateLimitedException', () => {
  it('is a 429 whose body is exactly { statusCode, errorCode, message }', () => {
    const error = new RateLimitedException();
    expect(error.getStatus()).toBe(429);
    expect(error.getResponse()).toEqual({
      statusCode: 429,
      errorCode: 'RATE_LIMITED',
      message: 'Too many requests',
    });
  });
});
