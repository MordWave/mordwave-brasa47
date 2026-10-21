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
import { ObjectStoreUnavailableError, S3ObjectStoreService } from '../src/media/s3-object-store.service.js';
import { DEFAULT_RATE_LIMITS, RATE_LIMIT_CONFIG } from '../src/rate-limit/rate-limit.config.js';
import { User } from '../src/user/user.entity.js';
import { UserRole } from '../src/user/user-role.enum.js';
import { runAllMigrations } from './support/run-all-migrations.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

const TEST_BCRYPT_COST = 4;
const BASE = 'https://api.example.test';
const PASSWORD = 'Sup3rSecret!K';
const minute = 60_000;
const huge = { limit: 100_000, ttlMs: minute };
const LIMITS = { ...DEFAULT_RATE_LIMITS, globalIp: huge, authenticatedUser: huge, policies: { ...DEFAULT_RATE_LIMITS.policies, upload: { user: huge } } };

// In-memory stand-in for the Railway Bucket. `duringPut` runs while an upload is "being processed": it is where another transaction
// commits its own change, i.e. exactly the window in which a row read BEFORE the upload used to be written back stale afterwards.
class FakeBucket {
  isConfigured = true;
  duringPut: (() => Promise<void>) | null = null;
  readonly putKeys: string[] = [];
  async put(key: string): Promise<void> {
    if (key.includes('FAIL')) throw new ObjectStoreUnavailableError('S3 PutObject failed');
    this.putKeys.push(key);
    const hook = this.duringPut;
    this.duringPut = null;
    if (hook) await hook();
  }
  async head() {
    return null;
  }
  async presignGet(key: string, ttl: number): Promise<string> {
    return `https://fake-bucket.example/${key}?X-Amz-Expires=${ttl}`;
  }
}

const png = () => sharp({ create: { width: 64, height: 64, channels: 3, background: '#cc3300' } }).png().toBuffer();

