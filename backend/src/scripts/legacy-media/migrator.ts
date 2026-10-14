import { createHash, randomUUID } from 'node:crypto';
import { MEDIA_OBJECT_CACHE_CONTROL, MEDIA_OBJECT_CONTENT_TYPE, PRESIGNED_GET_TTL_SECONDS } from '../../media/media.const.js';
import { businessLogoKey, isBusinessLogoKey, isProductImageKey, productImageKey } from '../../media/media-key.util.js';
import { expectedLegacyObjectPath, looksLikeWebp, parseLegacyUrl, type SupabaseUrlContext } from './legacy-url.js';
import type {
  BucketPort,
  HttpProbe,
  ItemState,
  LegacyRow,
  Manifest,
  ManifestEntry,
  ManifestStore,
  Plan,
  PlanItem,
  RowRepository,
  SourceStore,
} from './types.js';

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const MAX_OBJECT_BYTES = 10 * 1024 * 1024;

export interface MigratorDeps {
  rows: RowRepository;
  source: SourceStore;
  bucket: BucketPort;
  probe: HttpProbe;
  manifests: ManifestStore;
  supabase: SupabaseUrlContext;
  // Public origin of the API, e.g. https://api.example.com (MEDIA_PUBLIC_BASE_URL).
  mediaBaseUrl: string;
  database: string;
  log: (line: string) => void;
  now?: () => Date;
  // Test seam; production uses crypto.randomUUID via media-key.util.
  objectId?: () => string;
}

export interface ApplyOptions {
  onlyIds?: string[];
  limit?: number;
}

export interface ItemResult {
  id: string;
  outcome: 'migrated' | 'skipped' | 'failed' | 'aborted_row_changed';
  detail?: string;
}

// Error messages can echo hosts/URLs from fetch failures: keep them out of
// logs and of the manifest.
const sanitize = (message: string): string => message.replace(/https?:\/\/\S+/g, '<url>').slice(0, 200);

class StepError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

// Copies legacy Supabase images to the Railway Bucket and records the new
// storage key. Hard rules, enforced here and covered by tests:
//  - dry-run (plan) never writes anywhere;
//  - bytes are copied untouched (no re-encoding) and verified by SHA-256 at
//    the destination and through the public /media path BEFORE the DB row is
//    touched;
//  - the only DB write is "set the storage key", guarded by
//    "key IS NULL and legacy URL unchanged";
//  - legacy URLs, Supabase objects and bucket objects are never deleted
//    (the ports offer no delete at all).
export class LegacyMediaMigrator {
  constructor(private readonly deps: MigratorDeps) {}

  private get now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  private newKey(row: LegacyRow): string {
    const objectId = this.deps.objectId?.() ?? randomUUID();
    return row.kind === 'product'
      ? productImageKey(row.businessId, row.id, objectId)
      : businessLogoKey(row.businessId, objectId);
  }

  private isRailwayKey(kind: LegacyRow['kind'], key: string): boolean {
    return kind === 'product' ? isProductImageKey(key) : isBusinessLogoKey(key);
  }

  // ---- 1. inventory / dry-run (read-only) ---------------------------------

