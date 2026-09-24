import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductImageService } from './product-image.service.js';

// The actual validation/sharp/Supabase pipeline is now ImageStorageService's
// responsibility (see storage/image-storage.service.spec.ts for that full
// behavioral suite) — this only needs to verify ProductImageService keeps
// building the exact same fixed path it always did and correctly forwards
// to/from the shared service. Confirms the Fase 7 extraction didn't change
// anything a product upload/remove call actually does.
describe('ProductImageService', () => {
  let service: ProductImageService;
  let imageStorage: { upload: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    imageStorage = { upload: vi.fn(), remove: vi.fn() };
    service = new ProductImageService(imageStorage as never);
  });

  it('upload() delegates to ImageStorageService with the same fixed path as before and returns its URL', async () => {
    const file = { buffer: Buffer.from('png-bytes'), size: 100 };
    imageStorage.upload.mockResolvedValue('https://cdn.example/biz-1/prod-1/imagen.webp?v=123');

    const url = await service.upload('biz-1', 'prod-1', file);

    expect(imageStorage.upload).toHaveBeenCalledWith('biz-1/prod-1/imagen.webp', file);
    expect(url).toBe('https://cdn.example/biz-1/prod-1/imagen.webp?v=123');
  });

  it('remove() delegates to ImageStorageService with the same fixed path as before', async () => {
    await service.remove('biz-1', 'prod-1');

    expect(imageStorage.remove).toHaveBeenCalledWith('biz-1/prod-1/imagen.webp');
  });

  it('propagates a rejection from ImageStorageService.upload unchanged', async () => {
    const boom = new Error('boom');
    imageStorage.upload.mockRejectedValue(boom);

    await expect(service.upload('biz-1', 'prod-1', { buffer: Buffer.from('x'), size: 1 })).rejects.toBe(
      boom,
    );
  });
});
