import { Controller, Get, NotFoundException, Param, Redirect, Res, ServiceUnavailableException } from '@nestjs/common';
import type { Response } from 'express';
import { RateLimit } from '../rate-limit/rate-limit.decorator.js';
import {
  MEDIA_NOT_FOUND_ERROR_CODE,
  MEDIA_UNAVAILABLE_ERROR_CODE,
  PRESIGNED_GET_TTL_SECONDS,
  REDIRECT_CACHE_TTL_SECONDS,
} from './media.const.js';
import { isMediaKey } from './media-key.util.js';
import { ObjectStoreUnavailableError, S3ObjectStoreService } from './s3-object-store.service.js';

// Public, unauthenticated, stable URL for an image:
//
//   GET /media/businesses/<businessId>/products/<productId>/<uuid>.webp
//     -> 302 Location: <presigned GET, 1 h>   (bytes come from the bucket,
//                                              never through this process)
//
// The bucket is private; the DB stores only the stable key, never a
// presigned URL. Keys are immutable (a new uuid per upload), which is what
// makes it safe for browsers to cache the redirect.
//
// HEAD needs no handler of its own: Express routes HEAD to the GET handler
// and drops the body, so GET and HEAD share one code path and one rate-limit
// counter (RateLimitGuard keys counters by handler).
@Controller('media')
export class MediaController {
  constructor(private readonly store: S3ObjectStoreService) {}

  // Express 5 / path-to-regexp 8: a wildcard must be NAMED ("*storageKey"),
  // and it yields an array of path segments rather than one string.
  @Get('*storageKey')
  @RateLimit('media')
  @Redirect()
  async redirect(
    @Param('storageKey') rawKey: string | string[],
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ url: string; statusCode: number }> {
    // Anything that is not a clean 302 must never be cached.
    res.setHeader('Cache-Control', 'no-store');

    const key = Array.isArray(rawKey) ? rawKey.join('/') : rawKey;
    // Rejected BEFORE any S3 call: a malformed key can never reach the bucket.
    if (!isMediaKey(key)) throw this.notFound();

    try {
      if (!(await this.store.head(key))) throw this.notFound();
      const url = await this.store.presignGet(key, PRESIGNED_GET_TTL_SECONDS);
      res.setHeader('Cache-Control', `public, max-age=${REDIRECT_CACHE_TTL_SECONDS}`);
      return { url, statusCode: 302 };
    } catch (error) {
      if (error instanceof ObjectStoreUnavailableError) {
        throw new ServiceUnavailableException({
          statusCode: 503,
          errorCode: MEDIA_UNAVAILABLE_ERROR_CODE,
          message: 'Media temporarily unavailable',
        });
      }
      throw error;
    }
  }

  private notFound(): NotFoundException {
    return new NotFoundException({
      statusCode: 404,
      errorCode: MEDIA_NOT_FOUND_ERROR_CODE,
      message: 'Media not found',
    });
  }
}
