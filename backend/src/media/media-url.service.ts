import { Injectable } from '@nestjs/common';
import { isMediaKey } from './media-key.util.js';

// Turns the storage key a row holds into the URL the API puts in a response:
// the stable /media/<key> URL, or null when there is no key or the URL can't be
// built (MEDIA_PUBLIC_BASE_URL unset, malformed key). Media comes only from the
// Railway Bucket behind /media; there is no other source and no fallback.
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

  // Whether stable /media URLs can be produced. Writers check this BEFORE
  // storing a key: a key whose URL can't be built would make the image
  // vanish from every response.
  get isConfigured(): boolean {
    return this.baseUrl !== null;
  }

  // The stable URL for a key, or null when there is no key or the URL can't be
  // built. Presenters call this for every image/logo they send.
  resolve(storageKey: string | null | undefined): string | null {
    if (!this.baseUrl || !storageKey || !isMediaKey(storageKey)) return null;
    return `${this.baseUrl}/media/${storageKey}`;
  }
}
