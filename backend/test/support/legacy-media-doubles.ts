import { createHash } from 'node:crypto';
import type {
  BucketPort,
  FetchedBytes,
  HttpProbe,
  LegacyRow,
  Manifest,
  ManifestStore,
  ProbeResponse,
  RowKind,
  RowRepository,
  SourceStore,
} from '../../src/scripts/legacy-media/types.js';

// In-memory ports shared by the unit spec and the e2e spec. They record every
// call so tests can prove what was — and was not — written.

export const SUPABASE_HOST = 'abc.supabase.co';
export const SUPABASE_BUCKET = 'product-images';
export const MEDIA_BASE = 'https://api.example.test';
export const BUCKET_HOST = 'https://fake-bucket.example';

export const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

export function webp(payload: string): Buffer {
  return Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), Buffer.from(payload)]);
}

export function productUrl(businessId: string, productId: string, v = 1): string {
  return `https://${SUPABASE_HOST}/storage/v1/object/public/${SUPABASE_BUCKET}/${businessId}/${productId}/imagen.webp?v=${v}`;
}
export function logoUrl(businessId: string, v = 1): string {
  return `https://${SUPABASE_HOST}/storage/v1/object/public/${SUPABASE_BUCKET}/business-logos/${businessId}/logo.webp?v=${v}`;
}

export class FakeRows implements RowRepository {
  rows = new Map<string, LegacyRow>();
  setCalls: Array<{ kind: RowKind; id: string; key: string; expectedLegacyUrl: string }> = [];
  // Test hook: runs right before setStorageKey evaluates its preconditions.
  beforeSet?: (kind: RowKind, id: string) => void;

  private k = (kind: RowKind, id: string) => `${kind}:${id}`;
  add(row: LegacyRow): void {
    this.rows.set(this.k(row.kind, row.id), { ...row });
  }
  get(kind: RowKind, id: string): LegacyRow {
    return this.rows.get(this.k(kind, id))!;
  }
  async listRows(): Promise<LegacyRow[]> {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
  async fetchRow(kind: RowKind, id: string): Promise<LegacyRow | null> {
    const r = this.rows.get(this.k(kind, id));
    return r ? { ...r } : null;
  }
  async setStorageKey(kind: RowKind, id: string, key: string, expectedLegacyUrl: string): Promise<boolean> {
    this.setCalls.push({ kind, id, key, expectedLegacyUrl });
    this.beforeSet?.(kind, id);
    const r = this.rows.get(this.k(kind, id));
    if (!r || r.deleted || r.storageKey !== null || r.legacyUrl !== expectedLegacyUrl) return false;
    r.storageKey = key; // the ONLY field this repository ever changes
    return true;
  }
}

export class FakeSource implements SourceStore {
  objects = new Map<string, Buffer>();
  downloads: string[] = [];
  async download(url: string): Promise<FetchedBytes> {
    this.downloads.push(url);
    const bytes = this.objects.get(url);
    return bytes
      ? { status: 200, contentType: 'image/webp', bytes }
      : { status: 404, contentType: null, bytes: Buffer.alloc(0) };
  }
}

export class FakeBucket implements BucketPort {
  objects = new Map<string, { body: Buffer; contentType: string; cacheControl: string; metadata?: Record<string, string> }>();
  puts: string[] = [];
  // Test hooks.
  corruptOnPut = false;
  async head(key: string) {
    const o = this.objects.get(key);
    return o ? { contentLength: o.body.length, contentType: o.contentType } : null;
  }
  async put(key: string, body: Buffer, contentType: string, cacheControl: string, metadata?: Record<string, string>) {
    this.puts.push(key);
    this.objects.set(key, { body: this.corruptOnPut ? Buffer.concat([body, Buffer.from('x')]) : body, contentType, cacheControl, metadata });
  }
  async presignGet(key: string): Promise<string> {
    return `${BUCKET_HOST}/${key}?sig=1`;
  }
}

// Emulates the public path: GET /media/<key> -> 302 -> bucket URL -> bytes.
export class FakeProbe implements HttpProbe {
  constructor(private readonly bucket: FakeBucket) {}
  mediaBroken = false;
  async get(url: string): Promise<ProbeResponse> {
    if (url.startsWith(`${MEDIA_BASE}/media/`)) {
      const key = url.slice(`${MEDIA_BASE}/media/`.length);
      if (this.mediaBroken || !this.bucket.objects.has(key)) return { status: 404, location: null, contentType: null, bytes: Buffer.alloc(0) };
      return { status: 302, location: `${BUCKET_HOST}/${key}?sig=1`, contentType: null, bytes: Buffer.alloc(0) };
    }
    if (url.startsWith(`${BUCKET_HOST}/`)) {
      const key = url.slice(BUCKET_HOST.length + 1).split('?')[0];
      const o = this.bucket.objects.get(key);
      return o
        ? { status: 200, location: null, contentType: o.contentType, bytes: o.body }
        : { status: 404, location: null, contentType: null, bytes: Buffer.alloc(0) };
    }
    return { status: 404, location: null, contentType: null, bytes: Buffer.alloc(0) };
  }
  async head(url: string): Promise<ProbeResponse> {
    const key = url.slice(`${MEDIA_BASE}/media/`.length);
    const ok = !this.mediaBroken && this.bucket.objects.has(key);
    return { status: ok ? 200 : 404, location: null, contentType: null, bytes: Buffer.alloc(0) };
  }
}

export class MemoryManifest implements ManifestStore {
  value: Manifest | null = null;
  saves = 0;
  async load(): Promise<Manifest | null> {
    return this.value ? (JSON.parse(JSON.stringify(this.value)) as Manifest) : null;
  }
  async save(manifest: Manifest): Promise<void> {
    this.saves += 1;
    this.value = JSON.parse(JSON.stringify(manifest)) as Manifest;
  }
}
