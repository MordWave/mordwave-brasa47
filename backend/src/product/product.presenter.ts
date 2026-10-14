import { Injectable } from '@nestjs/common';
import type { Paginated } from '../common/pagination.util.js';
import { MediaUrlService } from '../media/media-url.service.js';
import type { Product } from './product.entity.js';

// What the API sends for a product: the entity minus internal storage
// bookkeeping, with `imageUrl` resolved (media URL when a storage key is
// usable, otherwise the legacy URL exactly as stored).
export type ProductResponse = Omit<Product, 'imageStorageKey'>;

// The only place a Product leaves the API. Controllers never return the
// entity directly, so a new internal column can't leak by default.
@Injectable()
export class ProductPresenter {
  constructor(private readonly mediaUrls: MediaUrlService) {}

  present(product: Product): ProductResponse {
    const { imageStorageKey, ...rest } = product;
    return { ...rest, imageUrl: this.mediaUrls.resolve(imageStorageKey, product.imageUrl) };
  }

  presentMany(products: Product[]): ProductResponse[] {
    return products.map((product) => this.present(product));
  }

  presentPage(page: Paginated<Product>): Paginated<ProductResponse> {
    return { ...page, items: this.presentMany(page.items) };
  }
}
