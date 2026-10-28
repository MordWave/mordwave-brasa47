import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Business } from '../business/business.entity.js';
import { CategoryService } from '../category/category.service.js';
import { MediaUrlService } from '../media/media-url.service.js';
import { ProductService } from '../product/product.service.js';
import { isBusinessSlug } from './business-slug.util.js';

// What a visitor of the shareable menu may see. An explicit whitelist, field by field: no ids of the business, no
// storage keys, no users, no timestamps, no ingredients/add-ons (those belong to the ordering flow, not to a read-only menu).
export interface PublicMenuBusiness {
  name: string;
  slug: string;
  logoUrl: string | null;
  coverUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
}
export interface PublicMenuCategory {
  id: string;
  name: string;
  slug: string;
  sortOrder: number;
}
export interface PublicMenuProduct {
  id: string;
  categoryId: string;
  name: string;
  description: string | null;
  price: number;
  imageUrl: string | null;
  tag: string | null;
  available: boolean;
  sortOrder: number;
}
export interface PublicMenu {
  business: PublicMenuBusiness;
  categories: PublicMenuCategory[];
  products: PublicMenuProduct[];
}

const NOT_FOUND = { message: 'Business not found', errorCode: 'BUSINESS_NOT_FOUND' };

// One unauthenticated read for ONE restaurant, identified by its public slug. It reuses the visibility rules of the existing
// public endpoints (CategoryService/ProductService.findAllPublic: active categories, active products inside active
// categories, deterministic order, per-business list ceilings) and scopes both by the business id resolved here, so nothing of
// another restaurant can appear. An unknown, malformed or inactive slug is the same 404 as the existing public reads.
@Injectable()
export class PublicMenuService {
  constructor(
    @InjectRepository(Business) private readonly businesses: Repository<Business>,
    private readonly categories: CategoryService,
    private readonly products: ProductService,
    private readonly mediaUrls: MediaUrlService,
  ) {}

  async getMenu(slug: string): Promise<PublicMenu> {
    // A value that cannot be a slug never reaches the database.
    if (!isBusinessSlug(slug)) throw new NotFoundException(NOT_FOUND);
    const business = await this.businesses.findOne({
      select: { id: true, name: true, slug: true, logoStorageKey: true, coverStorageKey: true, primaryColor: true, accentColor: true },
      where: { slug, active: true },
    });
    if (!business) throw new NotFoundException(NOT_FOUND);

    const [categories, products] = await Promise.all([
      this.categories.findAllPublic({ businessId: business.id }),
      this.products.findAllPublic({ businessId: business.id }),
    ]);

    return {
      business: {
        name: business.name,
        slug: business.slug,
        logoUrl: this.mediaUrls.resolve(business.logoStorageKey),
        coverUrl: this.mediaUrls.resolve(business.coverStorageKey),
        primaryColor: business.primaryColor ?? null,
        accentColor: business.accentColor ?? null,
      },
      categories: categories.map((c) => ({ id: c.id, name: c.name, slug: c.slug, sortOrder: c.sortOrder })),
      products: products.map((p) => ({
        id: p.id,
        categoryId: p.categoryId,
        name: p.name,
        description: p.description ?? null,
        price: p.price,
        imageUrl: this.mediaUrls.resolve(p.imageStorageKey),
        tag: p.tag ?? null,
        available: p.available,
        sortOrder: p.sortOrder,
      })),
    };
  }
}
