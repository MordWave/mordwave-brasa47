// Static media delivery rules — plain constants (not env vars), same
// reasoning as rate-limit.config.ts: they are reviewed in code, and a typo'd
// variable must not silently change how long a signature or a redirect lives.

// How long the presigned GET URL in the 302 `Location` stays valid.
export const PRESIGNED_GET_TTL_SECONDS = 3600;

// How long browsers/proxies may reuse the 302 itself. MUST stay below the
// signature lifetime: a cached redirect followed at its very last second
// still has (PRESIGNED_GET_TTL_SECONDS - REDIRECT_CACHE_TTL_SECONDS) left.
export const REDIRECT_CACHE_TTL_SECONDS = 1800;

if (REDIRECT_CACHE_TTL_SECONDS >= PRESIGNED_GET_TTL_SECONDS) {
  throw new Error('REDIRECT_CACHE_TTL_SECONDS must be lower than PRESIGNED_GET_TTL_SECONDS');
}

// Every uploaded image is re-encoded to WebP and stored under a fresh uuid
// key that is never overwritten, so the object is immutable for good.
export const MEDIA_OBJECT_CONTENT_TYPE = 'image/webp';
export const MEDIA_OBJECT_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export const MEDIA_NOT_FOUND_ERROR_CODE = 'MEDIA_NOT_FOUND';
export const MEDIA_UNAVAILABLE_ERROR_CODE = 'MEDIA_UNAVAILABLE';
