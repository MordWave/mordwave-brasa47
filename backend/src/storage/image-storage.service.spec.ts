import { BadGatewayException, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { fileTypeFromBuffer } from 'file-type';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectStoreUnavailableError } from '../media/s3-object-store.service.js';
import { ImageStorageService } from './image-storage.service.js';

// vi.mock() factories are hoisted above imports, so any shared mutable state
// they close over must go through vi.hoisted() — a plain top-level const
// would still be uninitialized at the point the hoisted factory runs.
const { sharpChain, sharpFn } = vi.hoisted(() => {
  const chain = {
    rotate: vi.fn(),
    resize: vi.fn(),
    webp: vi.fn(),
    toBuffer: vi.fn(),
  };
  return { sharpChain: chain, sharpFn: vi.fn(() => chain) };
});

vi.mock('sharp', () => ({
  default: sharpFn,
}));

vi.mock('file-type', () => ({
  fileTypeFromBuffer: vi.fn(),
}));

const BIZ = 'aaaaaaaa-1111-4abc-8def-111111111abc';
const PROD = 'bbbbbbbb-2222-4abc-8def-222222222abc';
const OBJ = 'cccccccc-3333-4abc-8def-333333333abc';
const KEY = `businesses/${BIZ}/products/${PROD}/${OBJ}.webp`;
const LOGO_KEY = `businesses/${BIZ}/logo/${OBJ}.webp`;

function getErrorBody(error: unknown): Record<string, unknown> {
  return (error as { getResponse: () => Record<string, unknown> }).getResponse();
}

