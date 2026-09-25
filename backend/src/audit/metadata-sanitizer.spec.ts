import { describe, expect, it } from 'vitest';
import { sanitizeMetadata } from './metadata-sanitizer.js';

describe('sanitizeMetadata', () => {
  it('passes through a plain, small object unchanged', () => {
    expect(sanitizeMetadata({ name: 'Clásica Brasa', price: 6900 })).toEqual({
      name: 'Clásica Brasa',
      price: 6900,
    });
  });

  it('returns {} for null/undefined/non-object input', () => {
    expect(sanitizeMetadata(null)).toEqual({});
    expect(sanitizeMetadata(undefined)).toEqual({});
    expect(sanitizeMetadata('a string')).toEqual({});
    expect(sanitizeMetadata(42)).toEqual({});
  });

  it('strips top-level sensitive keys entirely (no placeholder)', () => {
    const result = sanitizeMetadata({
      name: 'x',
      password: 'hunter2',
      passwordHash: 'abc',
      secret: 'x',
      accessToken: 'x',
      sessionToken: 'x',
      qrToken: 'x',
      hostToken: 'x',
      viewerToken: 'x',
      jwt: 'x',
      Authorization: 'Bearer x',
      apiKey: 'x',
      api_key: 'x',
    });

    expect(result).toEqual({ name: 'x' });
  });

  it('strips sensitive keys inside nested objects and arrays', () => {
    const result = sanitizeMetadata({
      user: { email: 'a@b.com', password: 'hunter2' },
      items: [{ name: 'x', token: 'y' }],
    });

    expect(result).toEqual({
      user: { email: 'a@b.com' },
      items: [{ name: 'x' }],
    });
  });

  it('is case-insensitive when matching sensitive keys', () => {
    expect(sanitizeMetadata({ PASSWORD: 'x', SeCrEt: 'y', name: 'ok' })).toEqual({ name: 'ok' });
  });

  it('truncates a very long string instead of keeping it whole (base64-ish blob guard)', () => {
    const longValue = 'a'.repeat(5000);
    const result = sanitizeMetadata({ note: longValue });

    expect((result.note as string).length).toBeLessThan(longValue.length);
    expect(result.note).toMatch(/…\[truncated\]$/);
  });

  it('caps excessively deep nesting instead of recursing forever', () => {
    let deep: Record<string, unknown> = { value: 'bottom' };
    for (let i = 0; i < 20; i++) {
      deep = { nested: deep };
    }

    const result = sanitizeMetadata(deep);
    const json = JSON.stringify(result);

    expect(json).toContain('[max depth exceeded]');
  });

  it('caps array length instead of keeping an unbounded list', () => {
    const bigArray = Array.from({ length: 500 }, (_, i) => i);
    const result = sanitizeMetadata({ items: bigArray });

    expect((result.items as unknown[]).length).toBe(50);
  });

  it('falls back to a small marker when the sanitized result is still too large (~16 KB)', () => {
    // Many distinct small fields, not a single long string — string
    // truncation alone wouldn't catch this, only the overall byte check.
    const wide: Record<string, string> = {};
    for (let i = 0; i < 2000; i++) {
      wide[`field_${i}`] = 'x'.repeat(20);
    }

    const result = sanitizeMetadata(wide);

    expect(result._truncated).toBe(true);
    expect(typeof result._originalSizeBytes).toBe('number');
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThan(200);
  });

  it('never throws for a value that cannot be JSON-serialized (e.g. a BigInt)', () => {
    const withBigInt = { amount: BigInt(10) };
    expect(() => sanitizeMetadata(withBigInt)).not.toThrow();
  });
});