// 9E.12 — PATCH /businesses/me and POST /businesses/me/logo write ONLY their own columns and never restore a value another transaction
// committed in between (TypeORM save() of an entity read earlier used to). Local PGlite (a single session), so the concurrent writer is
// simulated at the one await where the old code was exposed: while the logo is being uploaded. The real-PostgreSQL 18 runs with
// independent connections, the SQL captured and the before/after comparison are described in the PR.
describe('Business writes never restore stale values (e2e, local Postgres, fake bucket)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  let dataSource: DataSource;
  const bucket = new FakeBucket();
  let bizA: Business;
  let bizB: Business;
  const tokens = { a: '', b: '', super: '' };

  const http = () => request(`http://127.0.0.1:${((app.getHttpServer() as { address: () => AddressInfo }).address()).port}`);
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const login = async (email: string) => (await http().post('/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;
  const patchMe = (token: string, body: Record<string, unknown>, query: Record<string, string> = {}) => http().patch('/businesses/me').query(query).set(as(token)).send(body);
  let logoPng: Buffer;
  const uploadLogo = (token: string, query: Record<string, string> = {}) =>
    http().post('/businesses/me/logo').query(query).set(as(token)).attach('file', logoPng, { filename: 'logo.png', contentType: 'image/png' });
  const row = async (id: string) =>
    (await dataSource.query(`SELECT name, slug, active, address, phone, hours, primary_color, accent_color, logo_storage_key, cover_storage_key FROM businesses WHERE id = $1`, [id]))[0] as Record<string, unknown>;
  const sql = (text: string, params: unknown[] = []) => dataSource.query(text, params);
  const COVER_KEY = (id: string) => `businesses/${id}/cover/11111111-1111-4111-8111-111111111111.webp`;
  const LOGO_OLD = (id: string) => `businesses/${id}/logo/22222222-2222-4222-8222-222222222222.webp`;
  const auditCount = async (id: string, action: string) => Number((await sql(`SELECT count(*)::int AS n FROM audit_logs WHERE business_id = $1 AND action = $2`, [id, action]))[0].n);
  // let the best-effort audit of the controller (fire-and-forget) land before counting
  const settle = () => new Promise((r) => setTimeout(r, 60));

  const resetA = async () => {
    await sql(
      `UPDATE businesses SET name='Stale A', address='Calle 1', phone='+56 1', hours='9-18', primary_color='#111111', accent_color='#222222', active=true, cover_storage_key=$2, logo_storage_key=$3 WHERE id=$1`,
      [bizA.id, COVER_KEY(bizA.id), LOGO_OLD(bizA.id)],
    );
    await sql(`DELETE FROM audit_logs WHERE business_id = $1`, [bizA.id]);
  };

  beforeAll(async () => {
    logoPng = await png();
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
    bizA = await businessRepo.save(businessRepo.create({ name: 'Stale A', slug: 'stale-a' }));
    bizB = await businessRepo.save(businessRepo.create({ name: 'Stale B', slug: 'stale-b', primaryColor: '#abcdef' }));
    await dataSource.query(`UPDATE businesses SET logo_storage_key = $2 WHERE id = $1`, [bizB.id, LOGO_OLD(bizB.id)]);
    const userRepo = dataSource.getRepository(User);
    const passwordHash = await bcrypt.hash(PASSWORD, TEST_BCRYPT_COST);
    await userRepo.save([
      userRepo.create({ email: 'a@stale.test', passwordHash, role: UserRole.ADMIN, businessId: bizA.id }),
      userRepo.create({ email: 'b@stale.test', passwordHash, role: UserRole.ADMIN, businessId: bizB.id }),
      userRepo.create({ email: 'super@stale.test', passwordHash, role: UserRole.SUPER_ADMIN, businessId: null }),
    ]);
    tokens.a = await login('a@stale.test');
    tokens.b = await login('b@stale.test');
    tokens.super = await login('super@stale.test');
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await testDb?.stop();
  });

  beforeEach(async () => {
    await resetA();
    bucket.duringPut = null;
  });

  // ---- PATCH ---------------------------------------------------------------------------------------------------------------
  it('PATCH writes only the columns it sends: cover, logo, active and every other field stay exactly as they are', async () => {
    const before = await row(bizA.id);
    const res = await patchMe(tokens.a, { primaryColor: '#abcdef' }).expect(200);
    const after = await row(bizA.id);
    expect(after).toEqual({ ...before, primary_color: '#abcdef' });
    expect(res.body).toMatchObject({ id: bizA.id, primaryColor: '#abcdef', accentColor: '#222222', name: 'Stale A', active: true });
    expect(Object.keys(res.body).sort()).toEqual(['accentColor', 'active', 'address', 'coverUrl', 'createdAt', 'hours', 'id', 'logoUrl', 'name', 'phone', 'primaryColor', 'slug', 'updatedAt']);
    expect(res.body.coverUrl).toBe(`${BASE}/media/${COVER_KEY(bizA.id)}`);
    expect(res.body.logoUrl).toBe(`${BASE}/media/${LOGO_OLD(bizA.id)}`);
  });

  it('null clears a column on purpose, undefined leaves it, and the response keeps its shape', async () => {
    const res = await patchMe(tokens.a, { primaryColor: null, accentColor: null }).expect(200);
    expect(res.body).toMatchObject({ primaryColor: null, accentColor: null, name: 'Stale A', phone: '+56 1' });
    expect(await row(bizA.id)).toMatchObject({ primary_color: null, accent_color: null, name: 'Stale A', logo_storage_key: LOGO_OLD(bizA.id) });
    await settle();
    expect(await auditCount(bizA.id, 'BUSINESS_UPDATED')).toBe(1);
  });

  it('PATCH cannot reach slug, active, ids or storage keys (still rejected by the DTO whitelist)', async () => {
    for (const body of [{ slug: 'x' }, { active: false }, { logoStorageKey: 'k' }, { coverStorageKey: 'k' }, { id: bizB.id }]) await patchMe(tokens.a, body).expect(400);
    expect(await row(bizA.id)).toMatchObject({ slug: 'stale-a', active: true, cover_storage_key: COVER_KEY(bizA.id) });
  });

  it('an ADMIN of a SUSPENDED business is refused (403 BUSINESS_INACTIVE) and nothing is written; a SUPER_ADMIN may edit it and it STAYS suspended', async () => {
    await sql(`UPDATE businesses SET active=false WHERE id=$1`, [bizA.id]);
    const refused = await patchMe(tokens.a, { name: 'Should not apply' }).expect(403);
    expect(refused.body.errorCode).toBe('BUSINESS_INACTIVE');
    expect(await row(bizA.id)).toMatchObject({ name: 'Stale A', active: false });

    const ok = await patchMe(tokens.super, { name: 'Renamed by super' }, { businessId: bizA.id }).expect(200);
    expect(ok.body).toMatchObject({ name: 'Renamed by super', active: false });
    expect(await row(bizA.id)).toMatchObject({ name: 'Renamed by super', active: false, cover_storage_key: COVER_KEY(bizA.id) });
  });

  it('an ADMIN cannot edit another business by passing its id, and other businesses are never touched', async () => {
    const bBefore = await row(bizB.id);
    await patchMe(tokens.a, { name: 'Hijack' }, { businessId: bizB.id }).expect(200); // ignored for an ADMIN: their own business is edited
    expect(await row(bizB.id)).toEqual(bBefore);
    expect(await row(bizA.id)).toMatchObject({ name: 'Hijack' });
  });

  it('a SUPER_ADMIN must name the business; an unknown id is a 404 and nothing is written', async () => {
    await patchMe(tokens.super, { name: 'x' }).expect(400);
    await patchMe(tokens.super, { name: 'x' }, { businessId: '99999999-9999-4999-8999-999999999999' }).expect(404);
  });

  // ---- logo upload: the old window was the whole upload -------------------------------------------------------------------
  it('a logo upload writes ONLY the logo: cover, colours, name, address... committed by someone else during the upload survive', async () => {
    bucket.duringPut = async () => {
      await sql(`UPDATE businesses SET cover_storage_key=NULL, primary_color='#00ff00', accent_color='#ff00ff', name='Renamed meanwhile', address='New street 9', phone='+56 99' WHERE id=$1`, [bizA.id]);
    };
    const res = await uploadLogo(tokens.a).expect(201);
    const after = await row(bizA.id);
    expect(after).toMatchObject({ cover_storage_key: null, primary_color: '#00ff00', accent_color: '#ff00ff', name: 'Renamed meanwhile', address: 'New street 9', phone: '+56 99', active: true });
    expect(after.logo_storage_key).toMatch(new RegExp(`^businesses/${bizA.id}/logo/[0-9a-f-]{36}\\.webp$`));
    expect(after.logo_storage_key).not.toBe(LOGO_OLD(bizA.id));
    // the answer is the row as it is AFTER the write, not the copy read before the upload
    expect(res.body).toMatchObject({ name: 'Renamed meanwhile', primaryColor: '#00ff00', coverUrl: null });
    expect(res.body.logoUrl).toBe(`${BASE}/media/${String(after.logo_storage_key)}`);
    await settle();
    expect(await auditCount(bizA.id, 'BUSINESS_LOGO_UPDATED')).toBe(1);
  });

  it('a cover REMOVED during the logo upload does not come back; a cover UPLOADED during it is not lost', async () => {
    bucket.duringPut = async () => void (await sql(`UPDATE businesses SET cover_storage_key=NULL WHERE id=$1`, [bizA.id]));
    await uploadLogo(tokens.a).expect(201);
    expect((await row(bizA.id)).cover_storage_key).toBeNull();

    const fresh = COVER_KEY(bizA.id).replace('11111111', '33333333');
    bucket.duringPut = async () => void (await sql(`UPDATE businesses SET cover_storage_key=$2 WHERE id=$1`, [bizA.id, fresh]));
    await uploadLogo(tokens.a).expect(201);
    expect((await row(bizA.id)).cover_storage_key).toBe(fresh);
  });

  it('a business SUSPENDED while its ADMIN\'s logo is being processed: 403, it stays suspended, the logo is not changed and nothing is audited as done', async () => {
    bucket.duringPut = async () => void (await sql(`UPDATE businesses SET active=false WHERE id=$1`, [bizA.id]));
    const res = await uploadLogo(tokens.a).expect(403);
    expect(res.body.errorCode).toBe('BUSINESS_INACTIVE');
    expect(await row(bizA.id)).toMatchObject({ active: false, logo_storage_key: LOGO_OLD(bizA.id), cover_storage_key: COVER_KEY(bizA.id), name: 'Stale A' });
    await settle();
    expect(await auditCount(bizA.id, 'BUSINESS_LOGO_UPDATED')).toBe(0);
  });

  it('a logo upload never reactivates a suspended business, and a SUPER_ADMIN may upload one for it', async () => {
    await sql(`UPDATE businesses SET active=false WHERE id=$1`, [bizA.id]);
    await uploadLogo(tokens.a).expect(403); // refused before the image is even processed
    const putsBefore = bucket.putKeys.length;
    await uploadLogo(tokens.super, { businessId: bizA.id }).expect(201);
    expect(bucket.putKeys.length).toBe(putsBefore + 1);
    const after = await row(bizA.id);
    expect(after.active).toBe(false);
    expect(after.logo_storage_key).not.toBe(LOGO_OLD(bizA.id));
  });

  it('an ADMIN\'s upload is refused BEFORE processing when the business is already suspended (nothing reaches the bucket)', async () => {
    await sql(`UPDATE businesses SET active=false WHERE id=$1`, [bizA.id]);
    const before = bucket.putKeys.length;
    await uploadLogo(tokens.a).expect(403);
    expect(bucket.putKeys.length).toBe(before);
  });

  it('a storage failure changes nothing and writes no audit entry', async () => {
    const before = await row(bizA.id);
    // the fake bucket fails for keys containing FAIL; force it through a hook that makes the very next put throw
    bucket.duringPut = async () => {
      throw new ObjectStoreUnavailableError('S3 PutObject failed');
    };
    const res = await uploadLogo(tokens.a);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await row(bizA.id)).toEqual(before);
    await settle();
    expect(await auditCount(bizA.id, 'BUSINESS_LOGO_UPDATED')).toBe(0);
  });

  it('the logo of ANOTHER business is never touched by these writes', async () => {
    const before = await row(bizB.id);
    await uploadLogo(tokens.a).expect(201);
    await patchMe(tokens.a, { phone: '+56 5' }).expect(200);
    expect(await row(bizB.id)).toEqual(before);
  });

  it('the cover API (PR #59) keeps working next to these writes: cover upload, then a PATCH and a logo upload leave it in place', async () => {
    const png2 = logoPng;
    const up = await http().post('/businesses/me/cover').set(as(tokens.a)).attach('file', png2, { filename: 'cover.png', contentType: 'image/png' }).expect(201);
    const key = (await row(bizA.id)).cover_storage_key as string;
    expect(up.body.coverUrl).toBe(`${BASE}/media/${key}`);
    await patchMe(tokens.a, { accentColor: '#123456' }).expect(200);
    await uploadLogo(tokens.a).expect(201);
    expect((await row(bizA.id)).cover_storage_key).toBe(key);
    await http().delete('/businesses/me/cover').set(as(tokens.a)).expect(200);
    await patchMe(tokens.a, { accentColor: '#654321' }).expect(200);
    expect((await row(bizA.id)).cover_storage_key).toBeNull(); // a removed cover does not come back
  });
});
