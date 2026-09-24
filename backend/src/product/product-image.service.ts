import { Injectable } from '@nestjs/common';
import { ImageStorageService, type UploadableFile } from '../storage/image-storage.service.js';

export type { UploadableFile };

// Thin, product-specific wrapper over the shared ImageStorageService — all
// validation/sharp/Supabase logic lives there now (see storage/
// image-storage.service.ts); this only knows how to build a product's own
// fixed path. Behavior for callers (ProductService) is unchanged: same
// method signatures, same validation rules, same path format.
@Injectable()
export class ProductImageService {
  constructor(private readonly imageStorage: ImageStorageService) {}

  private buildPath(businessId: string, productId: string): string {
    return `${businessId}/${productId}/imagen.webp`;
  }

  upload(businessId: string, productId: string, file: UploadableFile): Promise<string> {
    return this.imageStorage.upload(this.buildPath(businessId, productId), file);
  }

  remove(businessId: string, productId: string): Promise<void> {
    return this.imageStorage.remove(this.buildPath(businessId, productId));
  }
}
