import type { Request } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { ipTracker, sessionTracker, userTracker } from './rate-limit.trackers.js';

const req = (parts: { headers?: Record<string, string>; ip?: string; body?: unknown; user?: unknown }) =>
  ({ headers: {}, ...parts }) as unknown as Request & { user?: { id?: unknown } };

afterEach(() => {
  delete process.env.CLIENT_IP_HEADER;
});

describe('ipTracker', () => {
  it('uses req.ip when no client IP header is configured', () => {
    expect(ipTracker(req({ ip: '203.0.113.7' }))).toBe('ip:203.0.113.7');
  });

  it('shares resolveClientIp: a valid CLIENT_IP_HEADER wins over req.ip', () => {
    process.env.CLIENT_IP_HEADER = 'x-real-ip';
    expect(ipTracker(req({ ip: '10.0.0.1', headers: { 'x-real-ip': '198.51.100.4' } }))).toBe(
      'ip:198.51.100.4',
    );
  });

  it('falls back to req.ip when the configured header is invalid', () => {
    process.env.CLIENT_IP_HEADER = 'x-real-ip';
    expect(ipTracker(req({ ip: '10.0.0.1', headers: { 'x-real-ip': 'garbage' } }))).toBe(
      'ip:10.0.0.1',
    );
  });

  it('collapses an IPv4-mapped IPv6 address to plain IPv4', () => {
    expect(ipTracker(req({ ip: '::ffff:203.0.113.7' }))).toBe('ip:203.0.113.7');
  });

  it('collapses IPv6 addresses of the same /64 into one tracker', () => {
    const a = ipTracker(req({ ip: '2001:db8:1:2:aaaa:bbbb:cccc:dddd' }));
    const b = ipTracker(req({ ip: '2001:db8:1:2:1111:2222:3333:4444' }));
    expect(a).toBe(b);
    expect(ipTracker(req({ ip: '2001:db8:1:3::1' }))).not.toBe(a);
  });

  it('uses a single shared "unknown" tracker when no IP can be resolved', () => {
    expect(ipTracker(req({}))).toBe('ip:unknown');
  });
});

describe('userTracker', () => {
  it('tracks by the authenticated user id, regardless of IP', () => {
    expect(userTracker(req({ ip: '203.0.113.7', user: { id: 'u-1' } }))).toBe('user:u-1');
    expect(userTracker(req({ ip: '198.51.100.9', user: { id: 'u-1' } }))).toBe('user:u-1');
  });

  it('gives two users on the same IP different trackers', () => {
    const a = userTracker(req({ ip: '203.0.113.7', user: { id: 'u-1' } }));
    const b = userTracker(req({ ip: '203.0.113.7', user: { id: 'u-2' } }));
    expect(a).not.toBe(b);
  });

  it.each([[undefined], [{}], [{ id: 123 }], [{ id: '' }]])(
    'falls back to the IP tracker when there is no usable user (%j)',
    (user) => {
      expect(userTracker(req({ ip: '203.0.113.7', user }))).toBe('ip:203.0.113.7');
    },
  );
});

describe('sessionTracker', () => {
  it('tracks by body.sessionToken, regardless of IP', () => {
    expect(sessionTracker(req({ ip: '203.0.113.7', body: { sessionToken: 'tok-a' } }))).toBe(
      'session:tok-a',
    );
    expect(sessionTracker(req({ ip: '198.51.100.9', body: { sessionToken: 'tok-a' } }))).toBe(
      'session:tok-a',
    );
  });

  it('gives two sessions on the same IP different trackers', () => {
    const a = sessionTracker(req({ ip: '203.0.113.7', body: { sessionToken: 'tok-a' } }));
    const b = sessionTracker(req({ ip: '203.0.113.7', body: { sessionToken: 'tok-b' } }));
    expect(a).not.toBe(b);
  });

  it('accepts a token of exactly 128 characters', () => {
    const token = 'x'.repeat(128);
    expect(sessionTracker(req({ body: { sessionToken: token } }))).toBe(`session:${token}`);
  });

  it.each([
    ['no body', undefined],
    ['an empty body', {}],
    ['a numeric token', { sessionToken: 42 }],
    ['an object token', { sessionToken: { a: 1 } }],
    ['an empty token', { sessionToken: '' }],
    ['an oversized token', { sessionToken: 'x'.repeat(129) }],
  ])('falls back to the IP tracker with %s', (_label, body) => {
    expect(sessionTracker(req({ ip: '203.0.113.7', body }))).toBe('ip:203.0.113.7');
  });
});
