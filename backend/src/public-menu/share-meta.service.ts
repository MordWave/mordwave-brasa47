import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Business } from '../business/business.entity.js';
import { MediaUrlService } from '../media/media-url.service.js';
import { isBusinessSlug } from './business-slug.util.js';
import { allowedFrontendOrigins, allowedOrigin } from './share-origin.util.js';
import { renderShareMeta } from './share-meta.render.js';

// The link-preview <head> fragment for the public menu of ONE active restaurant, or '' when there is none to describe. Unknown,
// malformed and inactive slugs all give the same empty answer, so the caller keeps its generic page and nothing about a
// restaurant that is not public can be learned from it. Only the name and the logo/cover are read: no menu, no products.
@Injectable()
export class ShareMetaService {
  private readonly frontendOrigins = allowedFrontendOrigins();

  constructor(
    @InjectRepository(Business) private readonly businesses: Repository<Business>,
    private readonly mediaUrls: MediaUrlService,
  ) {}

  async render(slug: unknown, requestedOrigin: unknown): Promise<string> {
    if (!isBusinessSlug(slug)) return '';
    const business = await this.businesses.findOne({
      select: { id: true, name: true, slug: true, logoStorageKey: true, coverStorageKey: true },
      where: { slug, active: true },
    });
    if (!business) return '';

    const cover = this.mediaUrls.resolve(business.coverStorageKey);
    const logo = this.mediaUrls.resolve(business.logoStorageKey);
    return renderShareMeta({
      name: business.name,
      slug: business.slug,
      origin: allowedOrigin(requestedOrigin, this.frontendOrigins),
      image: cover ? { url: cover, kind: 'cover' } : logo ? { url: logo, kind: 'logo' } : null,
    });
  }
}
