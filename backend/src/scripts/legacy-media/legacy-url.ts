import type { RowKind } from './types.js';

export interface SupabaseUrlContext {
  // Host of SUPABASE_URL, e.g. "abcd.supabase.co".
  supabaseHost: string;
  bucket: string;
}

export type ParsedLegacyUrl =
  | { kind: 'supabase'; objectPath: string }
  | { kind: 'other' };

// A legacy URL counts as "ours" only if it is a plain https public-object URL
// on the configured Supabase host and bucket. Anything else (another host, a
// signed URL, credentials in the URL...) is classified as "other" and never
// downloaded.
export function parseLegacyUrl(raw: string, context: SupabaseUrlContext): ParsedLegacyUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: 'other' };
  }
  if (url.protocol !== 'https:' || url.username || url.password) return { kind: 'other' };
  if (url.hostname !== context.supabaseHost) return { kind: 'other' };
  const prefix = `/storage/v1/object/public/${context.bucket}/`;
  if (!url.pathname.startsWith(prefix)) return { kind: 'other' };
  let objectPath: string;
  try {
    objectPath = decodeURIComponent(url.pathname.slice(prefix.length));
  } catch {
    return { kind: 'other' };
  }
  if (!objectPath || objectPath.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    return { kind: 'other' };
  }
  return { kind: 'supabase', objectPath };
}

// Where the old code stored an image (ProductImageService / BusinessService
// before PR 3). A row whose URL points anywhere else is an anomaly.
export function expectedLegacyObjectPath(kind: RowKind, businessId: string, rowId: string): string {
  return kind === 'product' ? `${businessId}/${rowId}/imagen.webp` : `business-logos/${businessId}/logo.webp`;
}

// RIFF....WEBP
export function looksLikeWebp(bytes: Buffer): boolean {
  return (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  );
}
