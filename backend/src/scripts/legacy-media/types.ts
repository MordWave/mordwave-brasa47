// Types shared by the legacy-media migration (Supabase Storage -> Railway
// Bucket). Nothing here carries secrets: ids, storage paths/keys, hashes,
// sizes and statuses only.

export type RowKind = 'product' | 'logo';

// One image-bearing row: a product (image_url / image_storage_key) or a
// business (logo_url / logo_storage_key).
export interface LegacyRow {
  kind: RowKind;
  id: string;
  businessId: string;
  legacyUrl: string | null;
  storageKey: string | null;
  deleted: boolean;
}

export type PlanStatus =
  | 'to_migrate'
  | 'skipped_already_migrated' // has a Railway storage key (legacy URL may remain as rollback)
  | 'skipped_no_image'
  | 'skipped_not_supabase' // legacy URL does not point at our Supabase Storage
  | 'skipped_deleted'
  | 'anomaly'; // looked migratable but something is inconsistent: never touched

export interface PlanItem {
  id: string; // `${kind}:${rowId}`
  kind: RowKind;
  rowId: string;
  businessId: string;
  status: PlanStatus;
  reason?: string;
  hasLegacyUrl: boolean;
  hasStorageKey: boolean;
  // Only for to_migrate:
  objectPath?: string; // path inside the Supabase bucket
  legacyUrlSha256?: string; // the exact URL that was inventoried
  sourceSha256?: string;
  sourceSize?: number;
  destinationKey?: string;
}

export interface Plan {
  version: 1;
  createdAt: string;
  supabaseBucket: string;
  database: string;
  items: PlanItem[];
  // sha256 over the actionable content; `--confirm` must quote its prefix, so
  // an apply can only run against the plan that was reviewed.
  planHash: string;
}

export type ItemState =
  | 'planned'
  | 'copied'
  | 'verified'
  | 'media_ok'
  | 'db_updated'
  | 'failed'
  | 'aborted_row_changed';

export interface ManifestEntry {
  state: ItemState;
  destinationKey: string;
  sha256: string;
  size: number;
  error?: string;
  updatedAt: string;
}

export interface Manifest {
  version: 1;
  planHash: string;
  entries: Record<string, ManifestEntry>;
}

// ---- ports (everything the migrator touches from the outside) -------------

export interface RowRepository {
  listRows(): Promise<LegacyRow[]>;
  fetchRow(kind: RowKind, id: string): Promise<LegacyRow | null>;
  // Sets ONLY the storage key, and only if the row still has no key and its
  // legacy URL is still exactly `expectedLegacyUrl`. Returns whether a row
  // was updated.
  setStorageKey(kind: RowKind, id: string, key: string, expectedLegacyUrl: string): Promise<boolean>;
}

export interface FetchedBytes {
  status: number;
  contentType: string | null;
  bytes: Buffer;
}

// Reads the legacy object from Supabase Storage (public URL, no secret).
export interface SourceStore {
  download(url: string): Promise<FetchedBytes>;
}

// The destination bucket. Deliberately has no delete.
export interface BucketPort {
  head(key: string): Promise<{ contentLength: number | undefined; contentType: string | undefined } | null>;
  put(key: string, body: Buffer, contentType: string, cacheControl: string, metadata?: Record<string, string>): Promise<void>;
  presignGet(key: string, expiresInSeconds: number): Promise<string>;
}

export interface ProbeResponse {
  status: number;
  location: string | null;
  contentType: string | null;
  bytes: Buffer;
}

// Plain HTTP client used to prove the public path (/media -> 302 -> bucket).
export interface HttpProbe {
  get(url: string, options: { followRedirects: boolean }): Promise<ProbeResponse>;
  head(url: string): Promise<ProbeResponse>;
}

export interface ManifestStore {
  load(): Promise<Manifest | null>;
  save(manifest: Manifest): Promise<void>;
}
