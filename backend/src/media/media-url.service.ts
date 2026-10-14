import { Injectable } from '@nestjs/common';
import { isMediaKey } from './media-key.util.js';

// Turns what the DB stores into the URL the API puts in a response.
//
// The one rule, used by every presenter: a storage key wins when it can be
// turned into a /media URL; otherwise the legacy URL is returned untouched.
// "Can be turned into a URL" means MEDIA_PUBLIC_BASE_URL is configured and the
// key has a valid shape. Until the /media endpoint ships and that variable is
// set, every response is byte-for-byte what it was before the keys existed.
//
// MEDIA_PUBLIC_BASE_URL is the public origin of THIS API (e.g.
// https://api.example.com), not the bucket: the bucket is private and /media
// answers with a short-lived signed redirect.
@Injectable()
export class MediaUrlService {
  private readonly baseUrl: string | null;

  constructor() {
    this.baseUrl = MediaUrlService.parseBaseUrl(process.env.MEDIA_PUBLIC_BASE_URL);
  }

  // Unset/blank -> null (feature off). Set but malformed -> throw, so a typo
  // fails the boot instead of silently producing broken image links.
  static parseBaseUrl(raw: string | undefined): string | null {
    const value = raw?.trim();
    if (!value) return null;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error('MEDIA_PUBLIC_BASE_URL must be an absolute URL');
    }
    // https everywhere except a local dev server: these URLs end up in
    // <img src> on an https page, so an http:// base would be blocked as
    // mixed content in production.
    const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
      throw new Error('MEDIA_PUBLIC_BASE_URL must be an https URL (http is only allowed for localhost)');
    }
    if (url.search || url.hash || url.username || url.password) {
      throw new Error('MEDIA_PUBLIC_BASE_URL must not contain credentials, a query or a fragment');
    }
    return url.origin + url.pathname.replace(/\/+$/, '');
  }

  // Stable URL for a key, or null when the media URL can't be built.
  urlForKey(storageKey: string | null | undefined): string | null {
    if (!this.baseUrl || !storageKey || !isMediaKey(storageKey)) return null;
    return `${this.baseUrl}/media/${storageKey}`;
  }

  resolve(storageKey: string | null | undefined, legacyUrl: string | null | undefined): string | null {
    return this.urlForKey(storageKey) ?? legacyUrl ?? null;
  }
}
