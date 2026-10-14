import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RATE_LIMIT_POLICY_KEY } from '../rate-limit/rate-limit.decorator.js';
import { MediaController } from './media.controller.js';
import { PRESIGNED_GET_TTL_SECONDS, REDIRECT_CACHE_TTL_SECONDS } from './media.const.js';
import { ObjectStoreUnavailableError, type S3ObjectStoreService } from './s3-object-store.service.js';

const KEY = 'businesses/aaaaaaaa-1111-4abc-8def-111111111abc/products/bbbbbbbb-2222-4abc-8def-222222222abc/cccccccc-3333-4abc-8def-333333333abc.webp';

function setup(method: 'GET' | 'HEAD' = 'GET') {
  const store = {
    head: vi.fn(async () => ({ contentLength: 336, contentType: 'image/webp' }) as unknown),
    presignGet: vi.fn(async () => 'https://signed.example/x?sig=1'),
  };
  const headers: Record<string, string> = {};
  const res = {
    setHeader: vi.fn((k: string, v: string) => void (headers[k] = v)),
    status: vi.fn(),
    end: vi.fn(),
    redirect: vi.fn(),
  };
  res.status.mockReturnValue(res);
  const controller = new MediaController(store as unknown as S3ObjectStoreService);
  const call = (key: string | string[]) =>
    controller.redirect(key, { method } as Request, res as unknown as Response);
  return { store, headers, res, controller, call };
}

describe('MediaController.redirect', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('GET: checks existence, signs with the 1 h TTL and answers a 302 with a shorter redirect cache', async () => {
    await ctx.call(KEY.split('/'));
    expect(ctx.res.redirect).toHaveBeenCalledWith(302, 'https://signed.example/x?sig=1');
    expect(ctx.store.head).toHaveBeenCalledWith(KEY);
    expect(ctx.store.presignGet).toHaveBeenCalledWith(KEY, PRESIGNED_GET_TTL_SECONDS);
    expect(ctx.headers['Cache-Control']).toBe(`public, max-age=${REDIRECT_CACHE_TTL_SECONDS}`);
    expect(REDIRECT_CACHE_TTL_SECONDS).toBeLessThan(PRESIGNED_GET_TTL_SECONDS);
  });

  describe('HEAD', () => {
    beforeEach(() => {
      ctx = setup('HEAD');
    });

    it('answers 200 with the object metadata, no redirect, and never signs a GET URL', async () => {
      await ctx.call(KEY);
      expect(ctx.store.head).toHaveBeenCalledWith(KEY);
      expect(ctx.store.presignGet).not.toHaveBeenCalled();
      expect(ctx.res.redirect).not.toHaveBeenCalled();
      expect(ctx.res.status).toHaveBeenCalledWith(200);
      expect(ctx.res.end).toHaveBeenCalledWith();
      expect(ctx.headers['Content-Type']).toBe('image/webp');
      expect(ctx.headers['Content-Length']).toBe('336');
      expect(ctx.headers['Cache-Control']).toBe(`public, max-age=${REDIRECT_CACHE_TTL_SECONDS}`);
      expect(ctx.headers.Location).toBeUndefined();
    });

    it('404s a missing object without signing', async () => {
      ctx.store.head.mockResolvedValue(null);
      await expect(ctx.call(KEY)).rejects.toBeInstanceOf(NotFoundException);
      expect(ctx.store.presignGet).not.toHaveBeenCalled();
      expect(ctx.res.end).not.toHaveBeenCalled();
      expect(ctx.headers['Cache-Control']).toBe('no-store');
    });

    it('rejects an invalid key before touching S3', async () => {
      await expect(ctx.call(KEY.toUpperCase())).rejects.toBeInstanceOf(NotFoundException);
      expect(ctx.store.head).not.toHaveBeenCalled();
      expect(ctx.store.presignGet).not.toHaveBeenCalled();
    });

    it('maps a store failure to the generic 503', async () => {
      ctx.store.head.mockRejectedValue(new ObjectStoreUnavailableError('S3 HeadObject failed'));
      await expect(ctx.call(KEY)).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  it('accepts the key as a single string too', async () => {
    await ctx.call(KEY);
    expect(ctx.store.head).toHaveBeenCalledWith(KEY);
  });

  it.each([
    ['uppercase', KEY.toUpperCase()],
    ['traversal', KEY.replace('products', '..')],
    ['legacy supabase path', 'aaaaaaaa-1111-4abc-8def-111111111abc/bbbbbbbb-2222-4abc-8def-222222222abc/imagen.webp'],
    ['wrong extension', KEY.replace('.webp', '.png')],
    ['empty', ''],
  ])('rejects %s with 404 before touching S3', async (_label, key) => {
    await expect(ctx.call(key)).rejects.toBeInstanceOf(NotFoundException);
    expect(ctx.store.head).not.toHaveBeenCalled();
    expect(ctx.store.presignGet).not.toHaveBeenCalled();
    expect(ctx.headers['Cache-Control']).toBe('no-store');
  });

  it('404s a missing object without signing anything', async () => {
    ctx.store.head.mockResolvedValue(null);
    await expect(ctx.call(KEY)).rejects.toBeInstanceOf(NotFoundException);
    expect(ctx.store.presignGet).not.toHaveBeenCalled();
    expect(ctx.headers['Cache-Control']).toBe('no-store');
  });

  it('maps a store failure to a generic 503 that carries no internals', async () => {
    ctx.store.head.mockRejectedValue(new ObjectStoreUnavailableError('S3 HeadObject failed', { cause: new Error('secret detail') }));
    const error = await ctx.call(KEY).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(JSON.stringify((error as ServiceUnavailableException).getResponse())).not.toContain('secret detail');
    expect(ctx.headers['Cache-Control']).toBe('no-store');
  });

  it('is tied to the dedicated "media" rate-limit policy', () => {
    const handler = Object.getOwnPropertyDescriptor(MediaController.prototype, 'redirect')!.value as object;
    expect(Reflect.getMetadata(RATE_LIMIT_POLICY_KEY, handler)).toBe('media');
  });
});