  async plan(): Promise<Plan> {
    const { rows, source, manifests, supabase } = this.deps;
    const previous = await manifests.load();
    const items: PlanItem[] = [];

    for (const row of await rows.listRows()) {
      // Whatever the row's status, remember which Supabase object it
      // references so the report can tell referenced objects from orphans.
      const parsed = row.legacyUrl === null ? null : parseLegacyUrl(row.legacyUrl, supabase);
      const base = {
        id: `${row.kind}:${row.id}`,
        kind: row.kind,
        rowId: row.id,
        businessId: row.businessId,
        hasLegacyUrl: row.legacyUrl !== null,
        hasStorageKey: row.storageKey !== null,
        ...(parsed?.kind === 'supabase' ? { objectPath: parsed.objectPath } : {}),
      };
      if (row.deleted) {
        items.push({ ...base, status: 'skipped_deleted' });
        continue;
      }
      // A row that already has a Railway key is never touched, even when it
      // still carries a Supabase URL (e.g. an image replaced after PR 3).
      if (row.storageKey !== null) {
        items.push({ ...base, status: 'skipped_already_migrated' });
        continue;
      }
      if (row.legacyUrl === null || parsed === null) {
        items.push({ ...base, status: 'skipped_no_image' });
        continue;
      }
      if (parsed.kind !== 'supabase') {
        items.push({ ...base, status: 'skipped_not_supabase' });
        continue;
      }
      if (parsed.objectPath !== expectedLegacyObjectPath(row.kind, row.businessId, row.id)) {
        items.push({ ...base, status: 'anomaly', reason: 'path_does_not_match_row' });
        continue;
      }

      const legacyUrlSha256 = sha256(row.legacyUrl);
      const fetched = await source.download(row.legacyUrl).catch(() => null);
      if (!fetched || fetched.status !== 200) {
        items.push({ ...base, status: 'anomaly', reason: 'source_object_missing', legacyUrlSha256 });
        continue;
      }
      if (fetched.bytes.length === 0 || fetched.bytes.length > MAX_OBJECT_BYTES || !looksLikeWebp(fetched.bytes)) {
        items.push({ ...base, status: 'anomaly', reason: 'source_not_a_valid_webp', legacyUrlSha256 });
        continue;
      }

      // Reuse the destination key chosen by an earlier plan for the same row
      // and the same inventoried URL, so a re-plan after a partial run points
      // at the object that may already have been copied.
      const prior = previous?.entries[base.id];
      const destinationKey =
        prior && this.isRailwayKey(row.kind, prior.destinationKey) ? prior.destinationKey : this.newKey(row);

      items.push({
        ...base,
        status: 'to_migrate',
        legacyUrlSha256,
        sourceSha256: sha256(fetched.bytes),
        sourceSize: fetched.bytes.length,
        destinationKey,
      });
    }

    items.sort((a, b) => a.id.localeCompare(b.id));
    return {
      version: 1,
      createdAt: this.now,
      supabaseBucket: this.deps.supabase.bucket,
      database: this.deps.database,
      items,
      planHash: LegacyMediaMigrator.hashPlan(items),
    };
  }

  static hashPlan(items: PlanItem[]): string {
    const actionable = items
      .filter((i) => i.status === 'to_migrate')
      .map((i) => [i.id, i.objectPath, i.legacyUrlSha256, i.sourceSha256, i.sourceSize, i.destinationKey]);
    return sha256(JSON.stringify(actionable)).slice(0, 16);
  }

  // ---- 2. apply (writes) ---------------------------------------------------

  async apply(plan: Plan, options: ApplyOptions = {}): Promise<ItemResult[]> {
    if (LegacyMediaMigrator.hashPlan(plan.items) !== plan.planHash) {
      throw new Error('Plan was modified: its hash does not match its content');
    }
    const manifest: Manifest = (await this.deps.manifests.load()) ?? {
      version: 1,
      planHash: plan.planHash,
      entries: {},
    };
    manifest.planHash = plan.planHash;

    let targets = plan.items.filter((i) => i.status === 'to_migrate');
    if (options.onlyIds?.length) targets = targets.filter((i) => options.onlyIds!.includes(i.id));
    if (options.limit !== undefined) targets = targets.slice(0, options.limit);

    const results: ItemResult[] = [];
    for (const item of targets) {
      const result = await this.applyItem(item, manifest);
      this.deps.log(`${item.id} -> ${result.outcome}${result.detail ? ` (${result.detail})` : ''}`);
      results.push(result);
    }
    return results;
  }

  private async record(manifest: Manifest, item: PlanItem, state: ItemState, error?: string): Promise<void> {
    const entry: ManifestEntry = {
      state,
      destinationKey: item.destinationKey!,
      sha256: item.sourceSha256!,
      size: item.sourceSize!,
      updatedAt: this.now,
      ...(error ? { error } : {}),
    };
    manifest.entries[item.id] = entry;
    await this.deps.manifests.save(manifest);
  }

