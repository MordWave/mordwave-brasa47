import type { AddressInfo } from 'node:net';
import bcrypt from 'bcrypt';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import sharp from 'sharp';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { Business } from '../src/business/business.entity.js';
import { Category } from '../src/category/category.entity.js';
import { Product } from '../src/product/product.entity.js';
import { S3ObjectStoreService } from '../src/media/s3-object-store.service.js';
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

// In-memory stand-in for the bucket (it has no delete at all, like the real service). `duringPut` runs while the upload is in flight —
// exactly the window in which another admin edits or deletes the product.
class FakeBucket {
  isConfigured = true;
  duringPut: (() => Promise<void>) | null = null;
  readonly objects = new Map<string, Buffer>();
  readonly putKeys: string[] = [];
  async put(key: string, body: Buffer): Promise<void> {
    if (this.duringPut) {
      const hook = this.duringPut;
      this.duringPut = null;
      await hook();
    }
    this.putKeys.push(key);
    this.objects.set(key, body);
  }
  async head(key: string) {
    const o = this.objects.get(key);
    return o ? { contentLength: o.length, contentType: 'image/webp' } : null;
  }
  async presignGet(key: string): Promise<string> {
    return `https://fake-bucket.example/${key}`;
  }
}

let pngBuffer: Buffer;

