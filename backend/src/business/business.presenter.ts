import { Injectable } from '@nestjs/common';
import { MediaUrlService } from '../media/media-url.service.js';
import type { Business } from './business.entity.js';

// What the API sends for a business: the entity minus the internal storage key,
// plus `logoUrl` — the stable /media URL derived from that key (null when the
// business has no logo).
export type BusinessResponse = Omit<Business, 'logoStorageKey'> & { logoUrl: string | null };

// The only place a Business leaves the API (besides the branding subset in
// the table-session join, which goes through logoUrl() below).
@Injectable()
export class BusinessPresenter {
  constructor(private readonly mediaUrls: MediaUrlService) {}

  present(business: Business): BusinessResponse {
    const { logoStorageKey, ...rest } = business;
    return { ...rest, logoUrl: this.mediaUrls.resolve(logoStorageKey) };
  }

  logoUrl(business: Pick<Business, 'logoStorageKey'>): string | null {
    return this.mediaUrls.resolve(business.logoStorageKey);
  }
}
