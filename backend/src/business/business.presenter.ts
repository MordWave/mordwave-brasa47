import { Injectable } from '@nestjs/common';
import { MediaUrlService } from '../media/media-url.service.js';
import type { Business } from './business.entity.js';

// What the API sends for a business: the entity minus internal storage
// bookkeeping, with `logoUrl` resolved (media URL when a storage key is
// usable, otherwise the legacy URL exactly as stored).
export type BusinessResponse = Omit<Business, 'logoStorageKey'>;

// The only place a Business leaves the API (besides the branding subset in
// the table-session join, which goes through logoUrl() below).
@Injectable()
export class BusinessPresenter {
  constructor(private readonly mediaUrls: MediaUrlService) {}

  present(business: Business): BusinessResponse {
    const { logoStorageKey, ...rest } = business;
    return { ...rest, logoUrl: this.mediaUrls.resolve(logoStorageKey, business.logoUrl) };
  }

  logoUrl(business: Pick<Business, 'logoUrl' | 'logoStorageKey'>): string | null {
    return this.mediaUrls.resolve(business.logoStorageKey, business.logoUrl);
  }
}
