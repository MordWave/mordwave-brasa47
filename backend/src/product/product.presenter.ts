import { Injectable } from '@nestjs/common';
import type { Paginated } from '../common/pagination.util.js';
import { MediaUrlService } from '../media/media-url.service.js';
import type { Product } from './product.entity.js';

// What the API sends for a product: the entity minus the internal storage key,
// plus `imageUrl` — the stable /media URL derived from that key (null when the
// product has no image).
export type ProductResponse = Omit<Product, 'imageStorageKey'> & { imageUrl: string | null };

// The only place a Product leaves the API. Controllers never return the
// entity directly, so a new internal column can't leak by default.
@Injectable()
export class ProductPresenter {
  constructor(private readonly mediaUrls: MediaUrlService) {}

  present(product: Product): ProductResponse {
    const { imageStorageKey, ...rest } = product;
    return { ...rest, imageUrl: this.mediaUrls.resolve(imageStorageKey) };
  }

  presentMany(products: Product[]): ProductResponse[] {
    return products.map((product) => this.present(product));
  }

  presentPage(page: Paginated<Product>): Paginated<ProductResponse> {
    return { ...page, items: this.presentMany(page.items) };
  }
}
