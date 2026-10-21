import type { AddressInfo } from 'node:net';
import bcrypt from 'bcrypt';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import sharp from 'sharp';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { Business } from '../src/business/business.entity.js';
import { isBusinessCoverKey } from '../src/media/media-key.util.js';
import { ObjectStoreUnavailableError, S3ObjectStoreService } from '../src/media/s3-object-store.service.js';
import { DEFAULT_RATE_LIMITS, RATE_LIMIT_CONFIG } from '../src/rate-limit/rate-limit.config.js';
import { RestaurantTable } from '../src/table/table.entity.js';
import { TableSession } from '../src/table/table-session.entity.js';
import { TableSessionStatus } from '../src/table/table-session-status.enum.js';
import { User } from '../src/user/user.entity.js';
import { UserRole } from '../src/user/user-role.enum.js';
import { runAllMigrations } from './support/run-all-migrations.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

const TEST_BCRYPT_COST = 4;
const BASE = 'https://api.example.test';
const PASSWORD = 'Sup3rSecret!K';
const minute = 60_000;
const huge = { limit: 100_000, ttlMs: minute };
// Many requests from one IP / one user in a few seconds: the production ceilings are tested in rate-limit.e2e-spec.ts.
const LIMITS = { ...DEFAULT_RATE_LIMITS, globalIp: huge, authenticatedUser: huge, policies: { ...DEFAULT_RATE_LIMITS.policies, upload: { user: huge } } };

// In-memory stand-in for the Railway Bucket (records every call; it has no delete at all, like the real service).
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

const png = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: '#cc3300' } }).png().toBuffer();

