import { describe, expect, it } from 'vitest';
import { resolveTrustProxy } from './security.config.js';

describe('resolveTrustProxy', () => {
  it('defaults to false when unset', () => {
    expect(resolveTrustProxy(undefined)).toBe(false);
  });

  it('treats the literal string "false" as false', () => {
    expect(resolveTrustProxy('false')).toBe(false);
  });

  it('treats the literal string "true" as true (trust every hop)', () => {
    expect(resolveTrustProxy('true')).toBe(true);
  });

  it('parses a non-negative integer as the number of trusted hops', () => {
    expect(resolveTrustProxy('1')).toBe(1);
    expect(resolveTrustProxy('2')).toBe(2);
    expect(resolveTrustProxy('0')).toBe(0);
  });

  it('falls back to false for a negative or non-integer value', () => {
    expect(resolveTrustProxy('-1')).toBe(false);
    expect(resolveTrustProxy('1.5')).toBe(false);
    expect(resolveTrustProxy('not-a-number')).toBe(false);
  });
});
