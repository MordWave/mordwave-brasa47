import { Injectable } from '@nestjs/common';
import { MediaUrlService } from '../media/media-url.service.js';
import type { Business } from './business.entity.js';

// What the API sends for a business: the entity minus the internal storage keys,
// plus `logoUrl` / `coverUrl` — the stable /media URLs derived from those keys (null
// when the business has no logo / cover).
export type BusinessResponse = Omit<Business, 'logoStorageKey' | 'coverStorageKey'> & {
  logoUrl: string | null;
  coverUrl: string | null;
};

// Just enough to recognise a business in a picker (GET /businesses, SUPER_ADMIN only). An explicit whitelist: no
// address/phone/hours/colours, no storage key, no relations (users, products, tables...).
export type BusinessListRow = Pick<Business, 'id' | 'name' | 'slug' | 'active' | 'logoStorageKey'>;
export interface BusinessListItem {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  logoUrl: string | null;
}

// The only place a Business leaves the API (besides the branding subset in
// the table-session join, which goes through logoUrl() / coverUrl() below).
@Injectable()
export class BusinessPresenter {
  constructor(private readonly mediaUrls: MediaUrlService) {}

  present(business: Business): BusinessResponse {
    const { logoStorageKey, coverStorageKey, ...rest } = business;
    return {
      ...rest,
      logoUrl: this.mediaUrls.resolve(logoStorageKey),
      coverUrl: this.mediaUrls.resolve(coverStorageKey),
    };
  }

  presentListItem(row: BusinessListRow): BusinessListItem {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      active: row.active,
      logoUrl: this.mediaUrls.resolve(row.logoStorageKey),
    };
  }

  logoUrl(business: Pick<Business, 'logoStorageKey'>): string | null {
    return this.mediaUrls.resolve(business.logoStorageKey);
  }

  coverUrl(business: Pick<Business, 'coverStorageKey'>): string | null {
    return this.mediaUrls.resolve(business.coverStorageKey);
  }
}
