import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { ObjectStoreUnavailableError, S3ObjectStoreService } from './s3-object-store.service.js';
import type { S3Config } from './s3.config.js';

const KEY = 'businesses/aaaaaaaa-1111-4abc-8def-111111111abc/logo/cccccccc-3333-4abc-8def-333333333abc.webp';
const CONFIG: S3Config = {
  endpoint: 'https://t3.storageapi.dev',
  region: 'iad',
  bucket: 'mordwave-media-test',
  accessKeyId: 'AKIATESTACCESSKEY',
  secretAccessKey: 'test-secret-do-not-leak',
  forcePathStyle: false,
};

function fakeClient(send: (command: unknown) => unknown) {
  return { send: vi.fn(async (c: unknown) => send(c)) } as unknown as S3Client & { send: ReturnType<typeof vi.fn> };
}

describe('S3ObjectStoreService.presignGet', () => {
  // Signing is local, so a real client with fake credentials is enough to
  // verify the exact URL shape — no network involved.
  const service = new S3ObjectStoreService(CONFIG);

  it('produces a SigV4 URL for the bucket + key with the requested expiry (virtual-hosted)', async () => {
    const url = new URL(await service.presignGet(KEY, 3600));
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe('mordwave-media-test.t3.storageapi.dev');
    expect(url.pathname).toBe(`/${KEY}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get('X-Amz-Credential')).toContain('/iad/s3/aws4_request');
  });

  it('uses the bucket in the path when forcePathStyle is on', async () => {
    const pathStyle = new S3ObjectStoreService({ ...CONFIG, forcePathStyle: true });
    const url = new URL(await pathStyle.presignGet(KEY, 60));
    expect(url.hostname).toBe('t3.storageapi.dev');
    expect(url.pathname).toBe(`/mordwave-media-test/${KEY}`);
  });

  it('is a pure signing operation: the signature never contains the secret', async () => {
    expect(await service.presignGet(KEY, 3600)).not.toContain(CONFIG.secretAccessKey);
  });

  it.each([0, -1, 1.5, Number.NaN, 604801])('rejects expiresInSeconds=%s', async (ttl) => {
    await expect(service.presignGet(KEY, ttl)).rejects.toThrow(RangeError);
  });

  it.each(['', '/abs', 'a//b', 'a/../b', './a', '../a', 'a/.'])('rejects the key %j', async (key) => {
    await expect(service.presignGet(key, 60)).rejects.toThrow(RangeError);
  });
});

describe('S3ObjectStoreService.head', () => {
  it('returns metadata when the object exists, sending a HeadObject for the right bucket/key', async () => {
    const client = fakeClient(() => ({ ContentLength: 42, ContentType: 'image/webp' }));
    const service = new S3ObjectStoreService(CONFIG, client);
    expect(await service.head(KEY)).toEqual({ contentLength: 42, contentType: 'image/webp' });
    const command = client.send.mock.calls[0][0] as HeadObjectCommand;
    expect(command).toBeInstanceOf(HeadObjectCommand);
    expect(command.input).toEqual({ Bucket: 'mordwave-media-test', Key: KEY });
  });

  it.each([
    ['NotFound', { name: 'NotFound' }],
    ['NoSuchKey', { name: 'NoSuchKey' }],
    ['HTTP 404', { name: 'Whatever', $metadata: { httpStatusCode: 404 } }],
  ])('returns null for a missing object (%s)', async (_label, error) => {
    const service = new S3ObjectStoreService(
      CONFIG,
      fakeClient(() => {
        throw error;
      }),
    );
    expect(await service.head(KEY)).toBeNull();
  });

  it.each([
    ['403', { name: 'Forbidden', $metadata: { httpStatusCode: 403 } }],
    ['500', { name: 'InternalError', $metadata: { httpStatusCode: 500 } }],
    ['network', new Error('ECONNRESET')],
  ])('maps any other failure (%s) to ObjectStoreUnavailableError without leaking details', async (_l, error) => {
    const service = new S3ObjectStoreService(
      CONFIG,
      fakeClient(() => {
        throw error;
      }),
    );
    const failure = await service.head(KEY).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ObjectStoreUnavailableError);
    expect((failure as Error).message).toBe('S3 HeadObject failed');
  });

  it('rejects a malformed key before calling S3', async () => {
    const client = fakeClient(() => ({}));
    const service = new S3ObjectStoreService(CONFIG, client);
    await expect(service.head('a/../b')).rejects.toThrow(RangeError);
    expect(client.send).not.toHaveBeenCalled();
  });
});

describe('S3ObjectStoreService when not configured', () => {
  const service = new S3ObjectStoreService(null);

  it('reports it and fails closed', async () => {
    expect(service.isConfigured).toBe(false);
    await expect(service.head(KEY)).rejects.toBeInstanceOf(ObjectStoreUnavailableError);
    await expect(service.presignGet(KEY, 60)).rejects.toBeInstanceOf(ObjectStoreUnavailableError);
  });
});
