import bcrypt from 'bcrypt';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { Business } from '../src/business/business.entity.js';
import { Category } from '../src/category/category.entity.js';
import { businessLogoKey, productImageKey } from '../src/media/media-key.util.js';
import { Product } from '../src/product/product.entity.js';
import { ImageStorageService } from '../src/storage/image-storage.service.js';
import { RestaurantTable } from '../src/table/table.entity.js';
import { TableSession } from '../src/table/table-session.entity.js';
import { TableSessionStatus } from '../src/table/table-session-status.enum.js';
import { User } from '../src/user/user.entity.js';
import { UserRole } from '../src/user/user-role.enum.js';
import { runAllMigrations } from './support/run-all-migrations.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

const TEST_BCRYPT_COST = 4;
const BASE = 'https://api.example.test';
const LEGACY_PRODUCT = 'https://legacy.example/product-images/p.webp?v=1';
const LEGACY_LOGO = 'https://legacy.example/product-images/business-logos/b/logo.webp?v=1';
const OBJ = 'cccccccc-3333-4abc-8def-333333333abc';

// End-to-end proof of what the API actually puts on the wire for products and
// businesses: internal storage keys never leak, and the image/logo URL is the
// legacy one exactly unless a key exists AND MEDIA_PUBLIC_BASE_URL is set.
// Run once with the variable unset and once with it set. The image pipeline is
// replaced by a stub that returns a fresh storage key — nothing here can reach
// any external service (the real pipeline is covered in media-upload.e2e-spec.ts).
describe.each([
  { label: 'MEDIA_PUBLIC_BASE_URL unset', base: undefined },
  { label: 'MEDIA_PUBLIC_BASE_URL set', base: BASE },
])('Media presenters on the wire (e2e, real local Postgres) — $label', ({ base }) => {
  let testDb: TestDatabase;
  let app: INestApplication;
  let dataSource: DataSource;

  let business: Business;
  let legacyOnly: Product; // no key
  let keyed: Product; // key + legacy URL
  let keyedUrl: string;
  let logoKey: string;
  let uploadedLogoKey: string;
  let qrToken: string;
  let token: string;
  const admin = { email: 'admin@media-e2e.test', password: 'Sup3rSecret!M' };

  // Mirrors the resolution rule: key wins only when the base URL is set.
  const expectedImage = (p: Product, key: string | null) =>
    base && key ? `${base}/media/${key}` : p.imageUrl;

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
    if (base) process.env.MEDIA_PUBLIC_BASE_URL = base;
    else delete process.env.MEDIA_PUBLIC_BASE_URL;

    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ImageStorageService)
      .useValue({
        upload: async (key: string) => key,
      })
      .compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    dataSource = moduleFixture.get(DataSource);
    await runAllMigrations(dataSource);

    const businessRepo = dataSource.getRepository(Business);
    business = await businessRepo.save(
      businessRepo.create({ name: 'Media Co', slug: 'media-co-presenters', logoUrl: LEGACY_LOGO }),
    );
    logoKey = businessLogoKey(business.id, OBJ);
    await businessRepo.update(business.id, { logoStorageKey: logoKey });

    const userRepo = dataSource.getRepository(User);
    await userRepo.save(
      userRepo.create({
        email: admin.email,
        passwordHash: await bcrypt.hash(admin.password, TEST_BCRYPT_COST),
        role: UserRole.ADMIN,
        businessId: business.id,
      }),
    );

    const categoryRepo = dataSource.getRepository(Category);
    const category = await categoryRepo.save(
      categoryRepo.create({ name: 'Burgers', slug: 'burgers', businessId: business.id, sortOrder: 1 }),
    );
    const productRepo = dataSource.getRepository(Product);
    legacyOnly = await productRepo.save(
      productRepo.create({
        businessId: business.id,
        categoryId: category.id,
        name: 'Legacy',
        price: 5000,
        sortOrder: 1,
        imageUrl: LEGACY_PRODUCT,
      }),
    );
    keyed = await productRepo.save(
      productRepo.create({
        businessId: business.id,
        categoryId: category.id,
        name: 'Keyed',
        price: 6000,
        sortOrder: 2,
        imageUrl: LEGACY_PRODUCT,
      }),
    );
    keyedUrl = productImageKey(business.id, keyed.id, OBJ);
    await productRepo.update(keyed.id, { imageStorageKey: keyedUrl });

    qrToken = 'qr-token-media-presenters';
    const tableRepo = dataSource.getRepository(RestaurantTable);
    const table = await tableRepo.save(
      tableRepo.create({ businessId: business.id, name: 'Mesa 1', qrToken }),
    );
    const sessionRepo = dataSource.getRepository(TableSession);
    await sessionRepo.save(
      sessionRepo.create({
        tableId: table.id,
        businessId: business.id,
        sessionToken: 'session-token-media-presenters',
        status: TableSessionStatus.OPEN,
      }),
    );

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: admin.email, password: admin.password })
      .expect(200);
    token = login.body.accessToken;
  });

  afterAll(async () => {
    delete process.env.MEDIA_PUBLIC_BASE_URL;
    await app?.close();
    await testDb?.stop();
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  // Nothing internal may ever appear in a response body, by field name or by
  // value, and the raw key may only ever show up inside a /media URL.
  function expectNoLeak(body: unknown): void {
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/storage_?key/i);
    // Any /media URL is fine; a raw key outside one is a leak.
    const withoutMediaUrls = text.replace(new RegExp(`${BASE}/media/businesses/[a-z0-9/-]+\\.webp`, 'g'), '');
    expect(withoutMediaUrls).not.toMatch(/businesses\/[0-9a-f-]{36}\//);
  }

  describe('products', () => {
    it('GET /products (public list)', async () => {
      const res = await request(app.getHttpServer())
        .get('/products')
        .query({ businessSlug: business.slug })
        .expect(200);
      expectNoLeak(res.body);
      const byId = new Map<string, { imageUrl: string | null }>(res.body.map((p: { id: string }) => [p.id, p]));
      expect(byId.get(legacyOnly.id)?.imageUrl).toBe(LEGACY_PRODUCT);
      expect(byId.get(keyed.id)?.imageUrl).toBe(expectedImage(keyed, keyedUrl));
    });

    it('GET /products/:id (public detail)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/products/${keyed.id}`)
        .query({ businessSlug: business.slug })
        .expect(200);
      expectNoLeak(res.body);
      expect(res.body.imageUrl).toBe(expectedImage(keyed, keyedUrl));
      // Same field set as before the keys existed, minus nothing else.
      expect(Object.keys(res.body).sort()).toEqual(
        [
          'id', 'name', 'description', 'price', 'imageUrl', 'available', 'active', 'sortOrder', 'tag',
          'ingredients', 'removableIngredients', 'addOns', 'businessId', 'categoryId', 'createdAt',
          'updatedAt', 'deletedAt',
        ].sort(),
      );
    });

    it('GET /products/admin (paginated)', async () => {
      const res = await request(app.getHttpServer()).get('/products/admin').set(auth()).expect(200);
      expectNoLeak(res.body);
      expect(res.body).toMatchObject({ page: 1 });
      const byId = new Map<string, { imageUrl: string | null }>(res.body.items.map((p: { id: string }) => [p.id, p]));
      expect(byId.get(legacyOnly.id)?.imageUrl).toBe(LEGACY_PRODUCT);
      expect(byId.get(keyed.id)?.imageUrl).toBe(expectedImage(keyed, keyedUrl));
    });

    it('POST /products (create) — response has no key and starts without an image', async () => {
      const categoryId = (await dataSource.getRepository(Category).findOneByOrFail({ businessId: business.id })).id;
      const res = await request(app.getHttpServer())
        .post('/products')
        .set(auth())
        .send({ name: 'Nueva', price: 1000, categoryId, businessId: business.id })
        .expect(201);
      expectNoLeak(res.body);
      expect(res.body.imageUrl).toBeNull();
    });

    it('PATCH /products/:id (update) — response has no key', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/products/${keyed.id}`)
        .set(auth())
        .send({ name: 'Keyed 2' })
        .expect(200);
      expectNoLeak(res.body);
      expect(res.body.name).toBe('Keyed 2');
      expect(res.body.imageUrl).toBe(expectedImage(keyed, keyedUrl));
    });

    it('POST /products/:id/image keeps the legacy URL and stores a key; DELETE clears both — no key in either response', async () => {
      const up = await request(app.getHttpServer())
        .post(`/products/${legacyOnly.id}/image`)
        .set(auth())
        .attach('file', Buffer.from('fake'), { filename: 'a.png', contentType: 'image/png' })
        .expect(201);
      expectNoLeak(up.body);
      const [stored] = await dataSource.query(
        `SELECT image_url, image_storage_key FROM products WHERE id = $1`,
        [legacyOnly.id],
      );
      expect(stored.image_url).toBe(LEGACY_PRODUCT); // legacy fallback preserved
      expect(stored.image_storage_key).toMatch(new RegExp(`^businesses/${business.id}/products/${legacyOnly.id}/`));
      // The presenter prefers the key when /media URLs can be built.
      expect(up.body.imageUrl).toBe(base ? `${base}/media/${stored.image_storage_key}` : LEGACY_PRODUCT);

      const del = await request(app.getHttpServer())
        .delete(`/products/${legacyOnly.id}/image`)
        .set(auth())
        .expect(200);
      expectNoLeak(del.body);
      expect(del.body.imageUrl).toBeNull();
      const [cleared] = await dataSource.query(
        `SELECT image_url, image_storage_key FROM products WHERE id = $1`,
        [legacyOnly.id],
      );
      expect(cleared).toEqual({ image_url: null, image_storage_key: null });
    });

    it('imageUrl is not writable through create or update any more', async () => {
      const categoryId = (await dataSource.getRepository(Category).findOneByOrFail({ businessId: business.id })).id;
      const evil = { imageUrl: 'https://evil.example/x.png' };
      await request(app.getHttpServer()).patch(`/products/${keyed.id}`).set(auth()).send(evil).expect(400);
      await request(app.getHttpServer())
        .post('/products')
        .set(auth())
        .send({ name: 'X', price: 1, categoryId, businessId: business.id, ...evil })
        .expect(400);
    });

    it.each(['imageStorageKey', 'image_storage_key'])(
      'a client can never write %s (create and update both reject it)',
      async (field) => {
        const categoryId = (await dataSource.getRepository(Category).findOneByOrFail({ businessId: business.id })).id;
        const body = { [field]: productImageKey(business.id, keyed.id, OBJ) };
        await request(app.getHttpServer()).patch(`/products/${legacyOnly.id}`).set(auth()).send(body).expect(400);
        const valid = { name: 'X', price: 1, categoryId, businessId: business.id };
        // Control: the same body without the forbidden field is accepted, so
        // the 400 below can only be about that field.
        await request(app.getHttpServer()).post('/products').set(auth()).send(valid).expect(201);
        await request(app.getHttpServer()).post('/products').set(auth()).send({ ...valid, ...body }).expect(400);
        const [row] = await dataSource.query(`SELECT image_storage_key FROM products WHERE id = $1`, [legacyOnly.id]);
        expect(row.image_storage_key).toBeNull();
      },
    );
  });

  describe('business', () => {
    it('GET /businesses/me', async () => {
      const res = await request(app.getHttpServer()).get('/businesses/me').set(auth()).expect(200);
      expectNoLeak(res.body);
      expect(res.body.logoUrl).toBe(base ? `${base}/media/${logoKey}` : LEGACY_LOGO);
    });

    it('PATCH /businesses/me', async () => {
      const res = await request(app.getHttpServer())
        .patch('/businesses/me')
        .set(auth())
        .send({ hours: 'Lun-Dom 12:00-23:00' })
        .expect(200);
      expectNoLeak(res.body);
      expect(res.body.hours).toBe('Lun-Dom 12:00-23:00');
      expect(res.body.logoUrl).toBe(base ? `${base}/media/${logoKey}` : LEGACY_LOGO);
    });

    it('POST /businesses/me/logo stores a key, keeps the legacy logo_url, and leaks nothing', async () => {
      const res = await request(app.getHttpServer())
        .post('/businesses/me/logo')
        .set(auth())
        .attach('file', Buffer.from('fake'), { filename: 'a.png', contentType: 'image/png' })
        .expect(201);
      expectNoLeak(res.body);
      const [row] = await dataSource.query(`SELECT logo_url, logo_storage_key FROM businesses WHERE id = $1`, [business.id]);
      expect(row.logo_url).toBe(LEGACY_LOGO);
      expect(row.logo_storage_key).toMatch(new RegExp(`^businesses/${business.id}/logo/`));
      uploadedLogoKey = row.logo_storage_key;
      expect(res.body.logoUrl).toBe(base ? `${base}/media/${uploadedLogoKey}` : LEGACY_LOGO);
    });

    it.each(['logoStorageKey', 'logo_storage_key'])('a client can never write %s', async (field) => {
      await request(app.getHttpServer())
        .patch('/businesses/me')
        .set(auth())
        .send({ [field]: businessLogoKey(business.id, OBJ) })
        .expect(400);
    });

    it('POST /table-sessions/join — branding logoUrl follows the same rule and leaks nothing', async () => {
      const res = await request(app.getHttpServer())
        .post('/table-sessions/join')
        .send({ qrToken })
        .expect(200);
      expectNoLeak(res.body);
      expect(Object.keys(res.body).sort()).toEqual(
        ['sessionToken', 'tableName', 'businessSlug', 'businessName', 'logoUrl', 'primaryColor', 'accentColor'].sort(),
      );
      // The upload test above replaced the key; the legacy logo_url is untouched.
      expect(res.body.logoUrl).toBe(base ? `${base}/media/${uploadedLogoKey}` : LEGACY_LOGO);
    });
  });
});
