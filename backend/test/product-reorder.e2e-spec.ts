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
const UNKNOWN = '00000000-0000-4000-8000-000000000000';

// 9L.6 — PUT /products/order (the complete order of the products of ONE category, saved atomically), "a new product goes last in its category" and
// "changing the category puts it last in the destination", over HTTP: real controllers, guards, validation pipe, services, audit and database.
// The same protocol with INDEPENDENT connections on a real PostgreSQL (two admins at once, a creation or a change of category at the same time as
// a reorder, no deadlocks) is in product-concurrency.e2e-spec.ts (opt-in).
describe('Product order (e2e, real local Postgres)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  let ds: DataSource;
  let bizA: Business;
  let bizB: Business;
  const tokens = { a: '', b: '', super: '' };

  const http = () => request(`http://127.0.0.1:${((app.getHttpServer() as { address: () => AddressInfo }).address()).port}`);
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const login = async (email: string) => (await http().post('/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;
  const reorder = (body: unknown, token = tokens.a) => http().put('/products/order').set(as(token)).send(body as object);
  const create = (body: object, token = tokens.a) => http().post('/products').set(as(token)).send({ businessId: token === tokens.b ? bizB.id : bizA.id, price: 1000, ...body });

  let seq = 0;
  const addCategory = async (extra: Partial<Category> = {}, businessId = bizA.id) => {
    seq += 1;
    const repo = ds.getRepository(Category);
    return repo.save(repo.create({ name: `Cat ${seq}`, slug: `cat-${seq}`, businessId, sortOrder: seq, ...extra }));
  };
  // a product with an explicit value (the way old data looks: repeated, with gaps, active or not)
  const addProduct = async (categoryId: string, sortOrder: number, extra: Partial<Product> = {}, businessId = bizA.id) => {
    seq += 1;
    const repo = ds.getRepository(Product);
    const saved = await repo.save(repo.create({ name: `Prod ${seq}`, price: 1000, businessId, categoryId, sortOrder, ...extra }));
    await new Promise((resolve) => setTimeout(resolve, 5)); // distinct created_at: the tie-break of equal values is deterministic
    return saved;
  };
  const wipe = async (businessId: string) => {
    await ds.query(`DELETE FROM products WHERE business_id = $1`, [businessId]);
    await ds.query(`DELETE FROM categories WHERE business_id = $1`, [businessId]);
  };
  // the way the lists show it: sort_order, created_at, id (deleted ones never)
  const state = async (categoryId: string) =>
    (await ds.query(`SELECT id, sort_order AS "sortOrder", active, updated_at AS upd FROM products WHERE category_id = $1 AND deleted_at IS NULL ORDER BY sort_order, created_at, id`, [categoryId])) as Array<{ id: string; sortOrder: number; active: boolean; upd: Date }>;
  const idsOf = (rows: Array<{ id: string }>) => rows.map((r) => r.id);
  const adminList = async (categoryId: string, token = tokens.a) =>
    ((await http().get(`/products/admin?categoryId=${categoryId}&limit=100`).set(as(token)).expect(200)).body.items as Array<{ id: string; sortOrder: number }>);
  const audits = (businessId: string) =>
    ds.query(`SELECT action, user_email, entity_type, entity_id, metadata FROM audit_logs WHERE business_id = $1 AND action = 'PRODUCT_REORDERED' ORDER BY created_at, id`, [businessId]) as Promise<
      Array<{ action: string; user_email: string; entity_type: string; entity_id: string; metadata: { orderedIds: string[] } }>
    >;
  const settleAudit = async (businessId: string, expected: number) => {
    for (let i = 0; i < 40; i++) {
      if ((await audits(businessId)).length >= expected) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
    return audits(businessId);
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

    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(RATE_LIMIT_CONFIG).useValue(LIMITS).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    ds = moduleFixture.get(DataSource);
    await runAllMigrations(ds);

    const businessRepo = ds.getRepository(Business);
    bizA = await businessRepo.save(businessRepo.create({ name: 'Porder A', slug: 'porder-a' }));
    bizB = await businessRepo.save(businessRepo.create({ name: 'Porder B', slug: 'porder-b' }));
    const userRepo = ds.getRepository(User);
    const passwordHash = await bcrypt.hash(PASSWORD, TEST_BCRYPT_COST);
    await userRepo.save([
      userRepo.create({ email: 'a@porder.test', passwordHash, role: UserRole.ADMIN, businessId: bizA.id }),
      userRepo.create({ email: 'b@porder.test', passwordHash, role: UserRole.ADMIN, businessId: bizB.id }),
      userRepo.create({ email: 'super@porder.test', passwordHash, role: UserRole.SUPER_ADMIN, businessId: null }),
    ]);
    tokens.a = await login('a@porder.test');
    tokens.b = await login('b@porder.test');
    tokens.super = await login('super@porder.test');
  }, 90_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.close();
    await testDb?.stop();
  });

  describe('a new product goes last in its category', () => {
    it('with the products of the category all at 0 (the old form default): last, above every value there', async () => {
      await wipe(bizA.id);
      const cat = await addCategory();
      const [p1, p2, p3] = [await addProduct(cat.id, 0), await addProduct(cat.id, 0), await addProduct(cat.id, 0)];
      const res = await create({ name: 'Nuevo', categoryId: cat.id }).expect(201);
      expect(res.body.sortOrder).toBe(1);
      expect(idsOf(await state(cat.id))).toEqual([p1.id, p2.id, p3.id, res.body.id]); // the existing ones keep exactly the order they showed
      expect(idsOf(await adminList(cat.id))).toEqual([p1.id, p2.id, p3.id, res.body.id]);
    });

    it('with repeated and discontinuous values (0, 1, 2, 3, 5): after the highest', async () => {
      await wipe(bizA.id);
      const cat = await addCategory();
      for (const value of [0, 1, 2, 3, 5]) await addProduct(cat.id, value);
      const res = await create({ name: 'Nuevo', categoryId: cat.id }).expect(201);
      expect(res.body.sortOrder).toBe(6);
      expect((await state(cat.id)).at(-1)?.id).toBe(res.body.id);
    });

    it('an empty category starts at 1; the position is per category: another category is not affected and does not matter', async () => {
      await wipe(bizA.id);
      const [c1, c2] = [await addCategory(), await addCategory()];
      for (const value of [10, 20, 30]) await addProduct(c1.id, value);
      const before = await state(c1.id);
      const first = await create({ name: 'Primero', categoryId: c2.id }).expect(201);
      expect(first.body.sortOrder).toBe(1);
      expect(await state(c1.id)).toEqual(before);
    });

    it('inactive products count (they keep their place); soft-deleted ones do not', async () => {
      await wipe(bizA.id);
      const cat = await addCategory();
      await addProduct(cat.id, 3);
      await addProduct(cat.id, 9, { active: false });
      const deleted = await addProduct(cat.id, 40);
      await http().delete(`/products/${deleted.id}`).set(as(tokens.a)).expect(204);
      const res = await create({ name: 'Nuevo', categoryId: cat.id }).expect(201);
      expect(res.body.sortOrder).toBe(10);
    });

    it('an explicit sortOrder from an older client is honoured as sent', async () => {
      await wipe(bizA.id);
      const cat = await addCategory();
      await addProduct(cat.id, 5);
      const res = await create({ name: 'Antiguo', categoryId: cat.id, sortOrder: 0 }).expect(201);
      expect(res.body.sortOrder).toBe(0);
    });

    it('creations one after another never share a position', async () => {
      await wipe(bizA.id);
      const cat = await addCategory();
      await addProduct(cat.id, 0);
      const created = await Promise.all(Array.from({ length: 6 }, (_, i) => create({ name: `P${i}`, categoryId: cat.id })));
      created.forEach((r) => expect(r.status).toBe(201));
      const values = (await state(cat.id)).map((r) => r.sortOrder);
      expect(new Set(values).size).toBe(values.length);
      expect(Math.max(...values)).toBe(6); // the existing one at 0, then 1..6
    });
  });

  describe('changing the category puts the product last in the destination', () => {
    it('last in the destination (also when the destination is all 0), and the origin is untouched', async () => {
      await wipe(bizA.id);
      const [origin, dest] = [await addCategory(), await addCategory()];
      const [o1, o2] = [await addProduct(origin.id, 1), await addProduct(origin.id, 2)];
      const [d1, d2] = [await addProduct(dest.id, 0), await addProduct(dest.id, 0)];
      const res = await http().patch(`/products/${o1.id}`).set(as(tokens.a)).send({ categoryId: dest.id }).expect(200);
      expect(res.body.sortOrder).toBe(1);
      expect(idsOf(await state(dest.id))).toEqual([d1.id, d2.id, o1.id]);
      expect(idsOf(await state(origin.id))).toEqual([o2.id]);
      expect((await state(origin.id))[0].sortOrder).toBe(2); // the origin keeps its values: nothing is renumbered by this
    });

    it('an edit that keeps the category, or a reactivation, never changes the position', async () => {
      await wipe(bizA.id);
      const cat = await addCategory();
      await addProduct(cat.id, 1);
      const p = await addProduct(cat.id, 2, { active: false });
      await addProduct(cat.id, 3);
      await http().patch(`/products/${p.id}`).set(as(tokens.a)).send({ name: 'Renombrado', categoryId: cat.id }).expect(200);
      await http().patch(`/products/${p.id}`).set(as(tokens.a)).send({ active: true }).expect(200);
      expect((await state(cat.id)).find((r) => r.id === p.id)?.sortOrder).toBe(2);
    });

    it('an explicit sortOrder sent with the new category (an older client) is honoured', async () => {
      await wipe(bizA.id);
      const [origin, dest] = [await addCategory(), await addCategory()];
      const p = await addProduct(origin.id, 4);
      await addProduct(dest.id, 7);
      const res = await http().patch(`/products/${p.id}`).set(as(tokens.a)).send({ categoryId: dest.id, sortOrder: 2 }).expect(200);
      expect(res.body.sortOrder).toBe(2);
    });
  });

  describe('PUT /products/order', () => {
    it('moves a product up and down: saved, confirmed in the answer, the same after reading again, and the other categories and restaurants are untouched', async () => {
      await wipe(bizA.id);
      await wipe(bizB.id);
      const [cat, other] = [await addCategory(), await addCategory()];
      const [p1, p2, p3, p4] = [await addProduct(cat.id, 1), await addProduct(cat.id, 2), await addProduct(cat.id, 3), await addProduct(cat.id, 4)];
      const o1 = await addProduct(other.id, 0);
      const catB = await addCategory({}, bizB.id);
      await addProduct(catB.id, 0, {}, bizB.id);
      const beforeOther = await state(other.id);
      const beforeB = await state(catB.id);

      const up = await reorder({ categoryId: cat.id, orderedIds: [p1.id, p3.id, p2.id, p4.id], expectedIds: [p1.id, p2.id, p3.id, p4.id] }).expect(200);
      expect(idsOf(up.body)).toEqual([p1.id, p3.id, p2.id, p4.id]);
      expect(up.body.map((r: { sortOrder: number }) => r.sortOrder)).toEqual([1, 2, 3, 4]);
      const down = await reorder({ categoryId: cat.id, orderedIds: [p1.id, p3.id, p4.id, p2.id], expectedIds: [p1.id, p3.id, p2.id, p4.id] }).expect(200);
      expect(idsOf(down.body)).toEqual([p1.id, p3.id, p4.id, p2.id]);
      expect(idsOf(await adminList(cat.id))).toEqual([p1.id, p3.id, p4.id, p2.id]);
      expect(await state(other.id)).toEqual(beforeOther);
      expect(idsOf(await state(other.id))).toEqual([o1.id]);
      expect(await state(catB.id)).toEqual(beforeB);
    });

    it('"to the start" and "to the end" with every product at 0: the others keep the order they showed, the values become 1..n', async () => {
      await wipe(bizA.id);
      const cat = await addCategory();
      const [a, b, c, d] = [await addProduct(cat.id, 0), await addProduct(cat.id, 0), await addProduct(cat.id, 0), await addProduct(cat.id, 0)];
      await reorder({ categoryId: cat.id, orderedIds: [c.id, a.id, b.id, d.id], expectedIds: [a.id, b.id, c.id, d.id] }).expect(200);
      expect((await state(cat.id)).map((r) => [r.id, r.sortOrder])).toEqual([[c.id, 1], [a.id, 2], [b.id, 3], [d.id, 4]]);
      await reorder({ categoryId: cat.id, orderedIds: [a.id, b.id, d.id, c.id], expectedIds: [c.id, a.id, b.id, d.id] }).expect(200);
      expect((await state(cat.id)).map((r) => [r.id, r.sortOrder])).toEqual([[a.id, 1], [b.id, 2], [d.id, 3], [c.id, 4]]);
    });

    it('repeated and discontinuous values (0, 1, 1, 4) become consecutive, starting from the order the lists showed', async () => {
      await wipe(bizA.id);
      const cat = await addCategory();
      const [a, b, c, d] = [await addProduct(cat.id, 0), await addProduct(cat.id, 1), await addProduct(cat.id, 1), await addProduct(cat.id, 4)];
      await reorder({ categoryId: cat.id, orderedIds: [d.id, a.id, b.id, c.id], expectedIds: [a.id, b.id, c.id, d.id] }).expect(200);
      expect((await state(cat.id)).map((r) => [r.id, r.sortOrder])).toEqual([[d.id, 1], [a.id, 2], [b.id, 3], [c.id, 4]]);
    });

    it('active and inactive products are part of the list; soft-deleted ones are not', async () => {
      await wipe(bizA.id);
      const cat = await addCategory();
      const [a, b] = [await addProduct(cat.id, 1), await addProduct(cat.id, 2, { active: false })];
      const gone = await addProduct(cat.id, 3);
      const c = await addProduct(cat.id, 4);
      await http().delete(`/products/${gone.id}`).set(as(tokens.a)).expect(204);
      await reorder({ categoryId: cat.id, orderedIds: [c.id, b.id, a.id], expectedIds: [a.id, b.id, c.id] }).expect(200);
      const rows = await state(cat.id);
      expect(rows.map((r) => [r.id, r.sortOrder, r.active])).toEqual([[c.id, 1, true], [b.id, 2, false], [a.id, 3, true]]);
      // the deleted one is neither required nor accepted
      await reorder({ categoryId: cat.id, orderedIds: [gone.id, c.id, b.id, a.id], expectedIds: [c.id, b.id, a.id] }).expect(400);
    });

    it('a reorder writes the position and nothing else of the products (name, price, flags, personalisation, photo key)', async () => {
      await wipe(bizA.id);
      const cat = await addCategory();
      const a = await addProduct(cat.id, 1, { tag: 'Nuevo', ingredients: ['x', 'y'], removableIngredients: ['y'], addOns: [{ name: 'Extra', price: 500 }], available: false });
      const b = await addProduct(cat.id, 2);
      const snapshot = async () => (await ds.query(`SELECT name, price, active, available, tag, ingredients, removable_ingredients, add_ons, image_storage_key, category_id, business_id, description FROM products WHERE category_id = $1 ORDER BY name`, [cat.id])) as unknown[];
      const before = await snapshot();
      await reorder({ categoryId: cat.id, orderedIds: [b.id, a.id], expectedIds: [a.id, b.id] }).expect(200);
      expect(await snapshot()).toEqual(before);
    });

    it('the public menu and the QR product list show the new order (their code is untouched: they read the same column)', async () => {
      await wipe(bizA.id);
      const cat = await addCategory();
      const [a, b, c] = [await addProduct(cat.id, 0), await addProduct(cat.id, 0), await addProduct(cat.id, 0)];
      await reorder({ categoryId: cat.id, orderedIds: [c.id, a.id, b.id], expectedIds: [a.id, b.id, c.id] }).expect(200);
      const publicMenu = await http().get(`/public/menu/${bizA.slug}`).expect(200);
      expect(idsOf(publicMenu.body.products)).toEqual([c.id, a.id, b.id]);
      const qr = await http().get(`/products?businessSlug=${bizA.slug}`).expect(200);
      expect(idsOf(qr.body)).toEqual([c.id, a.id, b.id]);
    });

    it('when the order is already the one asked nothing is written and nothing is audited', async () => {
      await wipe(bizA.id);
      const cat = await addCategory();
      const [a, b] = [await addProduct(cat.id, 1), await addProduct(cat.id, 2)];
      const before = await state(cat.id);
      const audited = (await audits(bizA.id)).length;
      await reorder({ categoryId: cat.id, orderedIds: [a.id, b.id], expectedIds: [a.id, b.id] }).expect(200);
      expect(await state(cat.id)).toEqual(before);
      expect(await settleAudit(bizA.id, audited)).toHaveLength(audited);
    });

    it('is audited: who, which category, and the new order', async () => {
      await wipe(bizA.id);
      const cat = await addCategory();
      const [a, b] = [await addProduct(cat.id, 1), await addProduct(cat.id, 2)];
      const audited = (await audits(bizA.id)).length;
      await reorder({ categoryId: cat.id, orderedIds: [b.id, a.id], expectedIds: [a.id, b.id] }).expect(200);
      const rows = await settleAudit(bizA.id, audited + 1);
      expect(rows).toHaveLength(audited + 1);
      expect(rows.at(-1)).toMatchObject({ action: 'PRODUCT_REORDERED', user_email: 'a@porder.test', entity_type: 'Category', entity_id: cat.id, metadata: { orderedIds: [b.id, a.id] } });
    });
  });

  describe('refusals', () => {
    it('409 PRODUCT_ORDER_CONFLICT when the list the caller saw is not the real one (reordered by someone else, or a product was created meanwhile) and nothing is written', async () => {
      await wipe(bizA.id);
      const cat = await addCategory();
      const [a, b, c] = [await addProduct(cat.id, 1), await addProduct(cat.id, 2), await addProduct(cat.id, 3)];
      // someone else already moved c to the start: the same ids, another order
      await reorder({ categoryId: cat.id, orderedIds: [c.id, a.id, b.id], expectedIds: [a.id, b.id, c.id] }).expect(200);
      const before = await state(cat.id);
      const stale = await reorder({ categoryId: cat.id, orderedIds: [b.id, a.id, c.id], expectedIds: [a.id, b.id, c.id] }).expect(409);
      expect(stale.body.errorCode).toBe('PRODUCT_ORDER_CONFLICT');
      expect(await state(cat.id)).toEqual(before);
      // a creation meanwhile
      const created = await create({ name: 'Nuevo', categoryId: cat.id }).expect(201);
      const stale2 = await reorder({ categoryId: cat.id, orderedIds: [a.id, b.id, c.id], expectedIds: [c.id, a.id, b.id] }).expect(409);
      expect(stale2.body.errorCode).toBe('PRODUCT_ORDER_CONFLICT');
      // re-reading and repeating works
      await reorder({ categoryId: cat.id, orderedIds: [created.body.id, c.id, a.id, b.id], expectedIds: [c.id, a.id, b.id, created.body.id] }).expect(200);
    });

    it('409 when a product moved to another category meanwhile', async () => {
      await wipe(bizA.id);
      const [cat, dest] = [await addCategory(), await addCategory()];
      const [a, b] = [await addProduct(cat.id, 1), await addProduct(cat.id, 2)];
      await http().patch(`/products/${b.id}`).set(as(tokens.a)).send({ categoryId: dest.id }).expect(200);
      const res = await reorder({ categoryId: cat.id, orderedIds: [b.id, a.id], expectedIds: [a.id, b.id] }).expect(409);
      expect(res.body.errorCode).toBe('PRODUCT_ORDER_CONFLICT');
    });

    it('400 PRODUCT_ORDER_INVALID: an unknown id, a product of another category, a product of another restaurant, a missing one — one answer for all', async () => {
      await wipe(bizA.id);
      await wipe(bizB.id);
      const [cat, other] = [await addCategory(), await addCategory()];
      const [a, b] = [await addProduct(cat.id, 1), await addProduct(cat.id, 2)];
      const inOther = await addProduct(other.id, 1);
      const catB = await addCategory({}, bizB.id);
      const foreign = await addProduct(catB.id, 1, {}, bizB.id);
      const before = await state(cat.id);
      for (const ordered of [[a.id, UNKNOWN], [a.id, inOther.id], [a.id, foreign.id], [a.id]]) {
        const res = await reorder({ categoryId: cat.id, orderedIds: ordered, expectedIds: [a.id, b.id] }).expect(400);
        expect(res.body.errorCode).toBe('PRODUCT_ORDER_INVALID');
      }
      expect(await state(cat.id)).toEqual(before);
    });

    it('400 for a malformed body: repeated ids, not a uuid, empty, a missing field, an unknown field', async () => {
      await wipe(bizA.id);
      const cat = await addCategory();
      const a = await addProduct(cat.id, 1);
      await reorder({ categoryId: cat.id, orderedIds: [a.id, a.id], expectedIds: [a.id] }).expect(400);
      await reorder({ categoryId: cat.id, orderedIds: ['nope'], expectedIds: [a.id] }).expect(400);
      await reorder({ categoryId: cat.id, orderedIds: [], expectedIds: [] }).expect(400);
      await reorder({ categoryId: cat.id, orderedIds: [a.id] }).expect(400);
      await reorder({ categoryId: 'nope', orderedIds: [a.id], expectedIds: [a.id] }).expect(400);
      await reorder({ categoryId: cat.id, orderedIds: [a.id], expectedIds: [a.id], businessId: bizB.id }).expect(400);
    });

    it('a failure in the middle of the write rolls everything back: no position changed, no audit row', async () => {
      await wipe(bizA.id);
      const cat = await addCategory();
      const [p1, p2, p3] = [await addProduct(cat.id, 0), await addProduct(cat.id, 0), await addProduct(cat.id, 0)];
      const before = await state(cat.id);
      const audited = (await audits(bizA.id)).length;
      await ds.query(`CREATE FUNCTION fail_on_boom_p() RETURNS trigger AS $$ BEGIN IF NEW.id = '${p3.id}'::uuid THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
      await ds.query(`CREATE TRIGGER boom_p BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION fail_on_boom_p()`);
      try {
        const res = await reorder({ categoryId: cat.id, orderedIds: [p3.id, p2.id, p1.id], expectedIds: [p1.id, p2.id, p3.id] });
        expect(res.status).toBe(500);
        expect(await state(cat.id)).toEqual(before); // not even the rows updated before the failing one
        expect(await settleAudit(bizA.id, audited)).toHaveLength(audited);
      } finally {
        await ds.query(`DROP TRIGGER boom_p ON products`);
        await ds.query(`DROP FUNCTION fail_on_boom_p()`);
      }
      await reorder({ categoryId: cat.id, orderedIds: [p3.id, p2.id, p1.id], expectedIds: [p1.id, p2.id, p3.id] }).expect(200);
    });
  });

  describe('which restaurant', () => {
    it('an ADMIN with a category of another restaurant, or one that does not exist, gets the same 404; nothing changes', async () => {
      await wipe(bizA.id);
      await wipe(bizB.id);
      const catB = await addCategory({}, bizB.id);
      const pB = await addProduct(catB.id, 1, {}, bizB.id);
      const beforeB = await state(catB.id);
      const foreign = await reorder({ categoryId: catB.id, orderedIds: [pB.id], expectedIds: [pB.id] }).expect(404);
      const unknown = await reorder({ categoryId: UNKNOWN, orderedIds: [pB.id], expectedIds: [pB.id] }).expect(404);
      expect(foreign.body.message).toContain('does not exist');
      expect(unknown.body.statusCode).toBe(foreign.body.statusCode);
      expect(await state(catB.id)).toEqual(beforeB);
    });

    it('a SUPER_ADMIN reorders the products of different restaurants, each independently', async () => {
      await wipe(bizA.id);
      await wipe(bizB.id);
      const catA = await addCategory();
      const catB = await addCategory({}, bizB.id);
      const [a1, a2] = [await addProduct(catA.id, 1), await addProduct(catA.id, 2)];
      const [b1, b2] = [await addProduct(catB.id, 1, {}, bizB.id), await addProduct(catB.id, 2, {}, bizB.id)];
      await reorder({ categoryId: catA.id, orderedIds: [a2.id, a1.id], expectedIds: [a1.id, a2.id] }, tokens.super).expect(200);
      expect(idsOf(await state(catA.id))).toEqual([a2.id, a1.id]);
      expect(idsOf(await state(catB.id))).toEqual([b1.id, b2.id]);
      await reorder({ categoryId: catB.id, orderedIds: [b2.id, b1.id], expectedIds: [b1.id, b2.id] }, tokens.super).expect(200);
      expect(idsOf(await state(catB.id))).toEqual([b2.id, b1.id]);
      expect(idsOf(await state(catA.id))).toEqual([a2.id, a1.id]);
    });

    it('401 without a session; a suspended restaurant: 403 for its ADMIN, allowed for a SUPER_ADMIN', async () => {
      await wipe(bizB.id);
      const catB = await addCategory({}, bizB.id);
      const [b1, b2] = [await addProduct(catB.id, 1, {}, bizB.id), await addProduct(catB.id, 2, {}, bizB.id)];
      await http().put('/products/order').send({ categoryId: catB.id, orderedIds: [b2.id, b1.id], expectedIds: [b1.id, b2.id] }).expect(401);
      await ds.query(`UPDATE businesses SET active = false WHERE id = $1`, [bizB.id]);
      try {
        await reorder({ categoryId: catB.id, orderedIds: [b2.id, b1.id], expectedIds: [b1.id, b2.id] }, tokens.b).expect(403);
        await reorder({ categoryId: catB.id, orderedIds: [b2.id, b1.id], expectedIds: [b1.id, b2.id] }, tokens.super).expect(200);
      } finally {
        await ds.query(`UPDATE businesses SET active = true WHERE id = $1`, [bizB.id]);
      }
    });
  });
});
