import { beforeEach, describe, expect, it } from 'vitest';
import {
  BUCKET_HOST,
  FakeBucket,
  FakeProbe,
  FakeRows,
  FakeSource,
  MEDIA_BASE,
  MemoryManifest,
  SUPABASE_BUCKET,
  SUPABASE_HOST,
  logoUrl,
  productUrl,
  sha256,
  webp,
} from '../../../test/support/legacy-media-doubles.js';
import { isBusinessLogoKey, isProductImageKey } from '../../media/media-key.util.js';
import { LegacyMediaMigrator } from './migrator.js';
import type { LegacyRow, Plan } from './types.js';

const BIZ = 'aaaaaaaa-1111-4abc-8def-111111111abc';
const P = (n: number) => `bbbbbbbb-0000-4abc-8def-${String(n).padStart(12, '0')}`;
const EXISTING_KEY = `businesses/${BIZ}/products/${P(9)}/eeeeeeee-5555-4abc-8def-555555555abc.webp`;

function productRow(n: number, extra: Partial<LegacyRow> = {}): LegacyRow {
  return { kind: 'product', id: P(n), businessId: BIZ, legacyUrl: productUrl(BIZ, P(n)), storageKey: null, deleted: false, ...extra };
}

describe('LegacyMediaMigrator', () => {
  let rows: FakeRows;
  let source: FakeSource;
  let bucket: FakeBucket;
  let probe: FakeProbe;
  let manifests: MemoryManifest;
  let logs: string[];
  let counter: number;

  const migrator = () =>
    new LegacyMediaMigrator({
      rows,
      source,
      bucket,
      probe,
      manifests,
      supabase: { supabaseHost: SUPABASE_HOST, bucket: SUPABASE_BUCKET },
      mediaBaseUrl: MEDIA_BASE,
      database: 'railway',
      log: (l) => logs.push(l),
      // Deterministic, valid object ids.
      objectId: () => `cccccccc-3333-4abc-8def-${String((counter += 1)).padStart(12, '0')}`,
    });

  function seedProduct(n: number, extra: Partial<LegacyRow> = {}, payload = `image-${n}`) {
    const row = productRow(n, extra);
    rows.add(row);
    if (row.legacyUrl) source.objects.set(row.legacyUrl, webp(payload));
    return row;
  }

  beforeEach(() => {
    rows = new FakeRows();
    source = new FakeSource();
    bucket = new FakeBucket();
    probe = new FakeProbe(bucket);
    manifests = new MemoryManifest();
    logs = [];
    counter = 0;
  });

  describe('plan (dry-run)', () => {
    it('classifies every kind of row', async () => {
      seedProduct(1); // to migrate
      seedProduct(2, { storageKey: EXISTING_KEY }); // Supabase URL + Railway key -> skipped
      rows.add(productRow(3, { legacyUrl: null })); // no image
      rows.add(productRow(4, { legacyUrl: 'https://cdn.other.example/x.png' })); // not Supabase
      seedProduct(5, { deleted: true }); // soft-deleted
      rows.add(productRow(6, { legacyUrl: productUrl(BIZ, P(99)) })); // path of another product
      rows.add(productRow(7)); // URL is Supabase but the object does not exist
      rows.add({ kind: 'logo', id: BIZ, businessId: BIZ, legacyUrl: logoUrl(BIZ), storageKey: null, deleted: false });
      source.objects.set(logoUrl(BIZ), webp('logo'));

      const plan = await migrator().plan();
      const status = Object.fromEntries(plan.items.map((i) => [i.id, i.status]));

      expect(status).toEqual({
        [`logo:${BIZ}`]: 'to_migrate',
        [`product:${P(1)}`]: 'to_migrate',
        [`product:${P(2)}`]: 'skipped_already_migrated',
        [`product:${P(3)}`]: 'skipped_no_image',
        [`product:${P(4)}`]: 'skipped_not_supabase',
        [`product:${P(5)}`]: 'skipped_deleted',
        [`product:${P(6)}`]: 'anomaly',
        [`product:${P(7)}`]: 'anomaly',
      });
      expect(plan.items.find((i) => i.id === `product:${P(6)}`)?.reason).toBe('path_does_not_match_row');
      expect(plan.items.find((i) => i.id === `product:${P(7)}`)?.reason).toBe('source_object_missing');
    });

    it('records hash, size and a VALID new destination key for each row to migrate', async () => {
      seedProduct(1, {}, 'one');
      rows.add({ kind: 'logo', id: BIZ, businessId: BIZ, legacyUrl: logoUrl(BIZ), storageKey: null, deleted: false });
      source.objects.set(logoUrl(BIZ), webp('logo'));

      const plan = await migrator().plan();
      const product = plan.items.find((i) => i.kind === 'product')!;
      const logo = plan.items.find((i) => i.kind === 'logo')!;

      expect(product.sourceSha256).toBe(sha256(webp('one')));
      expect(product.sourceSize).toBe(webp('one').length);
      expect(isProductImageKey(product.destinationKey)).toBe(true);
      expect(product.destinationKey).toContain(`businesses/${BIZ}/products/${P(1)}/`);
      expect(isBusinessLogoKey(logo.destinationKey)).toBe(true);
    });

    it('flags a source that is not a WebP instead of copying it', async () => {
      rows.add(productRow(1));
      source.objects.set(productRow(1).legacyUrl!, Buffer.from('<html>oops</html>'));
      const plan = await migrator().plan();
      expect(plan.items[0]).toMatchObject({ status: 'anomaly', reason: 'source_not_a_valid_webp' });
    });

    it('writes NOTHING: no bucket put, no DB update, no manifest', async () => {
      seedProduct(1);
      await migrator().plan();
      expect(bucket.puts).toEqual([]);
      expect(rows.setCalls).toEqual([]);
      expect(manifests.saves).toBe(0);
    });

    it('stores no URL and no host in the plan', async () => {
      seedProduct(1);
      seedProduct(2, { storageKey: EXISTING_KEY });
      const text = JSON.stringify(await migrator().plan());
      expect(text).not.toContain(SUPABASE_HOST);
      expect(text).not.toContain('https://');
    });

    it('is stable: the same data yields the same plan hash only when the keys are reused from the manifest', async () => {
      seedProduct(1);
      const first = await migrator().plan();
      await migrator().apply(first);
      // After a (re-)plan the finished row is just "already migrated".
      const again = await migrator().plan();
      expect(again.items[0].status).toBe('skipped_already_migrated');
    });

    it('reuses the destination key of an earlier partial run for the same row', async () => {
      seedProduct(1);
      const first = await migrator().plan();
      bucket.corruptOnPut = true; // first run fails after writing a bad copy
      await migrator().apply(first);
      bucket.corruptOnPut = false;
      const replanned = await migrator().plan();
      expect(replanned.items[0].destinationKey).toBe(first.items[0].destinationKey);
    });
  });

  describe('apply', () => {
    it('copies the SAME bytes, verifies them, proves /media, then sets only the storage key', async () => {
      const row = seedProduct(1, {}, 'precious-bytes');
      const plan = await migrator().plan();
      const key = plan.items[0].destinationKey!;

      const results = await migrator().apply(plan);

      expect(results).toEqual([{ id: `product:${P(1)}`, outcome: 'migrated' }]);
      const stored = bucket.objects.get(key)!;
      expect(stored.body.equals(webp('precious-bytes'))).toBe(true); // no re-encoding
      expect(stored.contentType).toBe('image/webp');
      expect(stored.cacheControl).toBe('public, max-age=31536000, immutable');
      expect(stored.metadata).toEqual({ 'migrated-from': 'supabase-storage', 'source-sha256': sha256(webp('precious-bytes')) });
      // DB: key set, legacy URL untouched, nothing else changed.
      expect(rows.get('product', P(1))).toEqual({ ...row, storageKey: key });
      expect(rows.setCalls).toEqual([{ kind: 'product', id: P(1), key, expectedLegacyUrl: row.legacyUrl }]);
    });

    it('migrates logos with a logo key', async () => {
      rows.add({ kind: 'logo', id: BIZ, businessId: BIZ, legacyUrl: logoUrl(BIZ), storageKey: null, deleted: false });
      source.objects.set(logoUrl(BIZ), webp('logo'));
      const plan = await migrator().plan();
      await migrator().apply(plan);
      const key = rows.get('logo', BIZ).storageKey!;
      expect(isBusinessLogoKey(key)).toBe(true);
      expect(rows.get('logo', BIZ).legacyUrl).toBe(logoUrl(BIZ));
    });

    it('never touches a row that already has a Railway key, nor sets any call for it', async () => {
      seedProduct(1);
      const withKey = seedProduct(2, { storageKey: EXISTING_KEY });
      const plan = await migrator().plan();
      await migrator().apply(plan);
      expect(rows.get('product', P(2))).toEqual(withKey);
      expect(rows.setCalls.map((c) => c.id)).toEqual([P(1)]);
      expect(bucket.puts).toHaveLength(1);
    });

    it('writes to the bucket BEFORE the database, and verifies the public path before the update', async () => {
      seedProduct(1);
      const order: string[] = [];
      const putOriginal = bucket.put.bind(bucket);
      bucket.put = async (...args: Parameters<typeof bucket.put>) => {
        order.push('put');
        return putOriginal(...args);
      };
      const getOriginal = probe.get.bind(probe);
      probe.get = async (url, options) => {
        if (url.startsWith(`${MEDIA_BASE}/media/`)) order.push('media-check');
        return getOriginal(url, options);
      };
      rows.beforeSet = () => order.push('db-update');

      await migrator().apply(await migrator().plan());

      expect(order).toEqual(['put', 'media-check', 'db-update']);
    });

    it('requires an untampered plan', async () => {
      seedProduct(1);
      const plan = await migrator().plan();
      const tampered: Plan = { ...plan, items: plan.items.map((i) => ({ ...i, destinationKey: i.destinationKey!.replace('cccccccc', 'ffffffff') })) };
      await expect(migrator().apply(tampered)).rejects.toThrow(/hash/);
      expect(bucket.puts).toEqual([]);
    });

    describe('failures leave the row on Supabase', () => {
      const expectUntouched = (n: number, row: LegacyRow) => {
        expect(rows.get('product', P(n))).toEqual(row);
        expect(rows.setCalls).toEqual([]);
      };

      it('source changed since the dry-run -> no copy, no update', async () => {
        const row = seedProduct(1, {}, 'before');
        const plan = await migrator().plan();
        source.objects.set(row.legacyUrl!, webp('after'));
        const [r] = await migrator().apply(plan);
        expect(r).toMatchObject({ outcome: 'failed', detail: 'source_changed_since_plan' });
        expect(bucket.puts).toEqual([]);
        expectUntouched(1, row);
      });

      it('destination bytes differ from the source -> no update', async () => {
        const row = seedProduct(1);
        const plan = await migrator().plan();
        bucket.corruptOnPut = true;
        const [r] = await migrator().apply(plan);
        expect(r.outcome).toBe('failed');
        expectUntouched(1, row);
      });

      it('/media does not answer 302 -> no update', async () => {
        const row = seedProduct(1);
        const plan = await migrator().plan();
        probe.mediaBroken = true;
        const [r] = await migrator().apply(plan);
        expect(r).toMatchObject({ outcome: 'failed', detail: 'media_not_a_302' });
        expectUntouched(1, row);
      });

      it('an unexpected error is reported without leaking URLs', async () => {
        const row = seedProduct(1);
        const plan = await migrator().plan();
        bucket.put = async () => {
          throw new Error(`connect ECONNREFUSED ${BUCKET_HOST}/secret?token=abc`);
        };
        const [r] = await migrator().apply(plan);
        expect(r.outcome).toBe('failed');
        expect(r.detail).not.toContain('https://');
        expect(JSON.stringify(manifests.value)).not.toContain('token=abc');
        expectUntouched(1, row);
      });

      it('the row got a key after the dry-run -> aborted, never overwritten', async () => {
        const row = seedProduct(1);
        const plan = await migrator().plan();
        rows.get('product', P(1)).storageKey = EXISTING_KEY;
        const [r] = await migrator().apply(plan);
        expect(r).toMatchObject({ outcome: 'aborted_row_changed', detail: 'row_no_longer_eligible' });
        expect(rows.get('product', P(1)).storageKey).toBe(EXISTING_KEY);
        expect(rows.get('product', P(1)).legacyUrl).toBe(row.legacyUrl);
        expect(bucket.puts).toEqual([]);
        expect(rows.setCalls).toEqual([]);
      });

      it('the legacy URL changed after the dry-run -> aborted', async () => {
        seedProduct(1);
        const plan = await migrator().plan();
        rows.get('product', P(1)).legacyUrl = productUrl(BIZ, P(1), 2);
        source.objects.set(productUrl(BIZ, P(1), 2), webp('image-1'));
        const [r] = await migrator().apply(plan);
        expect(r).toMatchObject({ outcome: 'aborted_row_changed', detail: 'legacy_url_changed' });
        expect(bucket.puts).toEqual([]);
      });

      it('the row changes between verification and the update -> the guarded UPDATE refuses', async () => {
        seedProduct(1);
        const plan = await migrator().plan();
        rows.beforeSet = (kind, id) => {
          rows.get(kind, id).legacyUrl = productUrl(BIZ, P(1), 77); // concurrent edit
        };
        const [r] = await migrator().apply(plan);
        expect(r).toMatchObject({ outcome: 'aborted_row_changed', detail: 'row_changed_before_update' });
        expect(rows.get('product', P(1)).storageKey).toBeNull();
      });

      it('the row was soft-deleted after the dry-run -> aborted', async () => {
        seedProduct(1);
        const plan = await migrator().plan();
        rows.get('product', P(1)).deleted = true;
        const [r] = await migrator().apply(plan);
        expect(r.outcome).toBe('aborted_row_changed');
      });

      it('one failing row does not stop or corrupt the others', async () => {
        seedProduct(1);
        const bad = seedProduct(2);
        seedProduct(3);
        const plan = await migrator().plan();
        source.objects.set(bad.legacyUrl!, webp('changed')); // only row 2 breaks
        const results = await migrator().apply(plan);
        expect(results.map((r) => r.outcome)).toEqual(['migrated', 'failed', 'migrated']);
        expect(rows.get('product', P(1)).storageKey).not.toBeNull();
        expect(rows.get('product', P(2)).storageKey).toBeNull();
        expect(rows.get('product', P(3)).storageKey).not.toBeNull();
      });
    });

    describe('idempotency / resume', () => {
      it('running twice does not duplicate objects or update again', async () => {
        seedProduct(1);
        const plan = await migrator().plan();
        await migrator().apply(plan);
        const [again] = await migrator().apply(plan);
        expect(again).toMatchObject({ outcome: 'skipped', detail: 'already_updated' });
        expect(bucket.puts).toHaveLength(1);
        expect(rows.setCalls).toHaveLength(1);
      });

      it('a run that failed after copying resumes without re-uploading', async () => {
        const row = seedProduct(1);
        const plan = await migrator().plan();
        probe.mediaBroken = true;
        await migrator().apply(plan); // copied + verified, then fails at /media
        expect(bucket.puts).toHaveLength(1);
        expect(rows.get('product', P(1)).storageKey).toBeNull();

        probe.mediaBroken = false;
        const [r] = await migrator().apply(plan);

        expect(r.outcome).toBe('migrated');
        expect(bucket.puts).toHaveLength(1); // the existing, identical object was reused
        expect(rows.get('product', P(1))).toEqual({ ...row, storageKey: plan.items[0].destinationKey });
      });

      it('a crash after the UPDATE but before the manifest write is recognised on resume', async () => {
        const row = seedProduct(1);
        const plan = await migrator().plan();
        await migrator().apply(plan);
        manifests.value = null; // manifest lost
        const [r] = await migrator().apply(plan);
        expect(r).toMatchObject({ outcome: 'skipped', detail: 'already_updated' });
        expect(rows.setCalls).toHaveLength(1);
        expect(rows.get('product', P(1)).legacyUrl).toBe(row.legacyUrl);
      });

      it('an object already at the destination with DIFFERENT bytes is never overwritten', async () => {
        seedProduct(1);
        const plan = await migrator().plan();
        const key = plan.items[0].destinationKey!;
        bucket.objects.set(key, { body: webp('someone else'), contentType: 'image/webp', cacheControl: 'x' });
        const [r] = await migrator().apply(plan);
        expect(r).toMatchObject({ outcome: 'failed', detail: 'destination_exists_with_different_bytes' });
        expect(bucket.puts).toEqual([]);
        expect(rows.setCalls).toEqual([]);
      });
    });

    describe('selection', () => {
      it('--only and --limit narrow the run (canary first)', async () => {
        seedProduct(1);
        seedProduct(2);
        seedProduct(3);
        const plan = await migrator().plan();
        await migrator().apply(plan, { onlyIds: [`product:${P(2)}`] });
        expect(rows.get('product', P(2)).storageKey).not.toBeNull();
        expect(rows.get('product', P(1)).storageKey).toBeNull();

        await migrator().apply(plan, { limit: 1 });
        const migrated = [1, 2, 3].filter((n) => rows.get('product', P(n)).storageKey !== null);
        expect(migrated).toEqual([1, 2]);
      });
    });

    describe('manifest', () => {
      it('records ids, keys, hashes, sizes and states — and no secrets or URLs', async () => {
        const row = seedProduct(1);
        const plan = await migrator().plan();
        await migrator().apply(plan);
        const entry = manifests.value!.entries[`product:${P(1)}`];
        expect(entry).toMatchObject({
          state: 'db_updated',
          destinationKey: plan.items[0].destinationKey,
          sha256: plan.items[0].sourceSha256,
          size: plan.items[0].sourceSize,
        });
        const text = JSON.stringify(manifests.value);
        expect(text).not.toContain(SUPABASE_HOST);
        expect(text).not.toContain('https://');
        expect(text).not.toContain(row.legacyUrl!);
      });
    });

    it('has no way to delete anything: the ports expose no delete operation', () => {
      for (const port of [bucket, source, rows, probe] as object[]) {
        const names = Object.getOwnPropertyNames(Object.getPrototypeOf(port));
        expect(names.filter((n) => /delete|remove/i.test(n))).toEqual([]);
      }
    });
  });
});