// 9E.7 — the write API of the welcome-screen cover (POST/DELETE /businesses/me/cover) and logo removal (DELETE /businesses/me/logo):
// the REAL upload pipeline (file-type -> sharp -> WebP), controllers, services, audit and database, with only the bucket faked.
// Ephemeral local PGlite with fictitious data: never the Railway Bucket, never production.
describe('Business cover write API (e2e, real local Postgres, fake bucket)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  let dataSource: DataSource;
  const bucket = new FakeBucket();

  let bizA: Business;
  let bizB: Business;
  let bizC: Business; // suspended later
  const tokens = { a: '', b: '', c: '', super: '' };
  const QR = 'qr-cover-api-a';

  const http = () => request(`http://127.0.0.1:${((app.getHttpServer() as { address: () => AddressInfo }).address()).port}`);
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const login = async (email: string) => (await http().post('/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;

  const uploadCover = (token: string, buffer: Buffer, query: Record<string, string> = {}, fields: Record<string, string> = {}, name = 'cover.png', type = 'image/png') => {
    let req = http().post('/businesses/me/cover').query(query).set(as(token));
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    return req.attach('file', buffer, { filename: name, contentType: type });
  };
  const uploadLogo = (token: string, buffer: Buffer) => http().post('/businesses/me/logo').set(as(token)).attach('file', buffer, { filename: 'logo.png', contentType: 'image/png' });
  const removeCover = (token: string, query: Record<string, string> = {}) => http().delete('/businesses/me/cover').query(query).set(as(token));
  const removeLogo = (token: string, query: Record<string, string> = {}) => http().delete('/businesses/me/logo').query(query).set(as(token));

  const keys = async (id: string) => (await dataSource.query(`SELECT cover_storage_key, logo_storage_key FROM businesses WHERE id = $1`, [id]))[0] as { cover_storage_key: string | null; logo_storage_key: string | null };
  const audit = (action: string, businessId: string) =>
    dataSource.query(`SELECT user_id, user_email, business_id, entity_type, entity_id, metadata, ip_address FROM audit_logs WHERE business_id = $1 AND action = $2 ORDER BY created_at, id`, [businessId, action]) as Promise<
      Array<{ user_id: string; user_email: string; business_id: string; entity_type: string; entity_id: string; metadata: Record<string, unknown>; ip_address: string | null }>
    >;
  const auditCount = async (businessId: string) => Number((await dataSource.query(`SELECT count(*)::int AS n FROM audit_logs WHERE business_id = $1 AND action IN ('BUSINESS_COVER_UPDATED','BUSINESS_COVER_REMOVED','BUSINESS_LOGO_REMOVED')`, [businessId]))[0].n);
  const dims = async (key: string) => {
    const meta = await sharp(bucket.objects.get(key)!.body).metadata();
    return { format: meta.format, width: meta.width, height: meta.height };
  };
  // A raw key may only ever appear inside a /media URL; the field names never.
  const noLeak = (body: unknown) => {
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/storage_?key/i);
    expect(text.replace(new RegExp(`${BASE}/media/businesses/[a-z0-9/-]+\\.webp`, 'g'), '')).not.toMatch(/businesses\/[0-9a-f-]{36}\//);
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

    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(S3ObjectStoreService)
      .useValue(bucket)
      .overrideProvider(RATE_LIMIT_CONFIG)
      .useValue(LIMITS)
      .compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    dataSource = moduleFixture.get(DataSource);
    await runAllMigrations(dataSource);

    const businessRepo = dataSource.getRepository(Business);
    bizA = await businessRepo.save(businessRepo.create({ name: 'Cover API A', slug: 'cover-api-a' }));
    bizB = await businessRepo.save(businessRepo.create({ name: 'Cover API B', slug: 'cover-api-b' }));
    bizC = await businessRepo.save(businessRepo.create({ name: 'Cover API C', slug: 'cover-api-c' }));

    const userRepo = dataSource.getRepository(User);
    const passwordHash = await bcrypt.hash(PASSWORD, TEST_BCRYPT_COST);
    await userRepo.save([
      userRepo.create({ email: 'a@cover-api.test', passwordHash, role: UserRole.ADMIN, businessId: bizA.id }),
      userRepo.create({ email: 'b@cover-api.test', passwordHash, role: UserRole.ADMIN, businessId: bizB.id }),
      userRepo.create({ email: 'c@cover-api.test', passwordHash, role: UserRole.ADMIN, businessId: bizC.id }),
      userRepo.create({ email: 'super@cover-api.test', passwordHash, role: UserRole.SUPER_ADMIN, businessId: null }),
    ]);
    tokens.a = await login('a@cover-api.test');
    tokens.b = await login('b@cover-api.test');
    tokens.c = await login('c@cover-api.test'); // issued while C is still active
    tokens.super = await login('super@cover-api.test');

    const tableRepo = dataSource.getRepository(RestaurantTable);
    const table = await tableRepo.save(tableRepo.create({ businessId: bizA.id, name: 'Mesa 1', qrToken: QR }));
    const sessionRepo = dataSource.getRepository(TableSession);
    await sessionRepo.save(sessionRepo.create({ tableId: table.id, businessId: bizA.id, sessionToken: 'session-cover-api', status: TableSessionStatus.OPEN }));
  }, 90_000);

  afterAll(async () => {
    delete process.env.MEDIA_PUBLIC_BASE_URL;
    await app?.close();
    await testDb?.stop();
  });

  beforeEach(() => {
    bucket.failPut = false;
  });

  describe('compatibility: a business with no cover', () => {
    it('GET /businesses/me and the QR join answer coverUrl null, and removing a cover that is not there is a harmless 200 with no audit entry', async () => {
      expect((await http().get('/businesses/me').set(as(tokens.a)).expect(200)).body.coverUrl).toBeNull();
      expect((await http().post('/table-sessions/join').send({ qrToken: QR }).expect(200)).body.coverUrl).toBeNull();
      const res = await removeCover(tokens.a).expect(200);
      expect(res.body.coverUrl).toBeNull();
      expect(await auditCount(bizA.id)).toBe(0);
      expect(await removeLogo(tokens.a).expect(200)).toBeTruthy();
      expect(await auditCount(bizA.id)).toBe(0);
    });
  });

  describe('POST /businesses/me/cover — upload and replace', () => {
    it('stores a processed WebP under businesses/<ownId>/cover/<uuid>.webp, answers with the /media URL and no key, and audits it', async () => {
      const puts = bucket.putKeys.length;
      const res = await uploadCover(tokens.a, await png(3000, 2000), { }, {}).expect(201);

      const { cover_storage_key: key } = await keys(bizA.id);
      expect(key).toMatch(new RegExp(`^businesses/${bizA.id}/cover/[0-9a-f-]{36}\\.webp$`));
      expect(isBusinessCoverKey(key)).toBe(true);
      expect(res.body.coverUrl).toBe(`${BASE}/media/${key}`);
      expect(res.body).not.toHaveProperty('coverStorageKey');
      expect(Object.keys(res.body).sort()).toEqual(['accentColor', 'active', 'address', 'coverUrl', 'createdAt', 'hours', 'id', 'logoUrl', 'name', 'phone', 'primaryColor', 'slug', 'updatedAt']);
      expect(res.body.id).toBe(bizA.id);
      noLeak(res.body);
      expect(bucket.putKeys.length).toBe(puts + 1);
      const object = bucket.objects.get(key!)!;
      expect(object.contentType).toBe('image/webp');
      expect(object.cacheControl).toBe('public, max-age=31536000, immutable');

      const rows = await audit('BUSINESS_COVER_UPDATED', bizA.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ entity_type: 'Business', entity_id: bizA.id, user_email: 'a@cover-api.test', metadata: { replaced: false } });
      expect(typeof rows[0]!.metadata.sizeBytes).toBe('number');
      expect(rows[0]!.ip_address).toBeTruthy();
      expect(JSON.stringify(rows[0]!.metadata)).not.toMatch(/businesses\/|storage|\.webp|cover\.png/);
    });

    it('caps the longest side at 1920 px (cover), never enlarges, and does NOT depend on the aspect ratio', async () => {
      const big = (await uploadCover(tokens.a, await png(3000, 2000)).expect(201)).body.coverUrl as string;
      expect(await dims(big.replace(`${BASE}/media/`, ''))).toEqual({ format: 'webp', width: 1920, height: 1280 });

      const small = (await uploadCover(tokens.a, await png(600, 400)).expect(201)).body.coverUrl as string;
      expect(await dims(small.replace(`${BASE}/media/`, ''))).toEqual({ format: 'webp', width: 600, height: 400 });

      const tall = (await uploadCover(tokens.a, await png(1000, 4000)).expect(201)).body.coverUrl as string;
      expect(await dims(tall.replace(`${BASE}/media/`, ''))).toEqual({ format: 'webp', width: 480, height: 1920 });

      const pano = (await uploadCover(tokens.a, await png(4000, 500)).expect(201)).body.coverUrl as string;
      expect(await dims(pano.replace(`${BASE}/media/`, ''))).toEqual({ format: 'webp', width: 1920, height: 240 });
    });

    it('logos keep their 1200 px limit and product behaviour is untouched', async () => {
      const res = await uploadLogo(tokens.a, await png(3000, 2000)).expect(201);
      const logoKey = (await keys(bizA.id)).logo_storage_key!;
      expect(res.body.logoUrl).toBe(`${BASE}/media/${logoKey}`);
      expect(await dims(logoKey)).toEqual({ format: 'webp', width: 1200, height: 800 });
    });

    it('replacing generates a NEW key, keeps the previous object (nothing is deleted), and audits replaced: true', async () => {
      const before = (await keys(bizA.id)).cover_storage_key!;
      const objects = bucket.objects.size;
      const updates = (await audit('BUSINESS_COVER_UPDATED', bizA.id)).length;

      const res = await uploadCover(tokens.a, await png(1500, 1000)).expect(201);

      const after = (await keys(bizA.id)).cover_storage_key!;
      expect(after).not.toBe(before);
      expect(res.body.coverUrl).toBe(`${BASE}/media/${after}`);
      expect(bucket.objects.size).toBe(objects + 1);
      expect(bucket.objects.has(before)).toBe(true);
      const rows = await audit('BUSINESS_COVER_UPDATED', bizA.id);
      expect(rows).toHaveLength(updates + 1);
      expect(rows[rows.length - 1]!.metadata.replaced).toBe(true);
    });

    it('is visible to GET /businesses/me and the customer QR join, with no storage key anywhere', async () => {
      const key = (await keys(bizA.id)).cover_storage_key!;
      const me = await http().get('/businesses/me').set(as(tokens.a)).expect(200);
      const join = await http().post('/table-sessions/join').send({ qrToken: QR }).expect(200);
      expect(me.body.coverUrl).toBe(`${BASE}/media/${key}`);
      expect(join.body.coverUrl).toBe(`${BASE}/media/${key}`);
      noLeak(me.body);
      noLeak(join.body);
    });
  });

  describe('image validation (nothing is stored, written or audited when it fails)', () => {
    const state = async () => ({ puts: bucket.putKeys.length, keys: await keys(bizA.id), audits: (await audit('BUSINESS_COVER_UPDATED', bizA.id)).length });

    it.each([
      ['a text file', Buffer.from('this is not an image'), 'IMAGE_INVALID_FORMAT'],
      ['a PDF renamed to .png', Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200, 0x20), Buffer.from('\n%%EOF')]), 'IMAGE_INVALID_FORMAT'],
    ])('%s -> 400 %s', async (_label, buffer, errorCode) => {
      const before = await state();
      const res = await uploadCover(tokens.a, buffer).expect(400);
      expect(res.body.errorCode).toBe(errorCode);
      expect(await state()).toEqual(before);
    });

    it('a corrupt image (valid PNG signature, truncated) -> 400 IMAGE_PROCESSING_FAILED, no internal error text', async () => {
      const full = await png(400, 400);
      const before = await state();
      const res = await uploadCover(tokens.a, full.subarray(0, Math.floor(full.length * 0.6))).expect(400);
      expect(res.body.errorCode).toBe('IMAGE_PROCESSING_FAILED');
      expect(JSON.stringify(res.body)).not.toMatch(/vips|sharp|libheif/i);
      expect(await state()).toEqual(before);
    });

    it('over 10 MB -> 400 IMAGE_TOO_LARGE, before any processing', async () => {
      const before = await state();
      const res = await uploadCover(tokens.a, Buffer.concat([await png(10, 10), Buffer.alloc(10 * 1024 * 1024 + 1)])).expect(400);
      expect(res.body.errorCode).toBe('IMAGE_TOO_LARGE');
      expect(await state()).toEqual(before);
    });

    it('over the 20 MB transport ceiling (multer) -> rejected before reaching the service, nothing stored', async () => {
      const before = await state();
      const res = await uploadCover(tokens.a, Buffer.concat([await png(10, 10), Buffer.alloc(21 * 1024 * 1024)]));
      expect([400, 413]).toContain(res.status);
      expect(await state()).toEqual(before);
    }, 60_000);

    it('more than 50 megapixels -> 400 IMAGE_PROCESSING_FAILED (decompression-bomb guard)', async () => {
      const before = await state();
      const res = await uploadCover(tokens.a, await png(8000, 8000)).expect(400);
      expect(res.body.errorCode).toBe('IMAGE_PROCESSING_FAILED');
      expect(await state()).toEqual(before);
    }, 60_000);

    it('no file at all -> 400 IMAGE_INVALID_FORMAT', async () => {
      const before = await state();
      const res = await http().post('/businesses/me/cover').set(as(tokens.a)).field('note', 'no file here').expect(400);
      expect(res.body.errorCode).toBe('IMAGE_INVALID_FORMAT');
      expect(await state()).toEqual(before);
    });

    it('a bucket failure answers 502 and leaves the business exactly as it was (no row change, no audit)', async () => {
      const before = await state();
      bucket.failPut = true;
      const res = await uploadCover(tokens.a, await png(800, 600)).expect(502);
      expect(res.body.errorCode).toBe('IMAGE_UPLOAD_FAILED');
      expect(JSON.stringify(res.body)).not.toMatch(/PutObject|S3/);
      expect(await state()).toEqual(before);
    });
  });

  describe('DELETE /businesses/me/cover and /logo', () => {
    it('removing the cover writes NULL, keeps the object in the bucket, audits it, and the cover disappears from /me and the QR join', async () => {
      const key = (await keys(bizA.id)).cover_storage_key!;
      const logo = (await keys(bizA.id)).logo_storage_key;
      const res = await removeCover(tokens.a).expect(200);
      expect(res.body.coverUrl).toBeNull();
      expect(res.body.logoUrl).toBe(`${BASE}/media/${logo}`); // the logo is untouched
      expect(await keys(bizA.id)).toEqual({ cover_storage_key: null, logo_storage_key: logo });
      expect(bucket.objects.has(key)).toBe(true);
      const rows = await audit('BUSINESS_COVER_REMOVED', bizA.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ entity_type: 'Business', entity_id: bizA.id, user_email: 'a@cover-api.test', metadata: {} });
      expect((await http().get('/businesses/me').set(as(tokens.a)).expect(200)).body.coverUrl).toBeNull();
      expect((await http().post('/table-sessions/join').send({ qrToken: QR }).expect(200)).body.coverUrl).toBeNull();
    });

    it('removing it again is an idempotent 200 with no second audit entry', async () => {
      await removeCover(tokens.a).expect(200);
      expect(await audit('BUSINESS_COVER_REMOVED', bizA.id)).toHaveLength(1);
    });

    it('a cover can be uploaded again after removal', async () => {
      const res = await uploadCover(tokens.a, await png(900, 900)).expect(201);
      expect(res.body.coverUrl).toMatch(new RegExp(`^${BASE}/media/businesses/${bizA.id}/cover/`));
    });

    it('removing the logo writes NULL (cover untouched), keeps the object, and audits BUSINESS_LOGO_REMOVED; again is a no-op', async () => {
      const before = await keys(bizA.id);
      expect(before.logo_storage_key).toBeTruthy();
      const res = await removeLogo(tokens.a).expect(200);
      expect(res.body.logoUrl).toBeNull();
      expect(res.body.coverUrl).toBe(`${BASE}/media/${before.cover_storage_key}`);
      expect(await keys(bizA.id)).toEqual({ cover_storage_key: before.cover_storage_key, logo_storage_key: null });
      expect(bucket.objects.has(before.logo_storage_key!)).toBe(true);
      expect(await audit('BUSINESS_LOGO_REMOVED', bizA.id)).toHaveLength(1);
      await removeLogo(tokens.a).expect(200);
      expect(await audit('BUSINESS_LOGO_REMOVED', bizA.id)).toHaveLength(1);
      expect((await http().post('/table-sessions/join').send({ qrToken: QR }).expect(200)).body.logoUrl).toBeNull();
    });

    it('the existing logo upload keeps working exactly as before', async () => {
      const res = await uploadLogo(tokens.a, await png(500, 500)).expect(201);
      expect(res.body.logoUrl).toMatch(new RegExp(`^${BASE}/media/businesses/${bizA.id}/logo/`));
    });
  });

  describe('who can do it, and on which business', () => {
    const endpoints = [
      ['POST cover', (t?: string) => (t ? uploadCover(t, Buffer.from('x')) : http().post('/businesses/me/cover'))],
      ['DELETE cover', (t?: string) => (t ? removeCover(t) : http().delete('/businesses/me/cover'))],
      ['DELETE logo', (t?: string) => (t ? removeLogo(t) : http().delete('/businesses/me/logo'))],
    ] as const;

    it.each(endpoints)('%s without a token -> 401 and nothing happens', async (_label, call) => {
      const puts = bucket.putKeys.length;
      await call().expect(401);
      expect(bucket.putKeys.length).toBe(puts);
    });

    it.each(endpoints)('%s with a garbage token -> 401', async (_label, call) => {
      await call('not-a-jwt').expect(401);
    });

    it("an ADMIN always acts on THEIR OWN business: ?businessId= of another business is ignored (the other business is untouched)", async () => {
      const bBefore = await keys(bizB.id);
      const res = await uploadCover(tokens.a, await png(700, 500), { businessId: bizB.id }).expect(201);
      expect(res.body.id).toBe(bizA.id);
      expect(res.body.coverUrl).toMatch(new RegExp(`/media/businesses/${bizA.id}/cover/`));
      expect(await keys(bizB.id)).toEqual(bBefore);
      expect(await auditCount(bizB.id)).toBe(0);
      await removeLogo(tokens.b, { businessId: bizA.id }).expect(200); // acts on B (own), not on A
      expect(await keys(bizA.id)).toMatchObject({ cover_storage_key: expect.any(String) });
    });

    it("B's admin never touches A's images and A's admin never touches B's", async () => {
      const a = await keys(bizA.id);
      await uploadCover(tokens.b, await png(640, 480)).expect(201);
      await removeCover(tokens.b).expect(200);
      expect(await keys(bizA.id)).toEqual(a);
      expect((await keys(bizB.id)).cover_storage_key).toBeNull();
      expect((await audit('BUSINESS_COVER_UPDATED', bizB.id))[0]!.user_email).toBe('b@cover-api.test');
    });

    it('the storage key can NEVER be supplied by the client: a form field or a query parameter naming one is ignored / rejected', async () => {
      const foreign = `businesses/${bizB.id}/cover/00000000-0000-4000-8000-000000000000.webp`;
      const res = await uploadCover(tokens.a, await png(640, 480), {}, { coverStorageKey: foreign, storageKey: foreign, businessId: bizB.id }).expect(201);
      const { cover_storage_key: key } = await keys(bizA.id);
      expect(key).not.toBe(foreign);
      expect(key).toMatch(new RegExp(`^businesses/${bizA.id}/cover/(?!00000000)[0-9a-f-]{36}\\.webp$`));
      expect(res.body.coverUrl).toBe(`${BASE}/media/${key}`);
      expect((await keys(bizB.id)).cover_storage_key).toBeNull();
      // query parameters outside the whitelist are refused outright
      await http().post('/businesses/me/cover').query({ coverStorageKey: foreign }).set(as(tokens.a)).attach('file', await png(100, 100), 'c.png').expect(400);
      await http().delete('/businesses/me/cover').query({ coverStorageKey: foreign }).set(as(tokens.a)).expect(400);
      await http().delete('/businesses/me/logo').query({ logoStorageKey: foreign }).set(as(tokens.a)).expect(400);
      expect((await keys(bizA.id)).cover_storage_key).toBe(key);
    });

    it('SUPER_ADMIN must name the business: 400 without ?businessId=, nothing processed or written', async () => {
      const puts = bucket.putKeys.length;
      const audits = (await dataSource.query(`SELECT count(*)::int AS n FROM audit_logs`))[0].n;
      await uploadCover(tokens.super, await png(300, 300)).expect(400);
      await removeCover(tokens.super).expect(400);
      await removeLogo(tokens.super).expect(400);
      await uploadCover(tokens.super, await png(300, 300), { businessId: 'not-a-uuid' }).expect(400);
      expect(bucket.putKeys.length).toBe(puts);
      expect((await dataSource.query(`SELECT count(*)::int AS n FROM audit_logs`))[0].n).toBe(audits);
    });

    it('SUPER_ADMIN with ?businessId= acts on exactly that business and the audit entry names the real actor and that business', async () => {
      const aBefore = await keys(bizA.id);
      const res = await uploadCover(tokens.super, await png(1000, 700), { businessId: bizB.id }).expect(201);
      expect(res.body.id).toBe(bizB.id);
      expect(res.body.coverUrl).toMatch(new RegExp(`/media/businesses/${bizB.id}/cover/`));
      expect(await keys(bizA.id)).toEqual(aBefore);
      const rows = await audit('BUSINESS_COVER_UPDATED', bizB.id);
      expect(rows[rows.length - 1]).toMatchObject({ user_email: 'super@cover-api.test', business_id: bizB.id, entity_id: bizB.id });
      await removeCover(tokens.super, { businessId: bizB.id }).expect(200);
      expect((await keys(bizB.id)).cover_storage_key).toBeNull();
    });

    it('SUPER_ADMIN with an unknown business -> 404 BEFORE any image is processed or stored', async () => {
      const puts = bucket.putKeys.length;
      await uploadCover(tokens.super, await png(300, 300), { businessId: '99999999-9999-4999-8999-999999999999' }).expect(404);
      await removeCover(tokens.super, { businessId: '99999999-9999-4999-8999-999999999999' }).expect(404);
      expect(bucket.putKeys.length).toBe(puts);
    });
  });

  describe('suspended business', () => {
    beforeAll(async () => {
      await dataSource.query(`UPDATE businesses SET active = false WHERE id = $1`, [bizC.id]);
    });

    it.each([
      ['POST cover', () => uploadCover(tokens.c, Buffer.from('not even an image'))],
      ['DELETE cover', () => removeCover(tokens.c)],
      ['DELETE logo', () => removeLogo(tokens.c)],
    ])("an ADMIN of a suspended business is refused (403 BUSINESS_INACTIVE): %s — nothing is processed, written or audited", async (_label, call) => {
      const puts = bucket.putKeys.length;
      const before = await keys(bizC.id);
      const res = await call().expect(403);
      expect(res.body.errorCode).toBe('BUSINESS_INACTIVE');
      expect(bucket.putKeys.length).toBe(puts);
      expect(await keys(bizC.id)).toEqual(before);
      expect(await auditCount(bizC.id)).toBe(0);
    });

    it('a SUPER_ADMIN can still manage the identity of a suspended business (as they can already edit it), audited', async () => {
      const res = await uploadCover(tokens.super, await png(800, 600), { businessId: bizC.id }).expect(201);
      expect(res.body).toMatchObject({ id: bizC.id, active: false });
      expect(res.body.coverUrl).toMatch(new RegExp(`/media/businesses/${bizC.id}/cover/`));
      await removeCover(tokens.super, { businessId: bizC.id }).expect(200);
      expect(await audit('BUSINESS_COVER_UPDATED', bizC.id)).toHaveLength(1);
      expect(await audit('BUSINESS_COVER_REMOVED', bizC.id)).toHaveLength(1);
    });
  });

  describe('audit and rollback on failure (a real failing trigger in the audit table)', () => {
    const arm = async (action: string) => {
      await dataSource.query(`CREATE OR REPLACE FUNCTION zz_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced failure'; END $$`);
      await dataSource.query(`CREATE TRIGGER zz_fail_audit_t BEFORE INSERT ON audit_logs FOR EACH ROW WHEN (NEW.action = '${action}') EXECUTE FUNCTION zz_fail_audit()`);
    };
    // The e2e harness (PGlite behind a single shared connection) can answer queries with STALE results after a server-side error (see the
    // note in media-storage-keys.e2e-spec.ts). That is a harness artefact, not application behaviour. Resynchronise by sending a query with a
    // unique tag until the answer carries THAT tag: only then is the stream known to be in step and every later assertion reads real data.
    const resync = async () => {
      for (let i = 0; i < 30; i++) {
        const tag = `sync-${Date.now()}-${i}`;
        const rows = await dataSource.query(`SELECT '${tag}' AS tag`).catch(() => undefined);
        if (rows?.[0]?.tag === tag) return;
      }
      throw new Error('the test database connection did not resynchronise');
    };
    const disarm = async () => {
      await resync();
      await dataSource.query(`DROP TRIGGER IF EXISTS zz_fail_audit_t ON audit_logs`).catch(() => undefined);
      await resync();
      const left = (await dataSource.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'zz_fail_audit_t'`))[0].n;
      if (left !== 0) await dataSource.query(`DROP TRIGGER IF EXISTS zz_fail_audit_t ON audit_logs`);
      await resync();
    };

    it('if the audit insert fails on an UPLOAD the whole change rolls back, the client gets an error (no success), and the new object is an orphan the bucket keeps', async () => {
      const before = await keys(bizB.id);
      const auditBefore = (await audit('BUSINESS_COVER_UPDATED', bizB.id)).length;
      const objects = bucket.objects.size;
      await arm('BUSINESS_COVER_UPDATED');
      try {
        const res = await uploadCover(tokens.b, await png(500, 400));
        expect(res.status).toBe(500);
        expect(JSON.stringify(res.body)).not.toMatch(/forced failure|businesses\/|storage|zz_fail/i);
      } finally {
        await disarm();
      }
      expect(await keys(bizB.id)).toEqual(before); // row unchanged
      expect((await audit('BUSINESS_COVER_UPDATED', bizB.id)).length).toBe(auditBefore); // no entry
      expect(bucket.objects.size).toBe(objects + 1); // the uploaded object stays (orphan: nothing references it)
      const orphan = bucket.putKeys[bucket.putKeys.length - 1]!;
      expect(orphan).toMatch(new RegExp(`^businesses/${bizB.id}/cover/`));
      const referenced = (await dataSource.query(`SELECT count(*)::int AS n FROM businesses WHERE cover_storage_key = $1 OR logo_storage_key = $1`, [orphan]))[0].n;
      expect(referenced).toBe(0);
      // and the API is healthy afterwards: the same upload succeeds once the fault is gone
      await uploadCover(tokens.b, await png(500, 400)).expect(201);
    });

    it('if the audit insert fails on a REMOVAL the cover is NOT removed and no success is announced', async () => {
      const key = (await keys(bizB.id)).cover_storage_key!;
      expect(key).toBeTruthy();
      const removed = (await audit('BUSINESS_COVER_REMOVED', bizB.id)).length;
      await arm('BUSINESS_COVER_REMOVED');
      try {
        expect((await removeCover(tokens.b)).status).toBe(500);
      } finally {
        await disarm();
      }
      expect((await keys(bizB.id)).cover_storage_key).toBe(key);
      expect((await audit('BUSINESS_COVER_REMOVED', bizB.id)).length).toBe(removed);
      await removeCover(tokens.b).expect(200);
      expect((await keys(bizB.id)).cover_storage_key).toBeNull();
    });

    it('same for the logo removal', async () => {
      await uploadLogo(tokens.b, await png(300, 300)).expect(201);
      const key = (await keys(bizB.id)).logo_storage_key!;
      await arm('BUSINESS_LOGO_REMOVED');
      try {
        expect((await removeLogo(tokens.b)).status).toBe(500);
      } finally {
        await disarm();
      }
      expect((await keys(bizB.id)).logo_storage_key).toBe(key);
      await removeLogo(tokens.b).expect(200);
    });
  });

  it('nothing in this suite ever deleted an object: every key ever put is still in the bucket', () => {
    for (const key of bucket.putKeys) expect(bucket.objects.has(key)).toBe(true);
  });
});