describe('ImageStorageService', () => {
  let service: ImageStorageService;
  let store: { isConfigured: boolean; put: ReturnType<typeof vi.fn> };
  let mediaUrls: { isConfigured: boolean };

  beforeEach(() => {
    vi.mocked(fileTypeFromBuffer).mockReset();
    sharpFn.mockClear();
    sharpChain.rotate.mockReset().mockReturnValue(sharpChain);
    sharpChain.resize.mockReset().mockReturnValue(sharpChain);
    sharpChain.webp.mockReset().mockReturnValue(sharpChain);
    sharpChain.toBuffer.mockReset().mockResolvedValue(Buffer.from('webp-bytes'));

    store = { isConfigured: true, put: vi.fn().mockResolvedValue(undefined) };
    mediaUrls = { isConfigured: true };
    service = new ImageStorageService(store as never, mediaUrls as never);
  });

  it('rejects a file over the size limit before touching format/processing', async () => {
    const file = { buffer: Buffer.from('x'), size: 11 * 1024 * 1024 };

    const error = await service.upload(KEY, file).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(getErrorBody(error)).toEqual(expect.objectContaining({ errorCode: 'IMAGE_TOO_LARGE' }));
    expect(fileTypeFromBuffer).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
  });

  it('rejects an undetectable format', async () => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue(undefined);
    const file = { buffer: Buffer.from('not-an-image'), size: 100 };

    const error = await service.upload(KEY, file).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(getErrorBody(error)).toEqual(
      expect.objectContaining({ errorCode: 'IMAGE_INVALID_FORMAT' }),
    );
    expect(store.put).not.toHaveBeenCalled();
  });

  it('rejects a real but disallowed format (e.g. a PDF renamed to look like an image)', async () => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue({ mime: 'application/pdf', ext: 'pdf' });
    const file = { buffer: Buffer.from('pdf-bytes'), size: 100 };

    const error = await service.upload(KEY, file).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(getErrorBody(error)).toEqual(
      expect.objectContaining({ errorCode: 'IMAGE_INVALID_FORMAT' }),
    );
    expect(store.put).not.toHaveBeenCalled();
  });

  it('wraps a sharp processing failure as IMAGE_PROCESSING_FAILED without leaking the raw error', async () => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue({ mime: 'image/heic', ext: 'heic' });
    sharpChain.toBuffer.mockRejectedValue(new Error('libheif not compiled in (internal detail)'));
    const file = { buffer: Buffer.from('heic-bytes'), size: 100 };

    const error = await service.upload(KEY, file).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BadRequestException);
    const body = getErrorBody(error);
    expect(body).toEqual(expect.objectContaining({ errorCode: 'IMAGE_PROCESSING_FAILED' }));
    expect(JSON.stringify(body)).not.toContain('libheif');
    expect(store.put).not.toHaveBeenCalled();
  });

  it('keeps the existing processing pipeline: auto-rotate, max 1200px inside, WebP quality 80', async () => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue({ mime: 'image/jpeg', ext: 'jpg' });

    await service.upload(KEY, { buffer: Buffer.from('jpeg-bytes'), size: 100 });

    expect(sharpChain.rotate).toHaveBeenCalledTimes(1);
    expect(sharpChain.resize).toHaveBeenCalledWith({
      width: 1200,
      height: 1200,
      fit: 'inside',
      withoutEnlargement: true,
    });
    expect(sharpChain.webp).toHaveBeenCalledWith({ quality: 80 });
  });

  it('on success, puts the processed WebP at the given key with immutable cache headers and returns the key', async () => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue({ mime: 'image/png', ext: 'png' });
    const file = { buffer: Buffer.from('png-bytes'), size: 100 };

    const result = await service.upload(KEY, file);

    expect(result).toBe(KEY);
    expect(store.put).toHaveBeenCalledTimes(1);
    expect(store.put).toHaveBeenCalledWith(
      KEY,
      Buffer.from('webp-bytes'),
      'image/webp',
      'public, max-age=31536000, immutable',
    );
  });

  it('works for a business logo key too', async () => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue({ mime: 'image/png', ext: 'png' });

    await expect(service.upload(LOGO_KEY, { buffer: Buffer.from('png'), size: 3 })).resolves.toBe(LOGO_KEY);
    expect(store.put).toHaveBeenCalledWith(LOGO_KEY, expect.any(Buffer), 'image/webp', expect.any(String));
  });

  it('wraps a bucket failure as IMAGE_UPLOAD_FAILED (502) without leaking the raw error', async () => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue({ mime: 'image/jpeg', ext: 'jpg' });
    store.put.mockRejectedValue(
      new ObjectStoreUnavailableError('S3 PutObject failed', { cause: new Error('AccessDenied internal detail') }),
    );

    const error = await service
      .upload(KEY, { buffer: Buffer.from('jpeg-bytes'), size: 100 })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BadGatewayException);
    const body = getErrorBody(error);
    expect(body).toEqual(expect.objectContaining({ errorCode: 'IMAGE_UPLOAD_FAILED' }));
    expect(JSON.stringify(body)).not.toContain('AccessDenied');
  });

  it('fails closed (503) before any processing when the bucket is not configured', async () => {
    store.isConfigured = false;

    const error = await service.upload(KEY, { buffer: Buffer.from('x'), size: 1 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(getErrorBody(error)).toEqual(expect.objectContaining({ errorCode: 'IMAGE_STORAGE_UNAVAILABLE' }));
    expect(fileTypeFromBuffer).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
  });

  it('fails closed (503) when MEDIA_PUBLIC_BASE_URL is missing: a key with no buildable URL would make the image vanish', async () => {
    mediaUrls.isConfigured = false;

    const error = await service.upload(KEY, { buffer: Buffer.from('x'), size: 1 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(store.put).not.toHaveBeenCalled();
  });

  it.each([
    ['legacy supabase path', 'biz-1/prod-1/imagen.webp'],
    ['traversal', `businesses/${BIZ}/products/../${OBJ}.webp`],
    ['empty', ''],
  ])('refuses a key that is not a valid media key (%s)', async (_label, badKey) => {
    await expect(service.upload(badKey, { buffer: Buffer.from('x'), size: 1 })).rejects.toThrow(
      /valid media storage key/,
    );
    expect(store.put).not.toHaveBeenCalled();
  });

  it('has no remove(): nothing deletes objects during the transition', () => {
    expect((service as unknown as Record<string, unknown>).remove).toBeUndefined();
  });
});