  private async applyItem(item: PlanItem, manifest: Manifest): Promise<ItemResult> {
    const { rows, source, bucket, probe, mediaBaseUrl } = this.deps;
    const key = item.destinationKey!;
    try {
      const row = await rows.fetchRow(item.kind, item.rowId);

      // Resume: already finished (also covers a crash between the UPDATE and
      // the manifest write).
      if (row?.storageKey === key) {
        await this.record(manifest, item, 'db_updated');
        return { id: item.id, outcome: 'skipped', detail: 'already_updated' };
      }
      // Re-check every precondition against the live row: the plan may be old.
      if (!row || row.deleted || row.storageKey !== null || row.legacyUrl === null) {
        await this.record(manifest, item, 'aborted_row_changed', 'row_no_longer_eligible');
        return { id: item.id, outcome: 'aborted_row_changed', detail: 'row_no_longer_eligible' };
      }
      if (sha256(row.legacyUrl) !== item.legacyUrlSha256) {
        await this.record(manifest, item, 'aborted_row_changed', 'legacy_url_changed');
        return { id: item.id, outcome: 'aborted_row_changed', detail: 'legacy_url_changed' };
      }
      const legacyUrl = row.legacyUrl;

      // Step 1-2: download and fingerprint the source; it must still be what
      // the dry-run inventoried.
      const fetched = await source.download(legacyUrl);
      if (fetched.status !== 200) throw new StepError('source_download_failed');
      const sourceSha = sha256(fetched.bytes);
      if (sourceSha !== item.sourceSha256 || fetched.bytes.length !== item.sourceSize) {
        throw new StepError('source_changed_since_plan');
      }

      // Step 3-4: copy the SAME bytes (no re-encoding), unless an identical
      // object is already there from an earlier run.
      const existing = await bucket.head(key);
      if (existing) {
        const there = await this.readBack(key);
        if (there.sha !== sourceSha) throw new StepError('destination_exists_with_different_bytes');
      } else {
        await bucket.put(key, fetched.bytes, MEDIA_OBJECT_CONTENT_TYPE, MEDIA_OBJECT_CACHE_CONTROL, {
          'migrated-from': 'supabase-storage',
          'source-sha256': sourceSha,
        });
      }
      await this.record(manifest, item, 'copied');

      // Step 5-6: verify at the destination.
      const head = await bucket.head(key);
      if (!head) throw new StepError('destination_missing_after_put');
      if (head.contentLength !== item.sourceSize) throw new StepError('destination_size_mismatch');
      if (head.contentType !== MEDIA_OBJECT_CONTENT_TYPE) throw new StepError('destination_content_type_mismatch');
      const back = await this.readBack(key);
      if (back.sha !== sourceSha || back.size !== item.sourceSize) throw new StepError('destination_bytes_mismatch');
      await this.record(manifest, item, 'verified');

      // Step 7: the real public path.
      await this.verifyPublicPath(mediaBaseUrl, key, sourceSha, probe);
      await this.record(manifest, item, 'media_ok');

      // Step 8: the only DB write.
      const updated = await rows.setStorageKey(item.kind, item.rowId, key, legacyUrl);
      if (!updated) {
        await this.record(manifest, item, 'aborted_row_changed', 'row_changed_before_update');
        return { id: item.id, outcome: 'aborted_row_changed', detail: 'row_changed_before_update' };
      }
      const after = await rows.fetchRow(item.kind, item.rowId);
      if (!after || after.storageKey !== key || after.legacyUrl !== legacyUrl) {
        throw new StepError('post_update_check_failed');
      }
      await this.record(manifest, item, 'db_updated');
      return { id: item.id, outcome: 'migrated' };
    } catch (error) {
      const code = error instanceof StepError ? error.code : `unexpected: ${sanitize(String((error as Error)?.message ?? error))}`;
      await this.record(manifest, item, 'failed', code).catch(() => undefined);
      return { id: item.id, outcome: 'failed', detail: code };
    }
  }

  // Reads the object back through a presigned GET (the same mechanism /media
  // redirects to).
  private async readBack(key: string): Promise<{ sha: string; size: number }> {
    const url = await this.deps.bucket.presignGet(key, PRESIGNED_GET_TTL_SECONDS);
    const res = await this.deps.probe.get(url, { followRedirects: false });
    if (res.status !== 200) throw new StepError('destination_read_failed');
    return { sha: sha256(res.bytes), size: res.bytes.length };
  }

  // GET /media/<key> must 302 to the bucket and the followed URL must serve
  // the very same bytes as image/webp; HEAD must be a direct 200.
  private async verifyPublicPath(mediaBaseUrl: string, key: string, expectedSha: string, probe: HttpProbe): Promise<void> {
    const url = `${mediaBaseUrl}/media/${key}`;
    const redirect = await probe.get(url, { followRedirects: false });
    if (redirect.status !== 302 || !redirect.location) throw new StepError('media_not_a_302');
    if (!redirect.location.startsWith('https://')) throw new StepError('media_redirect_not_https');
    const bytes = await probe.get(redirect.location, { followRedirects: false });
    if (bytes.status !== 200) throw new StepError('media_target_not_200');
    if (!bytes.contentType?.startsWith(MEDIA_OBJECT_CONTENT_TYPE)) throw new StepError('media_target_not_webp');
    if (sha256(bytes.bytes) !== expectedSha) throw new StepError('media_target_bytes_mismatch');
    const head = await probe.head(url);
    if (head.status !== 200) throw new StepError('media_head_not_200');
  }
}
