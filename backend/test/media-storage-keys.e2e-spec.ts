import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { Business } from '../src/business/business.entity.js';
import { Category } from '../src/category/category.entity.js';
import { isBusinessLogoKey, isProductImageKey } from '../src/media/media-key.util.js';
import { AddMediaStorageKeys1790200000000 } from '../src/migrations/1790200000000-AddMediaStorageKeys.js';
import { Product } from '../src/product/product.entity.js';
import { LOGO_KEY_CASES, PRODUCT_KEY_CASES } from './support/media-key-cases.js';
import { runAllMigrations } from './support/run-all-migrations.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

const OTHER_BIZ = 'dddddddd-4444-4abc-8def-444444444abc';
const OBJ = 'cccccccc-3333-4abc-8def-333333333abc';
const LEGACY = 'https://legacy.example/product-images/a.webp?v=1';

// Real-database proof of the AddMediaStorageKeys migration: the columns, the
// CHECK constraints (replaying the exact same case table the unit spec uses
// against the util regex), that the entity metadata matches the migrated
// schema (no drift), and that down()/up() round-trip. Ephemeral local
// PGlite, never Supabase/Railway — same isolation as audit.e2e-spec.ts.
describe('Media storage keys schema (e2e, real local Postgres)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  let dataSource: DataSource;
  let business: Business;
  let product: Product;

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

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    dataSource = moduleFixture.get(DataSource);

    await runAllMigrations(dataSource);

    const businessRepo = dataSource.getRepository(Business);
    business = await businessRepo.save(
      businessRepo.create({ name: 'Media Co', slug: 'media-co-e2e', logoUrl: LEGACY }),
    );
    const categoryRepo = dataSource.getRepository(Category);
    const category = await categoryRepo.save(
      categoryRepo.create({ name: 'Burgers', slug: 'burgers', businessId: business.id, sortOrder: 1 }),
    );
    const productRepo = dataSource.getRepository(Product);
    product = await productRepo.save(
      productRepo.create({
        businessId: business.id,
        categoryId: category.id,
        name: 'Clásica',
        price: 6900,
        imageUrl: LEGACY,
      }),
    );
  });

  afterAll(async () => {
    await app?.close();
    await testDb?.stop();
  });

  async function columnInfo(table: string, column: string) {
    const rows = await dataSource.query(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [table, column],
    );
    return rows[0] as { data_type: string; is_nullable: string; column_default: string | null } | undefined;
  }

  async function constraintNames(): Promise<string[]> {
    const rows: { conname: string }[] = await dataSource.query(
      `SELECT conname FROM pg_constraint WHERE conname IN ('CHK_products_image_storage_key', 'CHK_businesses_logo_storage_key') ORDER BY conname`,
    );
    return rows.map((r) => r.conname);
  }

  // Evaluates the constraint exactly as Postgres stored it (pg_get_constraintdef)
  // against a candidate value, without writing anything. A real violating
  // write is deliberately NOT used: pglite-socket desynchronises the single
  // shared connection after any server-side error (the next query receives
  // the previous error), which would corrupt every later test in this file.
  // Evaluating the stored definition proves the same thing — which values the
  // constraint accepts — and a CHECK is enforced by Postgres by definition.
  async function checkAccepts(constraint: string, column: string, value: string | null): Promise<boolean> {
    const [row]: { def: string }[] = await dataSource.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
      [constraint],
    );
    expect(row, `constraint ${constraint} exists`).toBeDefined();
    const expression = row.def.replace(/^CHECK\s*/, '');
    const [result]: { ok: boolean | null }[] = await dataSource.query(
      `WITH t(${column}) AS (VALUES ($1::text)) SELECT ${expression} AS ok FROM t`,
      [value],
    );
    // A CHECK passes unless it evaluates to FALSE (NULL passes).
    return result.ok !== false;
  }

  const productKeyAccepted = (key: string | null) =>
    checkAccepts('CHK_products_image_storage_key', 'image_storage_key', key);
  const logoKeyAccepted = (key: string | null) =>
    checkAccepts('CHK_businesses_logo_storage_key', 'logo_storage_key', key);

  const setProductKey = (key: string | null) =>
    dataSource.query(`UPDATE products SET image_storage_key = $1 WHERE id = $2`, [key, product.id]);

  describe('migration up()', () => {
    it('adds both columns as nullable text with no default', async () => {
      for (const [table, column] of [
        ['products', 'image_storage_key'],
        ['businesses', 'logo_storage_key'],
      ] as const) {
        expect(await columnInfo(table, column)).toEqual({
          data_type: 'text',
          is_nullable: 'YES',
          column_default: null,
        });
      }
    });

    it('leaves the legacy columns untouched and rows without a key at NULL', async () => {
      const [p] = await dataSource.query(
        `SELECT image_url, image_storage_key FROM products WHERE id = $1`,
        [product.id],
      );
      expect(p).toEqual({ image_url: LEGACY, image_storage_key: null });
      const [b] = await dataSource.query(
        `SELECT logo_url, logo_storage_key FROM businesses WHERE id = $1`,
        [business.id],
      );
      expect(b).toEqual({ logo_url: LEGACY, logo_storage_key: null });
      expect(await columnInfo('products', 'image_url')).toBeDefined();
      expect(await columnInfo('businesses', 'logo_url')).toBeDefined();
    });

    it('creates both named CHECK constraints', async () => {
      expect(await constraintNames()).toEqual([
        'CHK_businesses_logo_storage_key',
        'CHK_products_image_storage_key',
      ]);
    });
  });

  describe('CHECK constraints', () => {
    it.each(PRODUCT_KEY_CASES)('products.image_storage_key — %s', async (_label, key, valid) => {
      expect(await productKeyAccepted(key)).toBe(valid);
      // The database and the util regex must always agree.
      expect(isProductImageKey(key)).toBe(valid);
    });

    it.each(LOGO_KEY_CASES)('businesses.logo_storage_key — %s', async (_label, key, valid) => {
      expect(await logoKeyAccepted(key)).toBe(valid);
      expect(isBusinessLogoKey(key)).toBe(valid);
    });

    it('accepts NULL (clearing a key)', async () => {
      expect(await productKeyAccepted(null)).toBe(true);
      expect(await logoKeyAccepted(null)).toBe(true);
    });

    it("is about shape only: a key under another business prefix is accepted (tenancy is the app's job)", async () => {
      expect(
        await productKeyAccepted(`businesses/${OTHER_BIZ}/products/${product.id}/${OBJ}.webp`),
      ).toBe(true);
    });

    it('lets a key and a legacy URL coexist on the same row', async () => {
      const key = `businesses/${business.id}/products/${product.id}/${OBJ}.webp`;
      await setProductKey(key);
      const [row] = await dataSource.query(
        `SELECT image_url, image_storage_key FROM products WHERE id = $1`,
        [product.id],
      );
      expect(row).toEqual({ image_url: LEGACY, image_storage_key: key });
      await setProductKey(null);
    });
  });

  describe('schema drift', () => {
    it('the entity metadata and the migrated schema agree on the new columns and checks', async () => {
      const { upQueries } = await dataSource.driver.createSchemaBuilder().log();
      const sql = upQueries.map((q) => q.query);
      // Nothing about the new columns/checks may be pending (a pending
      // statement would mean `migration:generate` would emit it).
      expect(sql.filter((q) => /storage_key|CHK_products_image|CHK_businesses_logo/.test(q))).toEqual([]);
    });
  });

  describe('migration down() / up() round trip', () => {
    // The pool holds a single connection (DB_POOL_MAX=1), so a query runner
    // must be released before dataSource.query() can run again.
    async function run(direction: 'up' | 'down'): Promise<void> {
      const queryRunner = dataSource.createQueryRunner();
      try {
        await new AddMediaStorageKeys1790200000000()[direction](queryRunner);
      } finally {
        await queryRunner.release();
      }
    }

    it('down() removes columns and checks; up() restores them', async () => {
      await run('down');
      expect(await columnInfo('products', 'image_storage_key')).toBeUndefined();
      expect(await columnInfo('businesses', 'logo_storage_key')).toBeUndefined();
      expect(await constraintNames()).toEqual([]);
      // Control for the drift test above: with the migration reverted, the
      // schema builder MUST want to re-add the columns and checks, proving
      // that detector can actually fail.
      const { upQueries } = await dataSource.driver.createSchemaBuilder().log();
      const pending = upQueries.map((q) => q.query).filter((q) => /storage_key/.test(q));
      expect(pending.some((q) => /ADD "image_storage_key"/.test(q))).toBe(true);
      expect(pending.some((q) => /ADD "logo_storage_key"/.test(q))).toBe(true);
      // Legacy data survives the rollback.
      const [p] = await dataSource.query(`SELECT image_url FROM products WHERE id = $1`, [product.id]);
      expect(p.image_url).toBe(LEGACY);

      await run('up');
      expect(await columnInfo('products', 'image_storage_key')).toBeDefined();
      expect(await columnInfo('businesses', 'logo_storage_key')).toBeDefined();
      expect(await constraintNames()).toHaveLength(2);
    });
  });
});
