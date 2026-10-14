import { describe, expect, it } from 'vitest';
import { PRESIGNED_GET_TTL_SECONDS, REDIRECT_CACHE_TTL_SECONDS } from './media.const.js';

describe('media TTLs', () => {
  it('uses the approved values', () => {
    expect(PRESIGNED_GET_TTL_SECONDS).toBe(3600);
    expect(REDIRECT_CACHE_TTL_SECONDS).toBe(1800);
  });

  it('keeps the redirect cache strictly shorter than the signature lifetime', () => {
    expect(REDIRECT_CACHE_TTL_SECONDS).toBeLessThan(PRESIGNED_GET_TTL_SECONDS);
  });
});
