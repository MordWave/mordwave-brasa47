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
const OBJ = 'cccccccc-3333-4abc-8def-333333333abc';

// End-to-end proof of what the API puts on the wire for products and
// businesses: internal storage keys never leak, and `imageUrl` / `logoUrl` are
// the stable /media URL of the row's storage key — or null when there is no key
// (or no MEDIA_PUBLIC_BASE_URL to build the URL with). Run once with the
// variable unset and once with it set. The image pipeline is replaced by a stub
// that returns the storage key it was given — nothing here can reach any
// external service (the real pipeline is covered in media-upload.e2e-spec.ts).
describe.each([
  { label: 'MEDIA_PUBLIC_BASE_URL unset', base: undefined },
  { label: 'MEDIA_PUBLIC_BASE_URL set', base: BASE },
])('Media presenters on the wire (e2e, real local Postgres) — $label', ({ base }) => {
  let testDb: TestDatabase;
  let app: INestApplication;
  let dataSource: DataSource;

  let business: Business;
  let noImage: Product;
  let keyed: Product;
  let keyedKey: string;
  let logoKey: string;
  let uploadedLogoKey: string;
  let qrToken: string;
  let token: string;
  const admin = { email: 'admin@media-e2e.test', password: 'Sup3rSecret!M' };

  // What a row with this key must be served as.
  const mediaUrl = (key: string | null) => (key && base ? `${base}/media/${key}` : null);

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
      businessRepo.create({ name: 'Media Co', slug: 'media-co-presenters' }),
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
    noImage = await productRepo.save(
      productRepo.create({ businessId: business.id, categoryId: category.id, name: 'Sin imagen', price: 5000, sortOrder: 1 }),
    );
    keyed = await productRepo.save(
      productRepo.create({ businessId: business.id, categoryId: category.id, name: 'Con imagen', price: 6000, sortOrder: 2 }),
    );
    keyedKey = productImageKey(business.id, keyed.id, OBJ);
    await productRepo.update(keyed.id, { imageStorageKey: keyedKey });

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
  // value, and a raw key may only ever show up inside a /media URL.
  function expectNoLeak(body: unknown): void {
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/storage_?key/i);
    // Any /media URL is fine; a raw key outside one is a leak.
    const withoutMediaUrls = text.replace(new RegExp(`${BASE}/media/businesses/[a-z0-9/-]+\\.webp`, 'g'), '');
    expect(withoutMediaUrls).not.toMatch(/businesses\/[0-9a-f-]{36}\//);
  }

  const PRODUCT_FIELDS = [
    'id', 'name', 'description', 'price', 'imageUrl', 'available', 'active', 'sortOrder', 'tag',
    'ingredients', 'removableIngredients', 'addOns', 'businessId', 'categoryId', 'createdAt',
    'updatedAt', 'deletedAt',
  ].sort();

  describe('products', () => {
    it('GET /products (public list)', async () => {
      const res = await request(app.getHttpServer())
        .get('/products')
        .query({ businessSlug: business.slug })
        .expect(200);
      expectNoLeak(res.body);
      const byId = new Map<string, { imageUrl: string | null }>(res.body.map((p: { id: string }) => [p.id, p]));
      expect(byId.get(noImage.id)?.imageUrl).toBeNull();
      expect(byId.get(keyed.id)?.imageUrl).toBe(mediaUrl(keyedKey));
    });

    it('GET /products/:id (public detail) keeps the response contract', async () => {
      const res = await request(app.getHttpServer())
        .get(`/products/${keyed.id}`)
        .query({ businessSlug: business.slug })
        .expect(200);
      expectNoLeak(res.body);
      expect(res.body.imageUrl).toBe(mediaUrl(keyedKey));
      expect(Object.keys(res.body).sort()).toEqual(PRODUCT_FIELDS);
    });

    it('GET /products/admin (paginated)', async () => {
      const res = await request(app.getHttpServer()).get('/products/admin').set(auth()).expect(200);
      expectNoLeak(res.body);
      expect(res.body).toMatchObject({ page: 1 });
      const byId = new Map<string, { imageUrl: string | null }>(res.body.items.map((p: { id: string }) => [p.id, p]));
      expect(byId.get(noImage.id)?.imageUrl).toBeNull();
      expect(byId.get(keyed.id)?.imageUrl).toBe(mediaUrl(keyedKey));
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
      expect(Object.keys(res.body).sort()).toEqual(PRODUCT_FIELDS);
    });

    it('PATCH /products/:id (update) — response has no key', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/products/${keyed.id}`)
        .set(auth())
        .send({ name: 'Con imagen 2' })
        .expect(200);
      expectNoLeak(res.body);
      expect(res.body.name).toBe('Con imagen 2');
      expect(res.body.imageUrl).toBe(mediaUrl(keyedKey));
    });

    it('POST /products/:id/image stores a key; DELETE clears it — no key in either response', async () => {
      const up = await request(app.getHttpServer())
        .post(`/products/${noImage.id}/image`)
        .set(auth())
        .attach('file', Buffer.from('fake'), { filename: 'a.png', contentType: 'image/png' })
        .expect(201);
      expectNoLeak(up.body);
      const [stored] = await dataSource.query(`SELECT image_storage_key FROM products WHERE id = $1`, [noImage.id]);
      expect(stored.image_storage_key).toMatch(new RegExp(`^businesses/${business.id}/products/${noImage.id}/`));
      expect(up.body.imageUrl).toBe(mediaUrl(stored.image_storage_key));

      const del = await request(app.getHttpServer())
        .delete(`/products/${noImage.id}/image`)
        .set(auth())
        .expect(200);
      expectNoLeak(del.body);
      expect(del.body.imageUrl).toBeNull();
      const [cleared] = await dataSource.query(`SELECT image_storage_key FROM products WHERE id = $1`, [noImage.id]);
      expect(cleared.image_storage_key).toBeNull();
    });

    it.each(['imageUrl', 'image_url', 'imageStorageKey', 'image_storage_key'])(
      'a client can never send %s on create or update',
      async (field) => {
        const categoryId = (await dataSource.getRepository(Category).findOneByOrFail({ businessId: business.id })).id;
        const body = { [field]: productImageKey(business.id, keyed.id, OBJ) };
        await request(app.getHttpServer()).patch(`/products/${noImage.id}`).set(auth()).send(body).expect(400);
        const valid = { name: 'X', price: 1, categoryId, businessId: business.id };
        // Control: the same body without the forbidden field is accepted, so
        // the 400 below can only be about that field.
        await request(app.getHttpServer()).post('/products').set(auth()).send(valid).expect(201);
        await request(app.getHttpServer()).post('/products').set(auth()).send({ ...valid, ...body }).expect(400);
        const [row] = await dataSource.query(`SELECT image_storage_key FROM products WHERE id = $1`, [noImage.id]);
        expect(row.image_storage_key).toBeNull();
      },
    );
  });

  describe('business', () => {
    it('GET /businesses/me', async () => {
      const res = await request(app.getHttpServer()).get('/businesses/me').set(auth()).expect(200);
      expectNoLeak(res.body);
      expect(res.body.logoUrl).toBe(mediaUrl(logoKey));
    });

    it('PATCH /businesses/me', async () => {
      const res = await request(app.getHttpServer())
        .patch('/businesses/me')
        .set(auth())
        .send({ hours: 'Lun-Dom 12:00-23:00' })
        .expect(200);
      expectNoLeak(res.body);
      expect(res.body.hours).toBe('Lun-Dom 12:00-23:00');
      expect(res.body.logoUrl).toBe(mediaUrl(logoKey));
    });

    it('POST /businesses/me/logo stores a key and leaks nothing', async () => {
      const res = await request(app.getHttpServer())
        .post('/businesses/me/logo')
        .set(auth())
        .attach('file', Buffer.from('fake'), { filename: 'a.png', contentType: 'image/png' })
        .expect(201);
      expectNoLeak(res.body);
      const [row] = await dataSource.query(`SELECT logo_storage_key FROM businesses WHERE id = $1`, [business.id]);
      expect(row.logo_storage_key).toMatch(new RegExp(`^businesses/${business.id}/logo/`));
      uploadedLogoKey = row.logo_storage_key;
      expect(res.body.logoUrl).toBe(mediaUrl(uploadedLogoKey));
    });

    it.each(['logoUrl', 'logo_url', 'logoStorageKey', 'logo_storage_key'])('a client can never write %s', async (field) => {
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
      // The upload test above replaced the key.
      expect(res.body.logoUrl).toBe(mediaUrl(uploadedLogoKey));
    });
  });
});
