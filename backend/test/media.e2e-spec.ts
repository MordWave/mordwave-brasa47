import type { AddressInfo } from 'node:net';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { ObjectStoreUnavailableError, S3ObjectStoreService } from '../src/media/s3-object-store.service.js';
import {
  DEFAULT_RATE_LIMITS,
  RATE_LIMIT_CONFIG,
  type RateLimitConfig,
} from '../src/rate-limit/rate-limit.config.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

const BIZ = 'aaaaaaaa-1111-4abc-8def-111111111abc';
const PROD = 'bbbbbbbb-2222-4abc-8def-222222222abc';
const OBJ = 'cccccccc-3333-4abc-8def-333333333abc';
const MISSING_OBJ = 'dddddddd-4444-4abc-8def-444444444abc';
const KEY = `businesses/${BIZ}/products/${PROD}/${OBJ}.webp`;
const LOGO_KEY = `businesses/${BIZ}/logo/${OBJ}.webp`;
const MISSING_KEY = `businesses/${BIZ}/products/${PROD}/${MISSING_OBJ}.webp`;

const minute = 60_000;
const bucket = (limit: number) => ({ limit, ttlMs: minute });
// Tiny numbers so the limits can be hit in a few requests. The global
// ceiling (5) is deliberately far BELOW the media bucket (8): if /media
// counted toward the global one it would 429 at the 6th request.
const GLOBAL = 5;
const MEDIA_LIMIT = 8;
const LIMITS: RateLimitConfig = {
  ...DEFAULT_RATE_LIMITS,
  globalIp: bucket(GLOBAL),
  policies: { ...DEFAULT_RATE_LIMITS.policies, media: { ip: bucket(MEDIA_LIMIT), skipGlobalIp: true } },
};

const signedUrlFor = (key: string) => `https://fake-bucket.example/${key}?X-Amz-Expires=3600&X-Amz-Signature=fake`;

// The S3 side is a fake: no network, no bucket, no credentials. What is
// under test is the HTTP contract of /media and its rate limiting.
const store = {
  head: vi.fn(),
  presignGet: vi.fn(),
};

