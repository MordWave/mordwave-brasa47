import type { AddressInfo } from 'node:net';
import bcrypt from 'bcrypt';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import sharp from 'sharp';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { Business } from '../src/business/business.entity.js';
import { Category } from '../src/category/category.entity.js';
import { ObjectStoreUnavailableError, S3ObjectStoreService } from '../src/media/s3-object-store.service.js';
import { Product } from '../src/product/product.entity.js';
import { User } from '../src/user/user.entity.js';
import { UserRole } from '../src/user/user-role.enum.js';
import { RestaurantTable } from '../src/table/table.entity.js';
import { TableSession } from '../src/table/table-session.entity.js';
import { TableSessionStatus } from '../src/table/table-session-status.enum.js';
import { runAllMigrations } from './support/run-all-migrations.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

// The API runtime must not use Supabase at all: any attempt to create a client
// fails loudly and is recorded.
const { createClient } = vi.hoisted(() => ({
  createClient: vi.fn(() => {
    throw new Error('Supabase must not be used by the API runtime');
  }),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient }));

const SUPABASE_VARS = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_STORAGE_BUCKET'];

const TEST_BCRYPT_COST = 4;
const BASE = 'https://api.example.test';

// In-memory stand-in for the Railway Bucket. It records every call so the
// tests can prove what is — and is not — done: puts happen, deletes can't
// (the real service has no delete operation at all).
class FakeBucket {
  isConfigured = true;
  failPut = false;
  readonly objects = new Map<string, { body: Buffer; contentType: string; cacheControl: string }>();
  readonly putKeys: string[] = [];

  async put(key: string, body: Buffer, contentType: string, cacheControl: string): Promise<void> {
    if (this.failPut) throw new ObjectStoreUnavailableError('S3 PutObject failed');
    this.putKeys.push(key);
    this.objects.set(key, { body, contentType, cacheControl });
  }
  async head(key: string) {
    const o = this.objects.get(key);
    return o ? { contentLength: o.body.length, contentType: o.contentType } : null;
  }
  async presignGet(key: string, ttl: number): Promise<string> {
    return `https://fake-bucket.example/${key}?X-Amz-Expires=${ttl}`;
  }
}

