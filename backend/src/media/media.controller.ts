import { Controller, Get, NotFoundException, Param, Req, Res, ServiceUnavailableException } from '@nestjs/common';
import type { Request, Response } from 'express';
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
//   HEAD /media/<key>
//     -> 200 (no body, no redirect) if the object exists, 404 otherwise
//
// HEAD must NOT redirect: a presigned URL is signed for ONE HTTP method (GET),
// so a client following a HEAD redirect would be rejected with 403 by the
// bucket. HEAD therefore answers directly from HeadObject and never signs.
//
// Express routes HEAD to the GET handler, so one handler serves both and they
// share one rate-limit counter (RateLimitGuard keys counters by handler); the
// method is told apart with req.method.
@Controller('media')
export class MediaController {
  constructor(private readonly store: S3ObjectStoreService) {}

  // Express 5 / path-to-regexp 8: a wildcard must be NAMED ("*storageKey"),
  // and it yields an array of path segments rather than one string.
  @Get('*storageKey')
  @RateLimit('media')
  async redirect(
    @Param('storageKey') rawKey: string | string[],
    @Req() req: Request,
    // Not passthrough: HEAD and GET answer differently and we write the
    // response ourselves (exceptions still go through Nest's filters).
    @Res() res: Response,
  ): Promise<void> {
    // Anything that is not a clean 200/302 must never be cached.
    res.setHeader('Cache-Control', 'no-store');

    const key = Array.isArray(rawKey) ? rawKey.join('/') : rawKey;
    // Rejected BEFORE any S3 call: a malformed key can never reach the bucket.
    if (!isMediaKey(key)) throw this.notFound();

    try {
      const head = await this.store.head(key);
      if (!head) throw this.notFound();

      res.setHeader('Cache-Control', `public, max-age=${REDIRECT_CACHE_TTL_SECONDS}`);
      if (req.method === 'HEAD') {
        // Same metadata a GET of the object would carry; no presign.
        if (head.contentType) res.setHeader('Content-Type', head.contentType);
        if (head.contentLength !== undefined) res.setHeader('Content-Length', String(head.contentLength));
        res.status(200).end();
        return;
      }

      const url = await this.store.presignGet(key, PRESIGNED_GET_TTL_SECONDS);
      res.redirect(302, url);
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