describe('GET/HEAD /media/<key> (e2e, real local Postgres, fake S3)', () => {
  let testDb: TestDatabase;
  let app: INestApplication<App>;
  let ipCounter = 0;
  const nextIp = () => `198.51.100.${(ipCounter += 1)}`;
  const asIp = (ip: string) => ({ 'X-Real-IP': ip });
  const baseUrl = () => `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const http = () => request(baseUrl());

  beforeAll(async () => {
    testDb = await startTestDatabase();

    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = '';
    process.env.DB_HOST = testDb.host;
    process.env.DB_PORT = String(testDb.port);
    process.env.DB_USERNAME = 'postgres';
    process.env.DB_PASSWORD = 'postgres';
    process.env.DB_NAME = 'postgres';
    process.env.DB_POOL_MAX = '1';
    process.env.CLIENT_IP_HEADER = 'x-real-ip';

    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(S3ObjectStoreService)
      .useValue(store)
      .overrideProvider(RATE_LIMIT_CONFIG)
      .useValue(LIMITS)
      .compile();
    app = moduleFixture.createNestApplication<INestApplication<App>>();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    // Fixed ephemeral port, same reason as rate-limit.e2e-spec.ts.
    await app.listen(0, '127.0.0.1');
  }, 60_000);

  afterAll(async () => {
    delete process.env.CLIENT_IP_HEADER;
    await app?.close();
    await testDb?.stop();
  });

  beforeEach(() => {
    store.head.mockReset().mockImplementation(async (key: string) =>
      key === MISSING_KEY ? null : { contentLength: 10, contentType: 'image/webp' },
    );
    store.presignGet.mockReset().mockImplementation(async (key: string) => signedUrlFor(key));
  });

  describe('valid key, existing object', () => {
    it('GET answers 302 to the (fake) presigned URL with the approved cache header', async () => {
      const res = await http().get(`/media/${KEY}`).set(asIp(nextIp())).redirects(0).expect(302);
      expect(res.headers.location).toBe(signedUrlFor(KEY));
      expect(res.headers['cache-control']).toBe('public, max-age=1800');
      expect(store.head).toHaveBeenCalledWith(KEY);
      expect(store.presignGet).toHaveBeenCalledWith(KEY, 3600);
      // NestJS only redirects; the bytes are never proxied through the API.
      expect(String(res.headers['content-type'] ?? '')).not.toMatch(/^image\//);
    });

    it('the redirect cache is strictly shorter than the signature lifetime', async () => {
      const res = await http().get(`/media/${KEY}`).set(asIp(nextIp())).redirects(0).expect(302);
      const maxAge = Number(/max-age=(\d+)/.exec(res.headers['cache-control'])![1]);
      const expires = Number(new URL(res.headers.location).searchParams.get('X-Amz-Expires'));
      expect(maxAge).toBeLessThan(expires);
    });

    it('serves business logo keys too', async () => {
      const res = await http().get(`/media/${LOGO_KEY}`).set(asIp(nextIp())).redirects(0).expect(302);
      expect(res.headers.location).toBe(signedUrlFor(LOGO_KEY));
    });

    // A presigned URL is signed for GET only: redirecting a HEAD to it would
    // make the bucket answer 403. HEAD must answer directly and never sign.
    it('HEAD answers 200 directly (no redirect, no body) and never presigns', async () => {
      const res = await http().head(`/media/${KEY}`).set(asIp(nextIp())).redirects(0).expect(200);
      expect(res.headers.location).toBeUndefined();
      expect(res.headers['cache-control']).toBe('public, max-age=1800');
      expect(res.headers['content-type']).toBe('image/webp');
      expect(res.headers['content-length']).toBe('10');
      expect(res.text ?? '').toBe('');
      expect(store.head).toHaveBeenCalledWith(KEY);
      expect(store.presignGet).not.toHaveBeenCalled();
    });

    it('GET still redirects after a HEAD of the same key (no shared state)', async () => {
      const ip = nextIp();
      await http().head(`/media/${KEY}`).set(asIp(ip)).redirects(0).expect(200);
      const res = await http().get(`/media/${KEY}`).set(asIp(ip)).redirects(0).expect(302);
      expect(res.headers.location).toBe(signedUrlFor(KEY));
      expect(store.presignGet).toHaveBeenCalledTimes(1);
    });

    it('HEAD on a missing object is a 404 and never presigns', async () => {
      const res = await http().head(`/media/${MISSING_KEY}`).set(asIp(nextIp())).redirects(0).expect(404);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(store.presignGet).not.toHaveBeenCalled();
    });
  });

  describe('invalid keys are rejected without touching S3', () => {
    const cases: Array<[string, string]> = [
      ['uppercase hex', `/media/businesses/${BIZ.toUpperCase()}/products/${PROD}/${OBJ}.webp`],
      ['uppercase prefix', `/media/Businesses/${BIZ}/products/${PROD}/${OBJ}.webp`],
      ['path traversal', `/media/businesses/${BIZ}/products/../../${PROD}/${OBJ}.webp`],
      ['encoded traversal', `/media/businesses/${BIZ}/products/%2e%2e/${PROD}/${OBJ}.webp`],
      ['wrong extension', `/media/businesses/${BIZ}/products/${PROD}/${OBJ}.png`],
      ['extra segment', `/media/businesses/${BIZ}/products/${PROD}/x/${OBJ}.webp`],
      ['legacy supabase path', `/media/${BIZ}/${PROD}/imagen.webp`],
      ['arbitrary object', `/media/system-tests/media-pr2/${OBJ}.txt`],
      ['not a key at all', `/media/hello`],
      ['trailing newline', `/media/businesses/${BIZ}/logo/${OBJ}.webp%0A`],
    ];

    it.each(cases)('%s -> 404 MEDIA_NOT_FOUND, no-store, S3 never called', async (_label, path) => {
      const res = await http().get(path).set(asIp(nextIp())).redirects(0).expect(404);
      expect(res.body.errorCode).toBe('MEDIA_NOT_FOUND');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers.location).toBeUndefined();
      expect(store.head).not.toHaveBeenCalled();
      expect(store.presignGet).not.toHaveBeenCalled();
    });

    it('percent-encoded slashes decode to the very same key, which is then validated like any other', async () => {
      const encoded = `/media/businesses%2F${BIZ}%2Fproducts%2F${PROD}%2F${OBJ}.webp`;
      await http().get(encoded).set(asIp(nextIp())).redirects(0).expect(302);
      expect(store.head).toHaveBeenCalledWith(KEY);
      // …while an encoded dot-dot never forms a valid key.
      store.head.mockClear();
      await http()
        .get(`/media/businesses%2F${BIZ}%2Fproducts%2F..%2F${PROD}%2F${OBJ}.webp`)
        .set(asIp(nextIp()))
        .redirects(0)
        .expect(404);
      expect(store.head).not.toHaveBeenCalled();
    });

    it.each(cases.slice(0, 6))('HEAD: %s -> 404, S3 never called', async (_label, path) => {
      const res = await http().head(path).set(asIp(nextIp())).redirects(0).expect(404);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(store.head).not.toHaveBeenCalled();
      expect(store.presignGet).not.toHaveBeenCalled();
    });

    it('a bare /media/ is not a key either', async () => {
      await http().get('/media/').set(asIp(nextIp())).redirects(0).expect(404);
      expect(store.head).not.toHaveBeenCalled();
    });
  });

  describe('missing object and store failures', () => {
    it('a valid key whose object does not exist is a 404 and is never signed', async () => {
      const res = await http().get(`/media/${MISSING_KEY}`).set(asIp(nextIp())).redirects(0).expect(404);
      expect(res.body.errorCode).toBe('MEDIA_NOT_FOUND');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(store.head).toHaveBeenCalledWith(MISSING_KEY);
      expect(store.presignGet).not.toHaveBeenCalled();
    });

    it('an S3 failure is a generic 503 MEDIA_UNAVAILABLE that leaks nothing and is not cached', async () => {
      store.head.mockRejectedValue(
        new ObjectStoreUnavailableError('S3 HeadObject failed', { cause: new Error('AccessDenied secret-detail') }),
      );
      const res = await http().get(`/media/${KEY}`).set(asIp(nextIp())).redirects(0).expect(503);
      expect(res.body).toEqual({
        statusCode: 503,
        errorCode: 'MEDIA_UNAVAILABLE',
        message: 'Media temporarily unavailable',
      });
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  describe('rate limiting', () => {
    it('/media does not consume the global per-IP ceiling', async () => {
      const ip = nextIp();
      // More media requests than the global ceiling allows for any other route…
      for (let i = 0; i < GLOBAL + 2; i += 1) {
        await http().get(`/media/${KEY}`).set(asIp(ip)).redirects(0).expect(302);
      }
      // …and the same IP still has its whole global budget for everything else
      // (GET /products without a business is a DB-free 400).
      for (let i = 0; i < GLOBAL; i += 1) {
        await http().get('/products').set(asIp(ip)).expect(400);
      }
      await http().get('/products').set(asIp(ip)).expect(429);
    });

    it('its own per-IP limit ends in 429 RATE_LIMITED with Retry-After, GET and HEAD sharing it', async () => {
      const ip = nextIp();
      for (let i = 0; i < MEDIA_LIMIT; i += 1) {
        const even = i % 2 === 0;
        const verb = even ? http().get(`/media/${KEY}`) : http().head(`/media/${KEY}`);
        await verb.set(asIp(ip)).redirects(0).expect(even ? 302 : 200);
      }
      const res = await http().get(`/media/${KEY}`).set(asIp(ip)).redirects(0).expect(429);
      expect(res.body).toEqual({ statusCode: 429, errorCode: 'RATE_LIMITED', message: 'Too many requests' });
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      // Rejected requests never reach S3.
      expect(store.head).toHaveBeenCalledTimes(MEDIA_LIMIT);
    });

    it('is per IP: another client is unaffected', async () => {
      const blocked = nextIp();
      for (let i = 0; i < MEDIA_LIMIT; i += 1) {
        await http().get(`/media/${KEY}`).set(asIp(blocked)).redirects(0).expect(302);
      }
      await http().get(`/media/${KEY}`).set(asIp(blocked)).redirects(0).expect(429);
      await http().get(`/media/${KEY}`).set(asIp(nextIp())).redirects(0).expect(302);
    });

    it('invalid keys count against the same bucket (probing is not free)', async () => {
      const ip = nextIp();
      for (let i = 0; i < MEDIA_LIMIT; i += 1) {
        await http().get(`/media/not-a-key-${i}`).set(asIp(ip)).redirects(0).expect(404);
      }
      await http().get('/media/not-a-key-next').set(asIp(ip)).redirects(0).expect(429);
    });
  });
});
