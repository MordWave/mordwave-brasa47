import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { Business } from '../src/business/business.entity.js';
import { Category } from '../src/category/category.entity.js';
import { isBusinessLogoKey, isProductImageKey } from '../src/media/media-key.util.js';
import { Product } from '../src/product/product.entity.js';
import { LegacyMediaMigrator } from '../src/scripts/legacy-media/migrator.js';
import { SqlRowRepository } from '../src/scripts/legacy-media/sql-row-repository.js';
import {
  FakeBucket,
  FakeProbe,
  FakeSource,
  MEDIA_BASE,
  MemoryManifest,
  SUPABASE_BUCKET,
  SUPABASE_HOST,
  logoUrl,
  productUrl,
  webp,
} from './support/legacy-media-doubles.js';
import { runAllMigrations } from './support/run-all-migrations.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

const NEW_KEY = 'businesses/aaaaaaaa-1111-4abc-8def-111111111abc/products/bbbbbbbb-2222-4abc-8def-222222222abc/eeeeeeee-5555-4abc-8def-555555555abc.webp';

// The migration's real SQL (SqlRowRepository) against a real migrated
// Postgres (ephemeral PGlite — never Supabase, never Railway), with the
// Supabase source, the bucket and the public HTTP path faked.
describe('Legacy media migration (e2e, real local Postgres)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  let dataSource: DataSource;
  let bizA: Business;
  let category: Category;

  let source: FakeSource;
  let bucket: FakeBucket;
  let probe: FakeProbe;
  let manifests: MemoryManifest;
  let execLog: string[];
  let beforeUpdate: (() => Promise<void>) | undefined;

  const snapshot = async (table: 'products' | 'businesses') =>
    (await dataSource.query(`SELECT * FROM ${table} ORDER BY id`)) as Array<Record<string, unknown>>;
  const withoutKey = (r: Record<string, unknown>) => {
    const { image_storage_key: _a, logo_storage_key: _b, ...rest } = r;
    return rest;
  };

  const migrator = () =>
    new LegacyMediaMigrator({
      rows: new SqlRowRepository(async (sql, params) => {
        execLog.push(sql.trim().split(/\s+/)[0]);
        if (/^\s*UPDATE/i.test(sql) && beforeUpdate) await beforeUpdate();
        return dataSource.query(sql, params as unknown[]);
      }),
      source,
      bucket,
      probe,
      manifests,
      supabase: { supabaseHost: SUPABASE_HOST, bucket: SUPABASE_BUCKET },
      mediaBaseUrl: MEDIA_BASE,
      database: 'railway',
      log: () => undefined,
    });

  async function makeProduct(name: string) {
    const repo = dataSource.getRepository(Product);
    return repo.save(repo.create({ businessId: bizA.id, categoryId: category.id, name, price: 5000 }));
  }
  async function legacyProduct(name: string) {
    const repo = dataSource.getRepository(Product);
    const saved = await repo.save(repo.create({ businessId: bizA.id, categoryId: category.id, name, price: 5000 }));
    const url = productUrl(bizA.id, saved.id);
    await repo.update(saved.id, { imageUrl: url });
    source.objects.set(url, webp(`bytes-of-${name}`));
    return { id: saved.id, url };
  }

  beforeAll(async () => {
    testDb = await startTestDatabase();
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = '';
    process.env.DB_HOST = testDb.host;
    process.env.DB_PORT = String(testDb.port);
    process.env.DB_USERNAME = 'postgres';
    process.env.DB_PASSWORD = 'postgres';
    process.env.DB_NAME = 'postgres';
    process.env.DB_POOL_MAX = '1';

    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    dataSource = moduleFixture.get(DataSource);
    await runAllMigrations(dataSource);

    const businessRepo = dataSource.getRepository(Business);
    bizA = await businessRepo.save(businessRepo.create({ name: 'A', slug: 'legacy-a' }));
    const categoryRepo = dataSource.getRepository(Category);
    category = await categoryRepo.save(categoryRepo.create({ name: 'C', slug: 'c', businessId: bizA.id, sortOrder: 1 }));
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await testDb?.stop();
  });

  beforeEach(async () => {
    source = new FakeSource();
    bucket = new FakeBucket();
    probe = new FakeProbe(bucket);
    manifests = new MemoryManifest();
    execLog = [];
    beforeUpdate = undefined;
    await dataSource.query(`DELETE FROM products`);
    await dataSource.query(`UPDATE businesses SET logo_url = NULL, logo_storage_key = NULL`);
  });

  it('migrates legacy products and logos; the only DB change is the storage key columns', async () => {
    const a = await legacyProduct('a');
    const b = await legacyProduct('b');
    const logo = logoUrl(bizA.id);
    await dataSource.query(`UPDATE businesses SET logo_url = $1 WHERE id = $2`, [logo, bizA.id]);
    source.objects.set(logo, webp('the-logo'));
    const beforeProducts = await snapshot('products');
    const beforeBusinesses = await snapshot('businesses');

    const plan = await migrator().plan();
    expect(plan.items.filter((i) => i.status === 'to_migrate')).toHaveLength(3);
    const results = await migrator().apply(plan);
    expect(results.map((r) => r.outcome)).toEqual(['migrated', 'migrated', 'migrated']);

    const afterProducts = await snapshot('products');
    const afterBusinesses = await snapshot('businesses');
    // Every column except the key is byte-identical (incl. image_url and updated_at).
    expect(afterProducts.map(withoutKey)).toEqual(beforeProducts.map(withoutKey));
    expect(afterBusinesses.map(withoutKey)).toEqual(beforeBusinesses.map(withoutKey));
    for (const p of afterProducts) {
      expect(isProductImageKey(p.image_storage_key)).toBe(true);
      expect(p.image_url).toBe(p.id === a.id ? a.url : b.url);
    }
    const bizRow = afterBusinesses.find((r) => r.id === bizA.id)!;
    expect(isBusinessLogoKey(bizRow.logo_storage_key)).toBe(true);
    expect(bizRow.logo_url).toBe(logo);
    expect(bucket.puts).toHaveLength(3);
  });

  it('skips rows that already have a Railway key even if they still carry a Supabase URL — and does not write them', async () => {
    const done = await legacyProduct('done');
    await dataSource.query(`UPDATE products SET image_storage_key = $1 WHERE id = $2`, [NEW_KEY.replace('bbbbbbbb-2222-4abc-8def-222222222abc', done.id).replace('aaaaaaaa-1111-4abc-8def-111111111abc', bizA.id), done.id]);
    const todo = await legacyProduct('todo');
    const before = (await snapshot('products')).find((r) => r.id === done.id);

    const plan = await migrator().plan();
    expect(plan.items.find((i) => i.rowId === done.id)?.status).toBe('skipped_already_migrated');
    await migrator().apply(plan);

    expect((await snapshot('products')).find((r) => r.id === done.id)).toEqual(before);
    expect(bucket.puts).toHaveLength(1);
    const migrated = (await snapshot('products')).find((r) => r.id === todo.id)!;
    expect(isProductImageKey(migrated.image_storage_key)).toBe(true);
  });

  it('ignores soft-deleted rows and rows whose URL is not Supabase', async () => {
    const gone = await legacyProduct('gone');
    await dataSource.getRepository(Product).softDelete(gone.id);
    const external = await makeProduct('external');
    await dataSource.query(`UPDATE products SET image_url = 'https://cdn.example/x.png' WHERE id = $1`, [external.id]);

    const plan = await migrator().plan();
    expect(plan.items.find((i) => i.rowId === gone.id)?.status).toBe('skipped_deleted');
    expect(plan.items.find((i) => i.rowId === external.id)?.status).toBe('skipped_not_supabase');
    await migrator().apply(plan);
    expect(bucket.puts).toEqual([]);
    expect(execLog.filter((c) => c.toUpperCase() === 'UPDATE')).toEqual([]);
  });

  it('the guarded UPDATE refuses when the legacy URL changes between verification and the write', async () => {
    const a = await legacyProduct('a');
    const plan = await migrator().plan();
    beforeUpdate = async () => {
      await dataSource.query(`UPDATE products SET image_url = $1 WHERE id = $2`, [productUrl(bizA.id, a.id, 99), a.id]);
    };

    const [r] = await migrator().apply(plan);

    expect(r).toMatchObject({ outcome: 'aborted_row_changed', detail: 'row_changed_before_update' });
    const row = (await snapshot('products'))[0];
    expect(row.image_storage_key).toBeNull();
    expect(row.image_url).toBe(productUrl(bizA.id, a.id, 99));
  });

  it('the guarded UPDATE never overwrites a key set meanwhile (e.g. an Admin upload)', async () => {
    const a = await legacyProduct('a');
    const plan = await migrator().plan();
    const adminKey = `businesses/${bizA.id}/products/${a.id}/ffffffff-6666-4abc-8def-666666666abc.webp`;
    beforeUpdate = async () => {
      await dataSource.query(`UPDATE products SET image_storage_key = $1 WHERE id = $2`, [adminKey, a.id]);
    };

    const [r] = await migrator().apply(plan);

    expect(r.outcome).toBe('aborted_row_changed');
    expect((await snapshot('products'))[0].image_storage_key).toBe(adminKey);
  });

  it('is resumable and idempotent end to end', async () => {
    await legacyProduct('a');
    const plan = await migrator().plan();
    await migrator().apply(plan);
    const afterFirst = await snapshot('products');
    const putsFirst = bucket.puts.length;

    const again = await migrator().apply(plan);

    expect(again[0]).toMatchObject({ outcome: 'skipped' });
    expect(bucket.puts.length).toBe(putsFirst);
    expect(await snapshot('products')).toEqual(afterFirst);
  });

  it('the dry-run only reads: no UPDATE statement is ever issued', async () => {
    await legacyProduct('a');
    await migrator().plan();
    expect(execLog.every((c) => c.toUpperCase() === 'SELECT')).toBe(true);
    expect(bucket.puts).toEqual([]);
  });
});
