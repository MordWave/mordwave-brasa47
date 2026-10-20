import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { Business } from '../src/business/business.entity.js';
import { Category } from '../src/category/category.entity.js';
import { businessLogoKey, productImageKey } from '../src/media/media-key.util.js';
import { DropLegacyMediaUrls1790300000000 } from '../src/migrations/1790300000000-DropLegacyMediaUrls.js';
import { Product } from '../src/product/product.entity.js';
import { runMigrationsBefore } from './support/run-all-migrations.js';
import { seedBusinessAtSchemaState } from './support/seed-business-at-schema-state.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

const OBJ = 'cccccccc-3333-4abc-8def-333333333abc';
const URL_A = 'https://old-provider.example/product-images/a/imagen.webp?v=1';
const URL_B = 'https://old-provider.example/product-images/b/imagen.webp?v=1';
const URL_DELETED = 'https://old-provider.example/product-images/deleted/imagen.webp?v=1';
const URL_LOGO = 'https://old-provider.example/product-images/business-logos/x/logo.webp?v=1';

// The manual migration that drops products.image_url / businesses.logo_url,
// exercised against a real Postgres (ephemeral PGlite) at the exact schema state
// right before it, with seeded data. The guard failures are thrown by the
// migration itself (not by the database), so the shared single connection stays
// healthy between scenarios.
describe('DropLegacyMediaUrls migration (e2e, real local Postgres)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  let dataSource: DataSource;
  let business: Business;
  let category: Category;
  let startupProbe: { migrations: string | null; products: string | null };

  const migration = new DropLegacyMediaUrls1790300000000();

  // PGlite allows a single connection and the pool holds one: the query runner
  // must be released before dataSource.query() runs again.
  async function run(direction: 'up' | 'down'): Promise<void> {
    const queryRunner = dataSource.createQueryRunner();
    try {
      await migration[direction](queryRunner);
    } finally {
      await queryRunner.release();
    }
  }

  const columns = async (): Promise<string[]> =>
    (
      (await dataSource.query(
        `SELECT table_name||'.'||column_name AS c FROM information_schema.columns
         WHERE table_schema = 'public'
           AND ((table_name = 'products' AND column_name IN ('image_url', 'image_storage_key'))
             OR (table_name = 'businesses' AND column_name IN ('logo_url', 'logo_storage_key')))
         ORDER BY 1`,
      )) as Array<{ c: string }>
    ).map((r) => r.c);

  const ALL_FOUR = ['businesses.logo_storage_key', 'businesses.logo_url', 'products.image_storage_key', 'products.image_url'];
  const KEYS_ONLY = ['businesses.logo_storage_key', 'products.image_storage_key'];

  const fingerprint = async (): Promise<string> =>
    (
      (await dataSource.query(
        `SELECT md5(coalesce((SELECT string_agg(p::text, '|' ORDER BY id) FROM products p), '') ||
                    coalesce((SELECT string_agg(b::text, '|' ORDER BY id) FROM businesses b), '')) AS h`,
      )) as Array<{ h: string }>
    )[0].h;

  async function product(name: string): Promise<Product> {
    const repo = dataSource.getRepository(Product);
    return repo.save(repo.create({ businessId: business.id, categoryId: category.id, name, price: 5000 }));
  }
  const setProduct = (id: string, assignments: string, params: unknown[] = []) =>
    dataSource.query(`UPDATE products SET ${assignments} WHERE id = $1`, [id, ...params]);

  async function expectRefusal(message: RegExp): Promise<void> {
    const before = await fingerprint();
    const error = await run('up').then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error, 'the migration must refuse to run').not.toBeNull();
    expect(error!.message).toMatch(message);
    expect(error!.message).toMatch(/nothing was changed/);
    // No ids, no URLs in the message.
    expect(error!.message).not.toMatch(/https?:\/\//);
    // The schema and every row are exactly as before.
    expect(await columns()).toEqual(ALL_FOUR);
    expect(await fingerprint()).toBe(before);
  }

  let blocking: Product; // not deleted, legacy URL, no key
  let withKey: Product; // legacy URL AND key (the migrated case)
  let deletedLegacy: Product; // soft-deleted, legacy URL, no key

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

    // Normal application startup has just happened, on an EMPTY database.
    const [probe] = await dataSource.query(
      `SELECT to_regclass('public.migrations')::text AS migrations, to_regclass('public.products')::text AS products`,
    );
    startupProbe = probe;

    await runMigrationsBefore(dataSource, DropLegacyMediaUrls1790300000000);

    business = await seedBusinessAtSchemaState(dataSource, 'Drop Co', 'drop-co-e2e');
    const categoryRepo = dataSource.getRepository(Category);
    category = await categoryRepo.save(
      categoryRepo.create({ name: 'Burgers', slug: 'burgers', businessId: business.id, sortOrder: 1 }),
    );

    await product('Sin imagen');
    withKey = await product('Con clave y URL');
    await setProduct(withKey.id, `image_url = $2, image_storage_key = $3`, [URL_A, productImageKey(business.id, withKey.id, OBJ)]);
    blocking = await product('URL sin clave');
    await setProduct(blocking.id, `image_url = $2`, [URL_B]);
    deletedLegacy = await product('Borrado con URL');
    await setProduct(deletedLegacy.id, `image_url = $2`, [URL_DELETED]);
    await dataSource.getRepository(Product).softDelete(deletedLegacy.id);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await testDb?.stop();
  });

  it('normal application startup ran no migration and created no table', () => {
    expect(startupProbe).toEqual({ migrations: null, products: null });
  });

  it('starts from the real pre-migration schema: all four columns exist', async () => {
    expect(await columns()).toEqual(ALL_FOUR);
  });

  it('ABORTS when a non-deleted product has a legacy URL but no storage key — schema and data untouched', async () => {
    await expectRefusal(/1 non-deleted product\(s\).*0 business\(es\)/);
  });

  it('ABORTS on a business with a legacy logo but no key, even when the products are fine', async () => {
    // Fix the product (give it a key) and break the business instead.
    await setProduct(blocking.id, `image_storage_key = $2`, [productImageKey(business.id, blocking.id, OBJ.replace('cccccccc', 'dddddddd'))]);
    await dataSource.query(`UPDATE businesses SET logo_url = $1 WHERE id = $2`, [URL_LOGO, business.id]);

    await expectRefusal(/0 non-deleted product\(s\).*1 business\(es\)/);
  });

  it('reports both counts when both guards trip', async () => {
    await setProduct(blocking.id, `image_storage_key = NULL`);
    await expectRefusal(/1 non-deleted product\(s\).*1 business\(es\)/);
  });

  it('soft-deleted rows do NOT block: with every live row migrated, the DROP succeeds', async () => {
    await setProduct(blocking.id, `image_storage_key = $2`, [productImageKey(business.id, blocking.id, OBJ.replace('cccccccc', 'dddddddd'))]);
    await dataSource.query(`UPDATE businesses SET logo_storage_key = $1 WHERE id = $2`, [businessLogoKey(business.id, OBJ), business.id]);
    // Still present and still carrying a legacy URL and no key: the soft-deleted product.
    const [stillThere] = await dataSource.query(
      `SELECT count(*)::int AS n FROM products WHERE deleted_at IS NOT NULL AND image_url IS NOT NULL AND image_storage_key IS NULL`,
    );
    expect(stillThere.n).toBe(1);

    await run('up');

    // Both legacy columns are gone; the key columns remain.
    expect(await columns()).toEqual(KEYS_ONLY);
    // Data survived: every row is still there and the keys are intact.
    const [counts] = await dataSource.query(
      `SELECT (SELECT count(*)::int FROM products) AS products, (SELECT count(*)::int FROM products WHERE image_storage_key IS NOT NULL) AS keyed,
              (SELECT count(*)::int FROM products WHERE deleted_at IS NOT NULL) AS deleted, (SELECT count(*)::int FROM businesses WHERE logo_storage_key IS NOT NULL) AS logos`,
    );
    expect(counts).toEqual({ products: 4, keyed: 2, deleted: 1, logos: 1 });
  });

  it('down() recreates both columns as nullable text — schema only, the old values are NOT recovered', async () => {
    await run('down');

    expect(await columns()).toEqual(ALL_FOUR);
    const info = await dataSource.query(
      `SELECT table_name||'.'||column_name AS c, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name IN ('image_url', 'logo_url') ORDER BY 1`,
    );
    expect(info).toEqual([
      { c: 'businesses.logo_url', data_type: 'text', is_nullable: 'YES', column_default: null },
      { c: 'products.image_url', data_type: 'text', is_nullable: 'YES', column_default: null },
    ]);
    const [values] = await dataSource.query(
      `SELECT (SELECT count(image_url)::int FROM products) AS image_urls, (SELECT count(logo_url)::int FROM businesses) AS logo_urls,
              (SELECT count(image_storage_key)::int FROM products) AS keys`,
    );
    expect(values).toEqual({ image_urls: 0, logo_urls: 0, keys: 2 });
  });

  it('can be applied again after a rollback (the guards see no legacy values)', async () => {
    await run('up');
    expect(await columns()).toEqual(KEYS_ONLY);
  });
});
