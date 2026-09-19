import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { fileTypeFromBuffer } from 'file-type';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductImageService } from './product-image.service.js';

// vi.mock() factories are hoisted above imports, so any shared mutable state
// they close over must go through vi.hoisted() — a plain top-level const
// would still be uninitialized at the point the hoisted factory runs.
const { sharpChain, storageFromMock } = vi.hoisted(() => ({
  sharpChain: {
    rotate: vi.fn(),
    resize: vi.fn(),
    webp: vi.fn(),
    toBuffer: vi.fn(),
  },
  storageFromMock: {
    upload: vi.fn(),
    remove: vi.fn(),
    getPublicUrl: vi.fn(),
  },
}));

vi.mock('sharp', () => ({
  default: vi.fn(() => sharpChain),
}));

vi.mock('file-type', () => ({
  fileTypeFromBuffer: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    storage: { from: vi.fn(() => storageFromMock) },
  })),
}));

function getErrorBody(error: unknown): Record<string, unknown> {
  return (error as { getResponse: () => Record<string, unknown> }).getResponse();
}

describe('ProductImageService', () => {
  let service: ProductImageService;

  beforeEach(() => {
    vi.mocked(fileTypeFromBuffer).mockReset();
    sharpChain.rotate.mockReturnValue(sharpChain);
    sharpChain.resize.mockReturnValue(sharpChain);
    sharpChain.webp.mockReturnValue(sharpChain);
    sharpChain.toBuffer.mockReset().mockResolvedValue(Buffer.from('webp-bytes'));
    storageFromMock.getPublicUrl.mockReset().mockReturnValue({
      data: {
        publicUrl:
          'https://project.supabase.co/storage/v1/object/public/product-images/biz-1/prod-1/imagen.webp',
      },
    });
    storageFromMock.upload.mockReset().mockResolvedValue({ error: null });
    storageFromMock.remove.mockReset().mockResolvedValue({ error: null });

    service = new ProductImageService({
      url: 'https://project.supabase.co',
      secretKey: 'test-secret',
      bucket: 'product-images',
    });
  });

  it('rejects a file over the size limit before touching format/processing', async () => {
    const file = { buffer: Buffer.from('x'), size: 11 * 1024 * 1024 };

    const error = await service.upload('biz-1', 'prod-1', file).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(getErrorBody(error)).toEqual(expect.objectContaining({ errorCode: 'IMAGE_TOO_LARGE' }));
    expect(fileTypeFromBuffer).not.toHaveBeenCalled();
  });

  it('rejects an undetectable format', async () => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue(undefined);
    const file = { buffer: Buffer.from('not-an-image'), size: 100 };

    const error = await service.upload('biz-1', 'prod-1', file).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(getErrorBody(error)).toEqual(
      expect.objectContaining({ errorCode: 'IMAGE_INVALID_FORMAT' }),
    );
  });

  it('rejects a real but disallowed format (e.g. a PDF renamed to look like an image)', async () => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue({ mime: 'application/pdf', ext: 'pdf' });
    const file = { buffer: Buffer.from('pdf-bytes'), size: 100 };

    const error = await service.upload('biz-1', 'prod-1', file).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(getErrorBody(error)).toEqual(
      expect.objectContaining({ errorCode: 'IMAGE_INVALID_FORMAT' }),
    );
  });

  it('wraps a sharp processing failure as IMAGE_PROCESSING_FAILED without leaking the raw error', async () => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue({ mime: 'image/heic', ext: 'heic' });
    sharpChain.toBuffer.mockRejectedValue(new Error('libheif not compiled in (internal detail)'));
    const file = { buffer: Buffer.from('heic-bytes'), size: 100 };

    const error = await service.upload('biz-1', 'prod-1', file).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BadRequestException);
    const body = getErrorBody(error);
    expect(body).toEqual(expect.objectContaining({ errorCode: 'IMAGE_PROCESSING_FAILED' }));
    expect(JSON.stringify(body)).not.toContain('libheif');
  });

  it('wraps a Storage upload failure as IMAGE_UPLOAD_FAILED (502) without leaking the raw error', async () => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue({ mime: 'image/jpeg', ext: 'jpg' });
    storageFromMock.upload.mockResolvedValue({
      error: { message: 'some internal supabase storage detail' },
    });
    const file = { buffer: Buffer.from('jpeg-bytes'), size: 100 };

    const error = await service.upload('biz-1', 'prod-1', file).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BadGatewayException);
    const body = getErrorBody(error);
    expect(body).toEqual(expect.objectContaining({ errorCode: 'IMAGE_UPLOAD_FAILED' }));
    expect(JSON.stringify(body)).not.toContain('supabase storage detail');
  });

  it('on success, uploads to the fixed path and returns a cache-busted public URL', async () => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue({ mime: 'image/png', ext: 'png' });
    const file = { buffer: Buffer.from('png-bytes'), size: 100 };

    const url = await service.upload('biz-1', 'prod-1', file);

    expect(storageFromMock.upload).toHaveBeenCalledWith(
      'biz-1/prod-1/imagen.webp',
      expect.any(Buffer),
      expect.objectContaining({ contentType: 'image/webp', upsert: true }),
    );
    expect(url).toMatch(/\/product-images\/biz-1\/prod-1\/imagen\.webp\?v=\d+$/);
  });

  it('remove() deletes the fixed path', async () => {
    await service.remove('biz-1', 'prod-1');

    expect(storageFromMock.remove).toHaveBeenCalledWith(['biz-1/prod-1/imagen.webp']);
  });

  it('remove() wraps a Storage failure as IMAGE_UPLOAD_FAILED', async () => {
    storageFromMock.remove.mockResolvedValue({ error: { message: 'boom' } });

    await expect(service.remove('biz-1', 'prod-1')).rejects.toBeInstanceOf(BadGatewayException);
  });
});
