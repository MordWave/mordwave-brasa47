import { Injectable } from '@nestjs/common';
import { isMediaKey } from './media-key.util.js';

// Turns what the DB stores into the URL the API puts in a response.
//
// The one rule, used by every presenter:
//   - a row WITH a storage key is served from /media (or no image at all if the
//     /media URL can't be built: MEDIA_PUBLIC_BASE_URL unset or a malformed
//     key). It never falls back to the legacy URL: Supabase is not part of the
//     normal media flow any more.
//   - a row WITHOUT a storage key keeps its legacy URL untouched (the rollback
//     copy / rows not migrated yet).
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

  // Stable URL for a key, or null when the media URL can't be built.
  urlForKey(storageKey: string | null | undefined): string | null {
    if (!this.baseUrl || !storageKey || !isMediaKey(storageKey)) return null;
    return `${this.baseUrl}/media/${storageKey}`;
  }

  resolve(storageKey: string | null | undefined, legacyUrl: string | null | undefined): string | null {
    if (storageKey) return this.urlForKey(storageKey);
    return legacyUrl ?? null;
  }
}