// The real upload pipeline (file-type -> sharp -> WebP) and the real
// controllers/services/presenters/DB, with only the bucket faked. Ephemeral
// local PGlite — never Supabase, never the Railway Bucket.
describe('Image uploads -> bucket (e2e, real local Postgres, fake bucket)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  let dataSource: DataSource;
  const bucket = new FakeBucket();

  let bizA: Business;
  let bizB: Business;
  let noImage: Product; // never had an image
  let second: Product; // replaced / removed in the tests
  let control: Product; // never gets an image uploaded successfully
  let tokenA: string;
  let tokenB: string;
  let png: Buffer;
  const adminA = { email: 'a@media-upload.test', password: 'Sup3rSecret!A' };
  const adminB = { email: 'b@media-upload.test', password: 'Sup3rSecret!B' };

  const baseUrl = () => `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const http = () => request(baseUrl());
  const authA = () => ({ Authorization: `Bearer ${tokenA}` });

  const upload = (productId: string, token = tokenA) =>
    http()
      .post(`/products/${productId}/image`)
      .set({ Authorization: `Bearer ${token}` })
      .attach('file', png, { filename: 'photo.png', contentType: 'image/png' });
  const uploadLogo = () =>
    http().post('/businesses/me/logo').set(authA()).attach('file', png, { filename: 'logo.png', contentType: 'image/png' });
  const row = async (id: string) =>
    (await dataSource.query(`SELECT image_storage_key FROM products WHERE id = $1`, [id]))[0] as {
      image_storage_key: string | null;
    };
  const bizRow = async () =>
    (await dataSource.query(`SELECT logo_storage_key FROM businesses WHERE id = $1`, [bizA.id]))[0] as {
      logo_storage_key: string | null;
    };

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
    process.env.MEDIA_PUBLIC_BASE_URL = BASE;
    // The whole suite runs WITHOUT any SUPABASE_* variable (a developer's .env may define them).
    for (const name of SUPABASE_VARS) delete process.env[name];

    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(S3ObjectStoreService)
      .useValue(bucket)
      .compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.listen(0, '127.0.0.1');
    dataSource = moduleFixture.get(DataSource);
    await runAllMigrations(dataSource);

    const businessRepo = dataSource.getRepository(Business);
    bizA = await businessRepo.save(
      businessRepo.create({ name: 'Tenant A', slug: 'tenant-a-upload' }),
    );
    bizB = await businessRepo.save(businessRepo.create({ name: 'Tenant B', slug: 'tenant-b-upload' }));

    const userRepo = dataSource.getRepository(User);
    for (const [admin, biz] of [
      [adminA, bizA],
      [adminB, bizB],
    ] as const) {
      await userRepo.save(
        userRepo.create({
          email: admin.email,
          passwordHash: await bcrypt.hash(admin.password, TEST_BCRYPT_COST),
          role: UserRole.ADMIN,
          businessId: biz.id,
        }),
      );
    }

    const categoryRepo = dataSource.getRepository(Category);
    const category = await categoryRepo.save(
      categoryRepo.create({ name: 'Burgers', slug: 'burgers', businessId: bizA.id, sortOrder: 1 }),
    );
    const productRepo = dataSource.getRepository(Product);
    const make = (name: string, extra: Partial<Product> = {}) =>
      productRepo.save(
        productRepo.create({ businessId: bizA.id, categoryId: category.id, name, price: 5000, ...extra }),
      );
    noImage = await make('Sin imagen', { sortOrder: 1 });
    second = await make('Segundo', { sortOrder: 2 });
    control = await make('Control', { sortOrder: 3 });

    const login = async (a: { email: string; password: string }) =>
      (await http().post('/auth/login').send(a).expect(200)).body.accessToken as string;
    tokenA = await login(adminA);
    tokenB = await login(adminB);

    // 2400x1600: bigger than the 1200 px output cap, so the resize is observable.
    png = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: '#cc3300' } })
      .png()
      .toBuffer();

    const tableRepo = dataSource.getRepository(RestaurantTable);
    const table = await tableRepo.save(tableRepo.create({ businessId: bizA.id, name: 'Mesa 1', qrToken: 'qr-media-upload' }));
    const sessionRepo = dataSource.getRepository(TableSession);
    await sessionRepo.save(
      sessionRepo.create({
        tableId: table.id,
        businessId: bizA.id,
        sessionToken: 'session-media-upload',
        status: TableSessionStatus.OPEN,
      }),
    );
  }, 60_000);

  afterAll(async () => {
    delete process.env.MEDIA_PUBLIC_BASE_URL;
    await app?.close();
    await testDb?.stop();
  });

  beforeEach(() => {
    bucket.failPut = false;
  });

  describe('product image', () => {
    it('stores a processed WebP in the bucket and answers with a stable /media URL — the key is in the DB, never in the JSON', async () => {
      const res = await upload(noImage.id).expect(201);

      const stored = await row(noImage.id);
      expect(stored.image_storage_key).toMatch(
        new RegExp(`^businesses/${bizA.id}/products/${noImage.id}/[0-9a-f-]{36}\\.webp$`),
      );
      expect(res.body.imageUrl).toBe(`${BASE}/media/${stored.image_storage_key}`);
      expect(JSON.stringify(res.body)).not.toMatch(/storage_?key/i);
      expect(Object.keys(res.body)).not.toContain('imageStorageKey');

      // The object itself: WebP, resized to fit 1200 px, immutable cache headers.
      const object = bucket.objects.get(stored.image_storage_key!)!;
      expect(object.contentType).toBe('image/webp');
      expect(object.cacheControl).toBe('public, max-age=31536000, immutable');
      const meta = await sharp(object.body).metadata();
      expect(meta.format).toBe('webp');
      expect(Math.max(meta.width!, meta.height!)).toBe(1200);
    });

    it('public product endpoints serve the /media URL, and /media redirects to the bucket', async () => {
      const key = (await row(noImage.id)).image_storage_key!;

      const detail = await http().get(`/products/${noImage.id}`).query({ businessSlug: bizA.slug }).expect(200);
      expect(detail.body.imageUrl).toBe(`${BASE}/media/${key}`);
      expect(JSON.stringify(detail.body)).not.toMatch(/storage_?key/i);

      const list = await http().get('/products').query({ businessSlug: bizA.slug }).expect(200);
      const found = (list.body as Array<{ id: string; imageUrl: string | null }>).find((p) => p.id === noImage.id);
      expect(found?.imageUrl).toBe(`${BASE}/media/${key}`);

      // /media (the route the URL above points at) keeps working end to end.
      const media = await http().get(`/media/${key}`).redirects(0).expect(302);
      expect(media.headers.location).toBe(`https://fake-bucket.example/${key}?X-Amz-Expires=3600`);
      await http().head(`/media/${key}`).redirects(0).expect(200);
    });

    it('replacing generates a different key, changes the /media URL, and deletes nothing', async () => {
      await upload(second.id).expect(201);
      const before = await row(second.id);
      const objectsBefore = new Set(bucket.objects.keys());

      const res = await upload(second.id).expect(201);

      const after = await row(second.id);
      expect(after.image_storage_key).not.toBe(before.image_storage_key);
      expect(res.body.imageUrl).toBe(`${BASE}/media/${after.image_storage_key}`);
      expect(res.body.imageUrl).not.toBe(`${BASE}/media/${before.image_storage_key}`);
      // The previous object is still there (left for the later orphan cleanup).
      for (const key of objectsBefore) expect(bucket.objects.has(key)).toBe(true);
      expect(bucket.objects.has(after.image_storage_key!)).toBe(true);
    });

    it('removing the image clears the key, answers imageUrl null, and deletes no object', async () => {
      const before = await row(second.id);
      const objectCount = bucket.objects.size;

      const res = await http().delete(`/products/${second.id}/image`).set(authA()).expect(200);

      expect(res.body.imageUrl).toBeNull();
      expect(await row(second.id)).toEqual({ image_storage_key: null });
      expect(bucket.objects.size).toBe(objectCount);
      expect(bucket.objects.has(before.image_storage_key!)).toBe(true);

      const detail = await http().get(`/products/${second.id}`).query({ businessSlug: bizA.slug }).expect(200);
      expect(detail.body.imageUrl).toBeNull();
    });

    it('a product without a key has no image (imageUrl null everywhere) — there is no other source', async () => {
      const detail = await http().get(`/products/${control.id}`).query({ businessSlug: bizA.slug }).expect(200);
      expect(detail.body.imageUrl).toBeNull();
      const list = await http().get('/products').query({ businessSlug: bizA.slug }).expect(200);
      expect((list.body as Array<{ id: string; imageUrl: string | null }>).find((p) => p.id === control.id)?.imageUrl).toBeNull();
      const admin = await http().get('/products/admin').set(authA()).expect(200);
      expect((admin.body.items as Array<{ id: string; imageUrl: string | null }>).find((p) => p.id === control.id)?.imageUrl).toBeNull();
    });

    it('the legacy image_url column no longer exists in the database', async () => {
      const cols = await dataSource.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'products' AND column_name IN ('image_url', 'image_storage_key')`,
      );
      expect(cols.map((c: { column_name: string }) => c.column_name)).toEqual(['image_storage_key']);
    });

    it('a bucket failure answers 502 IMAGE_UPLOAD_FAILED and leaves the DB untouched', async () => {
      const before = await row(control.id);
      bucket.failPut = true;

      const res = await upload(control.id).expect(502);

      expect(res.body.errorCode).toBe('IMAGE_UPLOAD_FAILED');
      expect(JSON.stringify(res.body)).not.toMatch(/S3|PutObject/);
      expect(await row(control.id)).toEqual(before);
    });

    it('an invalid file is rejected before anything reaches the bucket', async () => {
      const puts = bucket.putKeys.length;
      const res = await http()
        .post(`/products/${control.id}/image`)
        .set(authA())
        .attach('file', Buffer.from('definitely not an image'), { filename: 'x.png', contentType: 'image/png' })
        .expect(400);
      expect(res.body.errorCode).toBe('IMAGE_INVALID_FORMAT');
      expect(bucket.putKeys.length).toBe(puts);
    });

    it("another tenant's admin cannot upload to this product (403) and nothing is written", async () => {
      const puts = bucket.putKeys.length;
      await upload(control.id, tokenB).expect(403);
      expect(bucket.putKeys.length).toBe(puts);
      expect((await row(control.id)).image_storage_key).toBeNull();
    });

    it.each(['imageUrl', 'image_url', 'imageStorageKey', 'image_storage_key'])(
      'a client can never send %s on create or update',
      async (field) => {
        const categoryId = (await dataSource.getRepository(Category).findOneByOrFail({ businessId: bizA.id })).id;
        const body = { [field]: 'businesses/x' };
        await http().patch(`/products/${control.id}`).set(authA()).send(body).expect(400);
        const valid = { name: 'Z', price: 1, categoryId, businessId: bizA.id };
        await http().post('/products').set(authA()).send(valid).expect(201);
        await http().post('/products').set(authA()).send({ ...valid, ...body }).expect(400);
        expect(await row(control.id)).toEqual({ image_storage_key: null });
      },
    );
  });

  describe('business logo', () => {
    it('stores a processed WebP under businesses/<id>/logo/<uuid>.webp and answers with /media', async () => {
      const res = await uploadLogo().expect(201);

      const stored = await bizRow();
      expect(stored.logo_storage_key).toMatch(new RegExp(`^businesses/${bizA.id}/logo/[0-9a-f-]{36}\\.webp$`));
      expect(res.body.logoUrl).toBe(`${BASE}/media/${stored.logo_storage_key}`);
      expect(JSON.stringify(res.body)).not.toMatch(/storage_?key/i);
      const object = bucket.objects.get(stored.logo_storage_key!)!;
      expect(object.contentType).toBe('image/webp');
      expect(object.cacheControl).toBe('public, max-age=31536000, immutable');
    });

    it('replacing the logo generates a different key and deletes nothing', async () => {
      const before = await bizRow();
      const count = bucket.objects.size;

      const res = await uploadLogo().expect(201);

      const after = await bizRow();
      expect(after.logo_storage_key).not.toBe(before.logo_storage_key);
      expect(res.body.logoUrl).toBe(`${BASE}/media/${after.logo_storage_key}`);
      expect(bucket.objects.size).toBe(count + 1);
      expect(bucket.objects.has(before.logo_storage_key!)).toBe(true);
    });

    it('GET /businesses/me and the customer join expose the /media logo and no key', async () => {
      const key = (await bizRow()).logo_storage_key!;

      const me = await http().get('/businesses/me').set(authA()).expect(200);
      expect(me.body.logoUrl).toBe(`${BASE}/media/${key}`);
      expect(JSON.stringify(me.body)).not.toMatch(/storage_?key/i);

      const join = await http().post('/table-sessions/join').send({ qrToken: 'qr-media-upload' }).expect(200);
      expect(join.body.logoUrl).toBe(`${BASE}/media/${key}`);
      expect(JSON.stringify(join.body)).not.toMatch(/storage_?key/i);
    });

    it('the legacy logo_url column no longer exists, and clearing the key leaves no logo anywhere', async () => {
      const cols = await dataSource.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'businesses' AND column_name IN ('logo_url', 'logo_storage_key')`,
      );
      expect(cols.map((c: { column_name: string }) => c.column_name)).toEqual(['logo_storage_key']);

      await dataSource.query(`UPDATE businesses SET logo_storage_key = NULL WHERE id = $1`, [bizA.id]);
      const me = await http().get('/businesses/me').set(authA()).expect(200);
      expect(me.body.logoUrl).toBeNull();
      const join = await http().post('/table-sessions/join').send({ qrToken: 'qr-media-upload' }).expect(200);
      expect(join.body.logoUrl).toBeNull();

      // …and a fresh upload takes over again.
      const res = await uploadLogo().expect(201);
      expect(res.body.logoUrl).toMatch(new RegExp(`^${BASE}/media/businesses/${bizA.id}/logo/`));
    });

    it('a bucket failure answers 502 and leaves the business untouched', async () => {
      const before = await bizRow();
      bucket.failPut = true;
      await uploadLogo().expect(502);
      expect(await bizRow()).toEqual(before);
    });

    it.each(['logoUrl', 'logo_url', 'logoStorageKey', 'logo_storage_key'])(
      'PATCH /businesses/me rejects %s',
      async (field) => {
        await http().patch('/businesses/me').set(authA()).send({ [field]: 'x' }).expect(400);
      },
    );
  });

  describe('Supabase is not part of the API runtime', () => {
    it('the app booted without SUPABASE_URL, SUPABASE_SECRET_KEY or SUPABASE_STORAGE_BUCKET', async () => {
      for (const name of SUPABASE_VARS) expect(process.env[name]).toBeUndefined();
      await http().get('/health').expect(200);
    });

    it('serves the public menu and uploads/replaces/removes product and logo images with no Supabase client ever created', async () => {
      await http().get('/products').query({ businessSlug: bizA.slug }).expect(200);
      await upload(noImage.id).expect(201);
      await http().delete(`/products/${noImage.id}/image`).set(authA()).expect(200);
      await uploadLogo().expect(201);
      expect(createClient).not.toHaveBeenCalled();
    });

    it('the image pipeline writes to the bucket (S3), not to Supabase', async () => {
      const before = bucket.putKeys.length;
      await upload(noImage.id).expect(201);
      await uploadLogo().expect(201);
      expect(bucket.putKeys.length).toBe(before + 2);
      expect(createClient).not.toHaveBeenCalled();
    });
  });

  it('nothing in this flow ever deleted an object: the bucket only grew', () => {
    // Every key ever put is still stored.
    for (const key of bucket.putKeys) expect(bucket.objects.has(key)).toBe(true);
  });
});
