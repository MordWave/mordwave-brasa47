import type { AddressInfo } from 'node:net';
import bcrypt from 'bcrypt';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { Business } from '../src/business/business.entity.js';
import { Category } from '../src/category/category.entity.js';
import { CategoryService } from '../src/category/category.service.js';
import { Product } from '../src/product/product.entity.js';
import { DEFAULT_RATE_LIMITS, RATE_LIMIT_CONFIG } from '../src/rate-limit/rate-limit.config.js';
import { User } from '../src/user/user.entity.js';
import { UserRole } from '../src/user/user-role.enum.js';
import { runAllMigrations } from './support/run-all-migrations.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

const TEST_BCRYPT_COST = 4;
const PASSWORD = 'Sup3rSecret!K';
const minute = 60_000;
const huge = { limit: 100_000, ttlMs: minute };
const LIMITS = { ...DEFAULT_RATE_LIMITS, globalIp: huge, authenticatedUser: huge };

// 9E.23 — PATCH / DELETE /categories/:id and the product writes that depend on a category, over HTTP (real controllers, guards,
// validation pipe, services, audit and database). The moment another admin writes "in the middle" is simulated by running that write
// right after the service's read; the same races with independent connections on a real PostgreSQL, and the lock protocol between
// categories and products, are in category-concurrency.e2e-spec.ts (opt-in).
describe('Category writes (e2e, real local Postgres)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  let dataSource: DataSource;
  let bizA: Business;
  let bizB: Business;
  const tokens = { a: '', b: '', super: '' };
  const UNKNOWN = '00000000-0000-4000-8000-000000000000';

  const http = () => request(`http://127.0.0.1:${((app.getHttpServer() as { address: () => AddressInfo }).address()).port}`);
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const login = async (email: string) => (await http().post('/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;
  const patch = (id: string, body: object, token = tokens.a) => http().patch(`/categories/${id}`).set(as(token)).send(body);
  const del = (id: string, token = tokens.a) => http().delete(`/categories/${id}`).set(as(token));

  let seq = 0;
  const newCategory = async (extra: Partial<Category> = {}, businessId = bizA.id) => {
    seq += 1;
    const repo = dataSource.getRepository(Category);
    return repo.save(repo.create({ name: `Cat ${seq}`, slug: `cat-${seq}`, businessId, ...extra }));
  };
  const newProduct = async (categoryId: string, extra: Partial<Product> = {}) => {
    seq += 1;
    const repo = dataSource.getRepository(Product);
    return repo.save(repo.create({ name: `Prod ${seq}`, price: 1000, businessId: bizA.id, categoryId, ...extra }));
  };
  const row = async (id: string) =>
    (await dataSource.query(`SELECT name, slug, active, sort_order AS "sortOrder", deleted_at AS del FROM categories WHERE id = $1`, [id]))[0] as { name: string; slug: string; active: boolean; sortOrder: number; del: Date | null };
  const audits = (entityId: string) =>
    dataSource.query(`SELECT action, user_email, business_id FROM audit_logs WHERE entity_id = $1 AND action IN ('CATEGORY_UPDATED','CATEGORY_DEACTIVATED','CATEGORY_DELETED') ORDER BY created_at, id`, [entityId]) as Promise<
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

  // After CategoryService READ the category, another admin commits `rawSql` — the request then writes against a stale read.
  function otherWriterAfterRead(rawSql: string, params: unknown[]) {
    const service = app.get(CategoryService) as unknown as { categoryRepository: { findOne: (...a: unknown[]) => Promise<unknown> } };
    const repository = service.categoryRepository;
    const original = repository.findOne.bind(repository);
    let first = true;
    return vi.spyOn(repository, 'findOne').mockImplementation(async (...args: unknown[]) => {
      const result = await original(...args);
      if (first) {
        first = false;
        await dataSource.query(rawSql, params);
      }
      return result;
    });
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

    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(RATE_LIMIT_CONFIG).useValue(LIMITS).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    dataSource = moduleFixture.get(DataSource);
    await runAllMigrations(dataSource);

    const businessRepo = dataSource.getRepository(Business);
    bizA = await businessRepo.save(businessRepo.create({ name: 'Category writes A', slug: 'category-writes-a' }));
    bizB = await businessRepo.save(businessRepo.create({ name: 'Category writes B', slug: 'category-writes-b' }));
    const userRepo = dataSource.getRepository(User);
    const passwordHash = await bcrypt.hash(PASSWORD, TEST_BCRYPT_COST);
    await userRepo.save([
      userRepo.create({ email: 'a@category-writes.test', passwordHash, role: UserRole.ADMIN, businessId: bizA.id }),
      userRepo.create({ email: 'b@category-writes.test', passwordHash, role: UserRole.ADMIN, businessId: bizB.id }),
      userRepo.create({ email: 'super@category-writes.test', passwordHash, role: UserRole.SUPER_ADMIN, businessId: null }),
    ]);
    tokens.a = await login('a@category-writes.test');
    tokens.b = await login('b@category-writes.test');
    tokens.super = await login('super@category-writes.test');
  }, 90_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.close();
    await testDb?.stop();
  });

  it('PATCH answers 200 with the WHOLE category when only one field is sent, changes only that field, and audits it once', async () => {
    const c = await newCategory({ name: 'Burgers', sortOrder: 3 });
    const res = await patch(c.id, { name: 'Hamburguesas' }).expect(200);
    expect(res.body).toMatchObject({ id: c.id, businessId: bizA.id, name: 'Hamburguesas', slug: c.slug, active: true, sortOrder: 3 });
    expect(res.body).toHaveProperty('createdAt');
    expect(res.body).toHaveProperty('updatedAt');
    expect(await row(c.id)).toMatchObject({ name: 'Hamburguesas', slug: c.slug, active: true, sortOrder: 3 });
    const log = await settleAudit(c.id, 1);
    expect(log).toEqual([{ action: 'CATEGORY_UPDATED', user_email: 'a@category-writes.test', business_id: bizA.id }]);
  });

  it('PATCH: false and 0 are written; a deactivation keeps its own audit action; invalid bodies are 400', async () => {
    const c = await newCategory({ sortOrder: 4 });
    await patch(c.id, { active: false, sortOrder: 0 }).expect(200);
    expect(await row(c.id)).toMatchObject({ active: false, sortOrder: 0 });
    expect((await settleAudit(c.id, 1)).map((a) => a.action)).toEqual(['CATEGORY_DEACTIVATED']);
    for (const body of [{ name: 5 }, { active: 'no' }, { businessId: bizB.id }, { id: 'x' }, { deletedAt: null }]) await patch(c.id, body).expect(400);
  });

  it('a category with active products cannot be deactivated (409 CATEGORY_HAS_ACTIVE_PRODUCTS) and one with any product cannot be deleted (409 CATEGORY_HAS_PRODUCTS): unchanged, no audit', async () => {
    const c = await newCategory();
    await newProduct(c.id);
    const r1 = await patch(c.id, { active: false }).expect(409);
    expect(r1.body).toMatchObject({ errorCode: 'CATEGORY_HAS_ACTIVE_PRODUCTS', count: 1 });
    const r2 = await del(c.id).expect(409);
    expect(r2.body).toMatchObject({ errorCode: 'CATEGORY_HAS_PRODUCTS', count: 1 });
    expect(await row(c.id)).toMatchObject({ active: true, del: null });
    expect(await settleAudit(c.id, 0)).toHaveLength(0);
    // an INACTIVE product still blocks the deletion but not the deactivation
    await dataSource.query(`UPDATE products SET active = false WHERE category_id = $1`, [c.id]);
    await patch(c.id, { active: false }).expect(200);
    await del(c.id).expect(409);
  });

  it('DELETE answers 204, soft-deletes, audits once; afterwards PATCH and DELETE are 404 and the category is not restored', async () => {
    const c = await newCategory();
    await del(c.id).expect(204);
    expect((await row(c.id)).del).not.toBeNull();
    await patch(c.id, { name: 'x' }).expect(404);
    await del(c.id).expect(404);
    expect((await row(c.id)).del).not.toBeNull();
    expect((await settleAudit(c.id, 1)).map((a) => a.action)).toEqual(['CATEGORY_DELETED']);
  });

  it('LOST UPDATE: a rename whose read happened BEFORE another admin deactivated the category does not turn it active again', async () => {
    const c = await newCategory({ name: 'Burgers' });
    const spy = otherWriterAfterRead(`UPDATE categories SET active = false WHERE id = $1`, [c.id]);
    try {
      await patch(c.id, { name: 'Hamburguesas' }).expect(200);
    } finally {
      spy.mockRestore();
    }
    expect(await row(c.id)).toMatchObject({ name: 'Hamburguesas', active: false });
  });

  it('a PATCH whose read happened before the category was DELETED is a 404; the category stays deleted and is not audited as updated', async () => {
    const c = await newCategory();
    const spy = otherWriterAfterRead(`UPDATE categories SET deleted_at = now() WHERE id = $1`, [c.id]);
    try {
      await patch(c.id, { name: 'x' }).expect(404);
    } finally {
      spy.mockRestore();
    }
    const after = await row(c.id);
    expect(after.del).not.toBeNull();
    expect(after.name).toBe(c.name);
    expect(await settleAudit(c.id, 0)).toHaveLength(0);
  });

  it('PRODUCT side: creating, reactivating or moving a product into an inactive category is a 409, into a deleted one a 404; nothing is written', async () => {
    const inactive = await newCategory({ active: false });
    const deleted = await newCategory();
    await del(deleted.id).expect(204);
    const home = await newCategory();
    const idle = await newProduct(home.id, { active: false });
    const live = await newProduct(home.id);

    const create = (categoryId: string) => http().post('/products').set(as(tokens.a)).send({ name: 'Nuevo', price: 900, categoryId, businessId: bizA.id }); // businessId is required by the DTO (an ADMIN's is overridden by their own)
    await create(inactive.id).expect(409);
    await create(deleted.id).expect(404);
    await http().patch(`/products/${live.id}`).set(as(tokens.a)).send({ categoryId: inactive.id }).expect(409);
    await http().patch(`/products/${live.id}`).set(as(tokens.a)).send({ categoryId: deleted.id }).expect(404);
    await dataSource.query(`UPDATE categories SET active = false WHERE id = $1`, [home.id]);
    await dataSource.query(`UPDATE products SET active = false WHERE id = $1`, [live.id]);
    await http().patch(`/products/${idle.id}`).set(as(tokens.a)).send({ active: true }).expect(409);
    const n = await dataSource.query(`SELECT count(*)::int AS n FROM products WHERE category_id IN ($1, $2)`, [inactive.id, deleted.id]);
    expect(n[0].n).toBe(0);
    // and the happy path still works
    const ok = await newCategory();
    await create(ok.id).expect(201);
    await http().patch(`/products/${live.id}`).set(as(tokens.a)).send({ categoryId: ok.id, active: true }).expect(200);
  });

  it('isolation: another restaurant\'s ADMIN gets 403 on PATCH and DELETE with nothing changed; a SUPER_ADMIN may do both', async () => {
    const c = await newCategory({ name: 'Burgers' });
    await patch(c.id, { name: 'x' }, tokens.b).expect(403);
    await del(c.id, tokens.b).expect(403);
    expect(await row(c.id)).toMatchObject({ name: 'Burgers', del: null });
    expect(await settleAudit(c.id, 0)).toHaveLength(0);
    await patch(c.id, { name: 'Por SUPER' }, tokens.super).expect(200);
    expect((await settleAudit(c.id, 1))[0]).toMatchObject({ action: 'CATEGORY_UPDATED', user_email: 'super@category-writes.test', business_id: bizA.id });
    await del(c.id, tokens.super).expect(204);
  });

  it('unknown category -> 404 on PATCH and DELETE; no token -> 401', async () => {
    await patch(UNKNOWN, { name: 'x' }).expect(404);
    await del(UNKNOWN).expect(404);
    await http().patch(`/categories/${UNKNOWN}`).send({ name: 'x' }).expect(401);
  });
});
