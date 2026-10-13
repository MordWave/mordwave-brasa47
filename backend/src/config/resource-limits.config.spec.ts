import { describe, expect, it } from 'vitest';
import { DEFAULT_BUSINESS_LIMITS } from '../common/limits/resource-limits.const.js';
import { loadResourceLimits, parseLimit } from './resource-limits.config.js';

describe('DEFAULT_BUSINESS_LIMITS', () => {
  it('are the agreed technical ceilings', () => {
    expect(DEFAULT_BUSINESS_LIMITS).toEqual({ product: 500, category: 50, table: 200, user: 20 });
  });
});

describe('parseLimit', () => {
  it('returns the default when unset or blank', () => {
    expect(parseLimit('X', undefined, 7)).toBe(7);
    expect(parseLimit('X', '', 7)).toBe(7);
    expect(parseLimit('X', '   ', 7)).toBe(7);
  });

  it('accepts a plain positive integer (trimmed), up to the sanity bound', () => {
    expect(parseLimit('X', '42', 7)).toBe(42);
    expect(parseLimit('X', ' 42 ', 7)).toBe(42);
    expect(parseLimit('X', '1', 7)).toBe(1);
    expect(parseLimit('X', '100000', 7)).toBe(100_000);
  });

  it.each(['0', '-1', 'abc', '1.5', '1e3', '12abc', '+5', '100001', '99999999999999999999'])(
    'rejects %s, naming the variable',
    (raw) => {
      expect(() => parseLimit('BUSINESS_MAX_PRODUCTS', raw, 7)).toThrow(/BUSINESS_MAX_PRODUCTS/);
    },
  );
});

describe('loadResourceLimits', () => {
  it('uses the defaults when nothing is configured', () => {
    expect(loadResourceLimits({})).toEqual({
      business: { product: 500, category: 50, table: 200, user: 20 },
    });
  });

  it('lets each limit be overridden independently from the environment', () => {
    const config = loadResourceLimits({
      BUSINESS_MAX_PRODUCTS: '3',
      BUSINESS_MAX_TABLES: '10',
    });
    expect(config.business).toEqual({ product: 3, category: 50, table: 10, user: 20 });
  });

  it('refuses to start on an invalid value instead of silently falling back', () => {
    expect(() => loadResourceLimits({ BUSINESS_MAX_CATEGORIES: 'lots' })).toThrow(/BUSINESS_MAX_CATEGORIES/);
    expect(() => loadResourceLimits({ BUSINESS_MAX_USERS: '0' })).toThrow(/BUSINESS_MAX_USERS/);
  });
});
