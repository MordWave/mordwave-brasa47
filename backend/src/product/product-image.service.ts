import { Injectable } from '@nestjs/common';
import { productImageKey } from '../media/media-key.util.js';
import { ImageStorageService, type UploadableFile } from '../storage/image-storage.service.js';

export type { UploadableFile };

// Thin, product-specific wrapper over the shared ImageStorageService — all
// validation/sharp/bucket logic lives there; this only knows how to build a
// product's storage key. Every upload gets a NEW key (fresh uuid), so a
// replaced image never overwrites the previous object and is never served
// stale from a browser/CDN cache.
@Injectable()
export class ProductImageService {
  constructor(private readonly imageStorage: ImageStorageService) {}

  // Resolves with the new storage key once the object is in the bucket.
  async upload(businessId: string, productId: string, file: UploadableFile): Promise<string> {
    return this.imageStorage.upload(productImageKey(businessId, productId), file);
  }
}
