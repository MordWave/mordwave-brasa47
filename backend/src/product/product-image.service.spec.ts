import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isProductImageKey } from '../media/media-key.util.js';
import { ProductImageService } from './product-image.service.js';

const BIZ = 'aaaaaaaa-1111-4abc-8def-111111111abc';
const PROD = 'bbbbbbbb-2222-4abc-8def-222222222abc';

// The validation/sharp/bucket pipeline is ImageStorageService's job (see
// storage/image-storage.service.spec.ts). This only verifies that
// ProductImageService builds a fresh, valid product key per upload and
// forwards to the shared service.
describe('ProductImageService', () => {
  let service: ProductImageService;
  let imageStorage: { upload: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    imageStorage = { upload: vi.fn(async (key: string) => key) };
    service = new ProductImageService(imageStorage as never);
  });

  it('upload() builds a businesses/<biz>/products/<prod>/<uuid>.webp key and returns it', async () => {
    const file = { buffer: Buffer.from('png-bytes'), size: 100 };

    const key = await service.upload(BIZ, PROD, file);

    expect(isProductImageKey(key)).toBe(true);
    expect(key.startsWith(`businesses/${BIZ}/products/${PROD}/`)).toBe(true);
    expect(imageStorage.upload).toHaveBeenCalledWith(key, file);
  });

  it('every upload gets a different key (a replacement never overwrites the previous object)', async () => {
    const file = { buffer: Buffer.from('x'), size: 1 };
    const first = await service.upload(BIZ, PROD, file);
    const second = await service.upload(BIZ, PROD, file);
    expect(first).not.toBe(second);
  });

  it('has no remove(): nothing deletes objects during the transition', () => {
    expect((service as unknown as Record<string, unknown>).remove).toBeUndefined();
  });

  it('refuses ids that are not uuids before touching storage', async () => {
    await expect(service.upload('biz-1', PROD, { buffer: Buffer.from('x'), size: 1 })).rejects.toThrow();
    expect(imageStorage.upload).not.toHaveBeenCalled();
  });

  it('propagates a rejection from ImageStorageService.upload unchanged', async () => {
    const boom = new Error('boom');
    imageStorage.upload.mockRejectedValue(boom);

    await expect(service.upload(BIZ, PROD, { buffer: Buffer.from('x'), size: 1 })).rejects.toBe(boom);
  });
});
