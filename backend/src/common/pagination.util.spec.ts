import { describe, expect, it } from 'vitest';
import { buildPaginated, escapeLikePattern } from './pagination.util.js';

describe('buildPaginated', () => {
  it('computes totalPages and hasMore', () => {
    expect(buildPaginated(['a'], 1, 20, 45)).toEqual({
      items: ['a'],
      page: 1,
      limit: 20,
      total: 45,
      totalPages: 3,
      hasMore: true,
    });
  });

  it('hasMore is false on the last page, including an exact multiple of limit', () => {
    expect(buildPaginated([], 3, 20, 45).hasMore).toBe(false);
    expect(buildPaginated([], 2, 20, 40)).toMatchObject({ totalPages: 2, hasMore: false });
  });

  it('an empty result has totalPages 0 and hasMore false', () => {
    expect(buildPaginated([], 1, 20, 0)).toEqual({
      items: [],
      page: 1,
      limit: 20,
      total: 0,
      totalPages: 0,
      hasMore: false,
    });
  });

  it('a page beyond the last still reports the real total (items just come back empty)', () => {
    expect(buildPaginated([], 9, 20, 45)).toMatchObject({ page: 9, totalPages: 3, hasMore: false });
  });
});

describe('escapeLikePattern', () => {
  it('escapes %, _ and backslash', () => {
    expect(escapeLikePattern('50%_off\\')).toBe('50\\%\\_off\\\\');
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeLikePattern('Burger Brasa')).toBe('Burger Brasa');
  });
});