// 9E.21 — the write routes of a product (PATCH /products/:id, POST/DELETE /products/:id/image, DELETE /products/:id) over HTTP: real
// controllers, guards, validation pipe, services, audit and database, with only the bucket faked. The moment another admin writes
// "in the middle" is simulated by running that write inside the bucket's put() (the S3 window) or between two requests; the same
// races with independent connections on a real PostgreSQL are in product-concurrency.e2e-spec.ts (opt-in).
describe('Product writes (e2e, real local Postgres, fake bucket)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  let dataSource: DataSource;
  const bucket = new FakeBucket();
  let bizA: Business;
  let bizB: Business;
  let catA: Category;
  const tokens = { a: '', b: '', super: '' };

  const http = () => request(`http://127.0.0.1:${((app.getHttpServer() as { address: () => AddressInfo }).address()).port}`);
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const login = async (email: string) => (await http().post('/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;
  const patch = (id: string, body: object, token = tokens.a) => http().patch(`/products/${id}`).set(as(token)).send(body);
  const upload = (id: string, token = tokens.a) => http().post(`/products/${id}/image`).set(as(token)).attach('file', pngBuffer, { filename: 'p.png', contentType: 'image/png' });
  const removeImage = (id: string, token = tokens.a) => http().delete(`/products/${id}/image`).set(as(token));

  let seq = 0;
  const newProduct = async (extra: Partial<Product> = {}) => {
    seq += 1;
    const repo = dataSource.getRepository(Product);
    return repo.save(repo.create({ name: `Burger ${seq}`, price: 1000, description: 'Clásica', businessId: bizA.id, categoryId: catA.id, ...extra }));
  };
  const row = async (id: string) =>
    (await dataSource.query(`SELECT name, description, price, available, active, image_storage_key AS img, deleted_at AS del, business_id AS biz FROM products WHERE id = $1`, [id]))[0] as {
      name: string; description: string | null; price: number; available: boolean; active: boolean; img: string | null; del: Date | null; biz: string;
    };
  const audits = (entityId: string) =>
    dataSource.query(`SELECT action, user_email, business_id FROM audit_logs WHERE entity_id = $1 AND action IN ('PRODUCT_UPDATED','PRODUCT_DEACTIVATED','PRODUCT_DELETED') ORDER BY created_at, id`, [entityId]) as Promise<
      Array<{ action: string; user_email: string; business_id: string }>
    >;
  const settleAudit = async (entityId: string, expected: number) => {
    for (let i = 0; i < 40; i++) {
      if ((await audits(entityId)).length >= expected) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
    return audits(entityId);
  };

  beforeAll(async () => {
    pngBuffer = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#cc3300' } }).png().toBuffer();
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
    bizA = await businessRepo.save(businessRepo.create({ name: 'Product writes A', slug: 'product-writes-a' }));
    bizB = await businessRepo.save(businessRepo.create({ name: 'Product writes B', slug: 'product-writes-b' }));
    const categoryRepo = dataSource.getRepository(Category);
    catA = await categoryRepo.save(categoryRepo.create({ name: 'Burgers', slug: 'burgers', businessId: bizA.id }));

    const userRepo = dataSource.getRepository(User);
    const passwordHash = await bcrypt.hash(PASSWORD, TEST_BCRYPT_COST);
    await userRepo.save([
      userRepo.create({ email: 'a@product-writes.test', passwordHash, role: UserRole.ADMIN, businessId: bizA.id }),
      userRepo.create({ email: 'b@product-writes.test', passwordHash, role: UserRole.ADMIN, businessId: bizB.id }),
      userRepo.create({ email: 'super@product-writes.test', passwordHash, role: UserRole.SUPER_ADMIN, businessId: null }),
    ]);
    tokens.a = await login('a@product-writes.test');
    tokens.b = await login('b@product-writes.test');
    tokens.super = await login('super@product-writes.test');
  }, 90_000);

  afterAll(async () => {
    delete process.env.MEDIA_PUBLIC_BASE_URL;
    await app?.close();
    await testDb?.stop();
  });

  it('PATCH answers 200 with the WHOLE product (the columns the request did not send included), changes only what was sent, and audits it once', async () => {
    const p = await newProduct({ description: 'Clásica', tag: 'Top' });
    const res = await patch(p.id, { price: 1500 }).expect(200);
    expect(res.body).toMatchObject({ id: p.id, name: p.name, price: 1500, description: 'Clásica', tag: 'Top', available: true, active: true, businessId: bizA.id, categoryId: catA.id });
    expect(JSON.stringify(res.body)).not.toMatch(/storage_?key/i);
    expect(await row(p.id)).toMatchObject({ name: p.name, price: 1500, description: 'Clásica', available: true });
    const log = await settleAudit(p.id, 1);
    expect(log).toEqual([{ action: 'PRODUCT_UPDATED', user_email: 'a@product-writes.test', business_id: bizA.id }]);
  });

  it('PATCH: an explicit null clears a nullable column, an omitted one is untouched, and falsy values are written', async () => {
    const p = await newProduct({ description: 'Clásica', tag: 'Top' });
    await patch(p.id, { description: null, price: 0, available: false }).expect(200);
    expect(await row(p.id)).toMatchObject({ description: null, price: 0, available: false, name: p.name });
  });

  it('PATCH deactivation keeps its own audit action; a refused or unknown product leaves no audit entry', async () => {
    const p = await newProduct();
    await patch(p.id, { active: false }).expect(200);
    expect((await settleAudit(p.id, 1)).map((a) => a.action)).toEqual(['PRODUCT_DEACTIVATED']);
    const q = await newProduct();
    await patch(q.id, { price: -5 }).expect(400);
    await patch('00000000-0000-4000-8000-000000000000', { price: 1 }).expect(404);
    expect(await settleAudit(q.id, 0)).toHaveLength(0);
  });

  it('a DELETED product cannot be edited, re-imaged or un-imaged: 404 each time, and it stays deleted', async () => {
    const p = await newProduct();
    await http().delete(`/products/${p.id}`).set(as(tokens.a)).expect(204);
    await patch(p.id, { price: 1 }).expect(404);
    await upload(p.id).expect(404);
    await removeImage(p.id).expect(404);
    expect((await row(p.id)).del).not.toBeNull();
  });

  it('IMAGE UPLOAD: a price / availability / name change committed DURING the upload survives, and the reference points at the stored object', async () => {
    const p = await newProduct({ name: 'Burger', price: 1000 });
    bucket.duringPut = async () => {
      await dataSource.query(`UPDATE products SET name = 'Burger XL', price = 1500, available = false WHERE id = $1`, [p.id]);
    };
    const res = await upload(p.id).expect(201);
    expect(res.body).toMatchObject({ id: p.id, name: 'Burger XL', price: 1500, available: false });
    expect(res.body.imageUrl).toMatch(new RegExp(`^${BASE}/media/businesses/${bizA.id}/products/${p.id}/`));
    const after = await row(p.id);
    expect(after).toMatchObject({ name: 'Burger XL', price: 1500, available: false });
    expect(after.img).toBe(bucket.putKeys[bucket.putKeys.length - 1]);
    expect(bucket.objects.has(after.img as string)).toBe(true);
  });

  it('IMAGE UPLOAD on a product DELETED during the upload: 404, it is NOT restored, no key is written; the object stays in the bucket (orphan, nothing deleted)', async () => {
    const p = await newProduct();
    const before = bucket.putKeys.length;
    bucket.duringPut = async () => {
      await dataSource.query(`UPDATE products SET deleted_at = now() WHERE id = $1`, [p.id]);
    };
    await upload(p.id).expect(404);
    const after = await row(p.id);
    expect(after.del).not.toBeNull();
    expect(after.img).toBeNull();
    expect(bucket.putKeys.length).toBe(before + 1); // uploaded exactly once, never retried
    expect(bucket.objects.has(bucket.putKeys[before]!)).toBe(true); // and never deleted
  });

  it('REMOVE IMAGE clears only the reference (the price changed in between is kept) and a second removal is a harmless 200', async () => {
    const p = await newProduct({ price: 1000 });
    await upload(p.id).expect(201);
    await dataSource.query(`UPDATE products SET price = 1700 WHERE id = $1`, [p.id]);
    const res = await removeImage(p.id).expect(200);
    expect(res.body).toMatchObject({ id: p.id, price: 1700, imageUrl: null });
    expect(await row(p.id)).toMatchObject({ price: 1700, img: null });
    await removeImage(p.id).expect(200);
  });

  it('isolation: another restaurant\'s ADMIN gets 403 on PATCH, upload and image removal; nothing changes; a SUPER_ADMIN may act', async () => {
    const p = await newProduct();
    const puts = bucket.putKeys.length;
    await patch(p.id, { price: 1 }, tokens.b).expect(403);
    await upload(p.id, tokens.b).expect(403);
    await removeImage(p.id, tokens.b).expect(403);
    expect(bucket.putKeys.length).toBe(puts);
    expect((await row(p.id)).price).toBe(1000);
    await patch(p.id, { price: 1999 }, tokens.super).expect(200);
    await upload(p.id, tokens.super).expect(201);
    expect(await row(p.id)).toMatchObject({ price: 1999 });
    expect((await settleAudit(p.id, 1)).at(-1)).toMatchObject({ action: 'PRODUCT_UPDATED', user_email: 'super@product-writes.test', business_id: bizA.id });
  });

  it('a PATCH that targets a column the DTO does not allow is still rejected (400): id, image key, deletedAt', async () => {
    const p = await newProduct();
    for (const body of [{ id: 'x' }, { imageStorageKey: 'k' }, { deletedAt: null }, { imageUrl: 'https://x.test/a.png' }]) {
      await patch(p.id, body).expect(400);
    }
    expect(await row(p.id)).toMatchObject({ name: p.name, price: 1000, del: null });
  });
});
