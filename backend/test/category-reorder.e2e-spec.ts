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

// 9L.3 — PUT /categories/order (the complete order of a restaurant's categories, saved atomically) and "a new category goes last", over
// HTTP: real controllers, guards, validation pipe, services, audit and database. The same protocol with INDEPENDENT connections on a real
// PostgreSQL (two admins at once, a creation at the same time as a reorder, no deadlocks) is in category-concurrency.e2e-spec.ts (opt-in).
describe('Category order (e2e, real local Postgres)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  let ds: DataSource;
  let bizA: Business;
  let bizB: Business;
  let bizC: Business;
  const tokens = { a: '', b: '', c: '', super: '' };

  const http = () => request(`http://127.0.0.1:${((app.getHttpServer() as { address: () => AddressInfo }).address()).port}`);
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const login = async (email: string) => (await http().post('/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;
  const reorder = (body: unknown, token = tokens.a, query = '') => http().put(`/categories/order${query}`).set(as(token)).send(body as object);
  // CreateCategoryDto requires businessId (the frontend sends it: scopeBody); for an ADMIN the server uses their own anyway
  const create = (body: object, token = tokens.a) => http().post('/categories').set(as(token)).send({ businessId: token === tokens.b ? bizB.id : bizA.id, ...body });

  let seq = 0;
  // a category with explicit values (the way old data looks: repeated, with gaps, active or not)
  const add = async (sortOrder: number, extra: Partial<Category> = {}, businessId = bizA.id) => {
    seq += 1;
    const repo = ds.getRepository(Category);
    const saved = await repo.save(repo.create({ name: `Cat ${seq}`, slug: `cat-${seq}`, businessId, sortOrder, ...extra }));
    await new Promise((resolve) => setTimeout(resolve, 5)); // distinct created_at: the tie-break of equal values is deterministic
    return saved;
  };
  const wipe = async (businessId: string) => {
    await ds.query(`DELETE FROM products WHERE business_id = $1`, [businessId]);
    await ds.query(`DELETE FROM categories WHERE business_id = $1`, [businessId]);
  };
  const listed = async (token = tokens.a, query = '') => (await http().get(`/categories/admin${query}`).set(as(token)).expect(200)).body as Array<{ id: string; sortOrder: number; active: boolean; name: string }>;
  const orderOf = (rows: Array<{ id: string }>) => rows.map((r) => r.id);
  const state = async (businessId: string) => (await ds.query(`SELECT id, sort_order AS "sortOrder", active, updated_at AS upd FROM categories WHERE business_id = $1 AND deleted_at IS NULL ORDER BY sort_order, created_at, id`, [businessId])) as Array<{ id: string; sortOrder: number; active: boolean; upd: Date }>;
  const audits = (businessId: string) => ds.query(`SELECT action, user_email, entity_id, metadata FROM audit_logs WHERE business_id = $1 AND action = 'CATEGORY_REORDERED' ORDER BY created_at, id`, [businessId]) as Promise<Array<{ action: string; user_email: string; entity_id: string; metadata: { orderedIds: string[] } }>>;
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
    bizA = await businessRepo.save(businessRepo.create({ name: 'Order A', slug: 'order-a' }));
    bizB = await businessRepo.save(businessRepo.create({ name: 'Order B', slug: 'order-b' }));
    bizC = await businessRepo.save(businessRepo.create({ name: 'Order C', slug: 'order-c' }));
    const userRepo = ds.getRepository(User);
    const passwordHash = await bcrypt.hash(PASSWORD, TEST_BCRYPT_COST);
    await userRepo.save([
      userRepo.create({ email: 'a@order.test', passwordHash, role: UserRole.ADMIN, businessId: bizA.id }),
      userRepo.create({ email: 'b@order.test', passwordHash, role: UserRole.ADMIN, businessId: bizB.id }),
      userRepo.create({ email: 'c@order.test', passwordHash, role: UserRole.ADMIN, businessId: bizC.id }),
      userRepo.create({ email: 'super@order.test', passwordHash, role: UserRole.SUPER_ADMIN, businessId: null }),
    ]);
    tokens.a = await login('a@order.test');
    tokens.b = await login('b@order.test');
    tokens.c = await login('c@order.test');
    tokens.super = await login('super@order.test');
  }, 90_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.close();
    await testDb?.stop();
  });

  describe('PUT /categories/order', () => {
    it('401 without a session; the order is saved for the ADMIN\'s own restaurant, answered as the admin list (active AND inactive, 1..n), and survives a reload', async () => {
      await wipe(bizA.id);
      const [c1, c2, c3, c4] = [await add(1), await add(2, { active: false }), await add(3), await add(4)];
      await http().put('/categories/order').send({ orderedIds: [c1.id], expectedIds: [c1.id] }).expect(401);

      const next = [c2.id, c1.id, c4.id, c3.id];
      const res = await reorder({ orderedIds: next, expectedIds: [c1.id, c2.id, c3.id, c4.id] }).expect(200);
      expect(res.body.map((r: { id: string; sortOrder: number }) => [r.id, r.sortOrder])).toEqual(next.map((id, i) => [id, i + 1]));
      expect(res.body.find((r: { id: string }) => r.id === c2.id)).toMatchObject({ active: false }); // inactive ones are part of the order too
      // persistence: what the admin list returns now, and the stored values
      expect(orderOf(await listed())).toEqual(next);
      expect((await state(bizA.id)).map((r) => r.sortOrder)).toEqual([1, 2, 3, 4]);
    });

    it('repeated initial values (all 0, as the old form created them) and values with gaps become 1..n, in the order the lists were showing', async () => {
      await wipe(bizA.id);
      const [a, b, c] = [await add(0), await add(0), await add(0)];
      const shown = orderOf(await listed());
      expect(shown).toEqual([a.id, b.id, c.id]); // ties: created_at, then id
      await reorder({ orderedIds: [a.id, c.id, b.id], expectedIds: shown }).expect(200);
      expect(orderOf(await listed())).toEqual([a.id, c.id, b.id]);
      expect((await state(bizA.id)).map((r) => r.sortOrder)).toEqual([1, 2, 3]);

      await wipe(bizA.id);
      const [x, y, z] = [await add(10), await add(20), await add(35)];
      await reorder({ orderedIds: [z.id, x.id, y.id], expectedIds: [x.id, y.id, z.id] }).expect(200);
      expect(await state(bizA.id)).toMatchObject([{ id: z.id, sortOrder: 1 }, { id: x.id, sortOrder: 2 }, { id: y.id, sortOrder: 3 }]);
    });

    it('consecutive moves (up, up, down) keep the list consistent each time; the public menu shows only the active ones, in that order', async () => {
      await wipe(bizA.id);
      const ids = (await Promise.all([1, 2, 3, 4].map((n) => add(n, n === 2 ? { active: false } : {})))).map((c) => c.id);
      let current = ids;
      for (const move of [[3, 2], [2, 1], [0, 1]]) {
        const next = [...current];
        [next[move[0]], next[move[1]]] = [next[move[1]], next[move[0]]];
        await reorder({ orderedIds: next, expectedIds: current }).expect(200);
        current = next;
        expect(orderOf(await listed())).toEqual(current);
        expect((await state(bizA.id)).map((r) => r.sortOrder)).toEqual([1, 2, 3, 4]);
      }
      const pub = (await http().get('/categories').query({ businessSlug: 'order-a' }).expect(200)).body as Array<{ id: string }>;
      expect(orderOf(pub)).toEqual(current.filter((id) => id !== ids[1])); // the inactive one is not public; the rest keep the admin's order
    });

    it('does not touch products (any of their columns, sort order included), nor another restaurant, nor names / flags of the categories', async () => {
      await wipe(bizA.id);
      await wipe(bizB.id);
      const [c1, c2] = [await add(1), await add(2)];
      const other = [await add(7, {}, bizB.id), await add(3, {}, bizB.id)];
      const products = ds.getRepository(Product);
      await products.save([products.create({ name: 'P1', price: 1000, businessId: bizA.id, categoryId: c1.id, sortOrder: 5 }), products.create({ name: 'P2', price: 2000, businessId: bizA.id, categoryId: c2.id, sortOrder: 5 })]);
      const snapshot = async () => ({
        products: await ds.query(`SELECT * FROM products WHERE business_id = $1 ORDER BY name`, [bizA.id]),
        other: await state(bizB.id),
        names: await ds.query(`SELECT id, name, slug, active, business_id FROM categories WHERE business_id = $1 ORDER BY id`, [bizA.id]),
      });
      const before = await snapshot();
      await reorder({ orderedIds: [c2.id, c1.id], expectedIds: [c1.id, c2.id] }).expect(200);
      expect(await snapshot()).toEqual(before);
      expect(other).toHaveLength(2);
    });

    it('writes nothing, and audits nothing, when the order is already the one asked', async () => {
      await wipe(bizA.id);
      const [c1, c2] = [await add(1), await add(2)];
      const before = await state(bizA.id);
      const audited = (await audits(bizA.id)).length;
      await reorder({ orderedIds: [c1.id, c2.id], expectedIds: [c1.id, c2.id] }).expect(200);
      expect(await state(bizA.id)).toEqual(before); // sort_order AND updated_at untouched
      expect(await settleAudit(bizA.id, audited)).toHaveLength(audited);
    });

    it('audits one CATEGORY_REORDERED per real change, against the restaurant, with the actor and the new order', async () => {
      await wipe(bizB.id);
      const [c1, c2] = [await add(1, {}, bizB.id), await add(2, {}, bizB.id)];
      await reorder({ orderedIds: [c2.id, c1.id], expectedIds: [c1.id, c2.id] }, tokens.b).expect(200);
      const log = await settleAudit(bizB.id, 1);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ action: 'CATEGORY_REORDERED', user_email: 'b@order.test', entity_id: bizB.id });
      expect(log[0].metadata.orderedIds).toEqual([c2.id, c1.id]);
    });

    it('validation: malformed bodies are 400; duplicate, unknown, foreign or missing ids are 400 CATEGORY_ORDER_INVALID with ONE answer for unknown and foreign; nothing is written', async () => {
      await wipe(bizA.id);
      await wipe(bizB.id);
      const [c1, c2, c3] = [await add(1), await add(2), await add(3)];
      const foreign = await add(1, {}, bizB.id);
      const expectedIds = [c1.id, c2.id, c3.id];
      const before = await state(bizA.id);
      const beforeB = await state(bizB.id);

      for (const body of [{}, { orderedIds: [], expectedIds }, { orderedIds: expectedIds }, { expectedIds }, { orderedIds: 'x', expectedIds }, { orderedIds: ['nope', c2.id, c3.id], expectedIds }, { orderedIds: [c1.id, c1.id, c2.id], expectedIds }, { orderedIds: expectedIds, expectedIds: [c1.id, c1.id, c2.id] }, { orderedIds: expectedIds, expectedIds, extra: 1 }]) {
        await reorder(body).expect(400);
      }
      const invalid = (orderedIds: string[]) => reorder({ orderedIds, expectedIds }).expect(400);
      const unknown = await invalid([c1.id, c2.id, UNKNOWN]);
      const alien = await invalid([c1.id, c2.id, foreign.id]); // a category of ANOTHER restaurant
      const missing = await invalid([c1.id, c2.id]);
      const extra = await invalid([c1.id, c2.id, c3.id, UNKNOWN]);
      for (const res of [unknown, alien, missing, extra]) expect(res.body).toMatchObject({ errorCode: 'CATEGORY_ORDER_INVALID' });
      expect(alien.body).toEqual(unknown.body); // the endpoint reveals nothing about other restaurants
      expect(await state(bizA.id)).toEqual(before);
      expect(await state(bizB.id)).toEqual(beforeB);
    });

    it('a soft-deleted category is not part of the order (and cannot be sent as one)', async () => {
      await wipe(bizA.id);
      const [c1, c2, c3] = [await add(1), await add(2), await add(3)];
      await ds.query(`UPDATE categories SET deleted_at = now() WHERE id = $1`, [c2.id]);
      await reorder({ orderedIds: [c3.id, c1.id], expectedIds: [c1.id, c3.id] }).expect(200);
      expect(orderOf(await listed())).toEqual([c3.id, c1.id]);
      const res = await reorder({ orderedIds: [c3.id, c2.id, c1.id], expectedIds: [c3.id, c1.id] }).expect(400);
      expect(res.body.errorCode).toBe('CATEGORY_ORDER_INVALID');
    });

    it('STATE EXPECTED: a stale list is a recoverable 409 CATEGORY_ORDER_CONFLICT (nothing written) after a reorder, a creation or a deletion by someone else', async () => {
      await wipe(bizA.id);
      const [c1, c2, c3] = [await add(1), await add(2), await add(3)];
      const seen = [c1.id, c2.id, c3.id];

      // someone else reorders first
      await reorder({ orderedIds: [c3.id, c2.id, c1.id], expectedIds: seen }).expect(200);
      const afterOther = await state(bizA.id);
      const stale = await reorder({ orderedIds: [c2.id, c1.id, c3.id], expectedIds: seen }).expect(409);
      expect(stale.body).toMatchObject({ errorCode: 'CATEGORY_ORDER_CONFLICT' });
      expect(await state(bizA.id)).toEqual(afterOther);

      // someone creates one meanwhile (the caller's list lacks it)
      const current = orderOf(await listed());
      const made = await create({ name: 'Nueva', slug: 'nueva-x' }).expect(201);
      await reorder({ orderedIds: [...current].reverse(), expectedIds: current }).expect(409);

      // someone deletes one meanwhile
      const withNew = orderOf(await listed());
      await http().delete(`/categories/${made.body.id}`).set(as(tokens.a)).expect(204);
      await reorder({ orderedIds: [...withNew].reverse(), expectedIds: withNew }).expect(409);

      // recovery: re-read and the same move works
      const reread = orderOf(await listed());
      await reorder({ orderedIds: [...reread].reverse(), expectedIds: reread }).expect(200);
      expect(orderOf(await listed())).toEqual([...reread].reverse());
    });

    it('ROLLBACK: if the write fails half way, nothing of that operation stays (a trigger makes the UPDATE of one row fail)', async () => {
      await wipe(bizA.id);
      const [c1, c2, c3] = [await add(0), await add(0), await add(0)];
      const before = await state(bizA.id);
      const audited = (await audits(bizA.id)).length;
      await ds.query(`CREATE FUNCTION fail_on_boom() RETURNS trigger AS $$ BEGIN IF NEW.id = '${c3.id}'::uuid THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
      await ds.query(`CREATE TRIGGER boom BEFORE UPDATE ON categories FOR EACH ROW EXECUTE FUNCTION fail_on_boom()`);
      try {
        const res = await reorder({ orderedIds: [c3.id, c2.id, c1.id], expectedIds: [c1.id, c2.id, c3.id] });
        expect(res.status).toBe(500);
        expect(await state(bizA.id)).toEqual(before); // not even the rows updated before the failing one
        expect(await settleAudit(bizA.id, audited)).toHaveLength(audited); // and no audit row for an operation that did not happen
      } finally {
        await ds.query(`DROP TRIGGER boom ON categories`);
        await ds.query(`DROP FUNCTION fail_on_boom()`);
      }
      // and the same request works once the failure is gone
      await reorder({ orderedIds: [c3.id, c2.id, c1.id], expectedIds: [c1.id, c2.id, c3.id] }).expect(200);
    });
  });

  describe('which restaurant', () => {
    it('an ADMIN only reorders their own: ?businessId= is ignored, and the ids of another restaurant are "invalid"', async () => {
      await wipe(bizA.id);
      await wipe(bizB.id);
      const [a1, a2] = [await add(1), await add(2)];
      const [b1, b2] = [await add(1, {}, bizB.id), await add(2, {}, bizB.id)];
      const beforeB = await state(bizB.id);
      // pointing at B does not make an ADMIN of A act on B ...
      const res = await reorder({ orderedIds: [b2.id, b1.id], expectedIds: [b1.id, b2.id] }, tokens.a, `?businessId=${bizB.id}`).expect(409); // A's list is a1, a2: B's ids are not "what A saw"
      expect(res.body.errorCode).toBe('CATEGORY_ORDER_CONFLICT');
      expect(await state(bizB.id)).toEqual(beforeB);
      // ... and with A's own expectation, B's ids are rejected as invalid
      await reorder({ orderedIds: [b2.id, b1.id], expectedIds: [a1.id, a2.id] }, tokens.a, `?businessId=${bizB.id}`).expect(400);
      // the same query on A's own ids reorders A, not B
      await reorder({ orderedIds: [a2.id, a1.id], expectedIds: [a1.id, a2.id] }, tokens.a, `?businessId=${bizB.id}`).expect(200);
      expect(orderOf(await listed())).toEqual([a2.id, a1.id]);
      expect(await state(bizB.id)).toEqual(beforeB);
    });

    it('a SUPER_ADMIN must name the restaurant (400 without ?businessId=) and reorders exactly the one named, A or B', async () => {
      await wipe(bizA.id);
      await wipe(bizB.id);
      const [a1, a2] = [await add(1), await add(2)];
      const [b1, b2] = [await add(1, {}, bizB.id), await add(2, {}, bizB.id)];
      await reorder({ orderedIds: [a2.id, a1.id], expectedIds: [a1.id, a2.id] }, tokens.super).expect(400);
      await reorder({ orderedIds: [a2.id, a1.id], expectedIds: [a1.id, a2.id] }, tokens.super, `?businessId=${bizA.id}`).expect(200);
      expect(orderOf(await state(bizA.id))).toEqual([a2.id, a1.id]);
      expect(orderOf(await state(bizB.id))).toEqual([b1.id, b2.id]);
      await reorder({ orderedIds: [b2.id, b1.id], expectedIds: [b1.id, b2.id] }, tokens.super, `?businessId=${bizB.id}`).expect(200);
      expect(orderOf(await state(bizB.id))).toEqual([b2.id, b1.id]);
      expect(orderOf(await state(bizA.id))).toEqual([a2.id, a1.id]);
      // A's ids sent for B (with B's real list as the expectation): invalid, never applied to A
      await reorder({ orderedIds: [a1.id, a2.id], expectedIds: [b2.id, b1.id] }, tokens.super, `?businessId=${bizB.id}`).expect(400);
      expect(orderOf(await state(bizA.id))).toEqual([a2.id, a1.id]);
      await reorder({ orderedIds: [a1.id, a2.id], expectedIds: [b2.id, b1.id] }, tokens.super, `?businessId=${UNKNOWN}`).expect(404);
    });

    it('a suspended restaurant: its ADMIN cannot reorder (403), a SUPER_ADMIN can', async () => {
      await wipe(bizC.id);
      const [c1, c2] = [await add(1, {}, bizC.id), await add(2, {}, bizC.id)];
      await ds.query(`UPDATE businesses SET active = false WHERE id = $1`, [bizC.id]);
      try {
        await reorder({ orderedIds: [c2.id, c1.id], expectedIds: [c1.id, c2.id] }, tokens.c).expect(403);
        expect(orderOf(await state(bizC.id))).toEqual([c1.id, c2.id]);
        await reorder({ orderedIds: [c2.id, c1.id], expectedIds: [c1.id, c2.id] }, tokens.super, `?businessId=${bizC.id}`).expect(200);
      } finally {
        await ds.query(`UPDATE businesses SET active = true WHERE id = $1`, [bizC.id]);
      }
    });
  });

  describe('a new category goes last', () => {
    it('POST without sortOrder takes the next position (active and inactive counted, deleted ones not); the first one of a restaurant is 1', async () => {
      await wipe(bizB.id);
      const first = await create({ name: 'Primera', slug: 'primera' }, tokens.b).expect(201);
      expect(first.body.sortOrder).toBe(1);
      const second = await create({ name: 'Segunda', slug: 'segunda' }, tokens.b).expect(201);
      expect(second.body.sortOrder).toBe(2);
      await http().patch(`/categories/${second.body.id}`).set(as(tokens.b)).send({ active: false }).expect(200);
      expect((await create({ name: 'Tercera', slug: 'tercera' }, tokens.b).expect(201)).body.sortOrder).toBe(3);
      // gaps and repeated old values: after the highest one
      await ds.query(`UPDATE categories SET sort_order = 40 WHERE id = $1`, [first.body.id]);
      expect((await create({ name: 'Cuarta', slug: 'cuarta' }, tokens.b).expect(201)).body.sortOrder).toBe(41);
      // a deleted category does not hold the position
      const last = await create({ name: 'Quinta', slug: 'quinta' }, tokens.b).expect(201);
      expect(last.body.sortOrder).toBe(42);
      await http().delete(`/categories/${last.body.id}`).set(as(tokens.b)).expect(204);
      expect((await create({ name: 'Sexta', slug: 'sexta' }, tokens.b).expect(201)).body.sortOrder).toBe(42);
      // never another restaurant's values
      await wipe(bizA.id);
      await add(99);
      expect((await create({ name: 'Solo mia', slug: 'solo-mia' }, tokens.b).expect(201)).body.sortOrder).toBe(43);
    });

    it('an explicit sortOrder is still honoured (older clients and scripts), 0 included; a SUPER_ADMIN creating names the restaurant as before', async () => {
      await wipe(bizB.id);
      expect((await create({ name: 'Con orden', slug: 'con-orden', sortOrder: 0 }, tokens.b).expect(201)).body.sortOrder).toBe(0);
      expect((await create({ name: 'Con orden 9', slug: 'con-orden-9', sortOrder: 9 }, tokens.b).expect(201)).body.sortOrder).toBe(9);
      const bySuper = await create({ name: 'Del super', slug: 'del-super', businessId: bizB.id }, tokens.super).expect(201);
      expect(bySuper.body.sortOrder).toBe(10);
    });

    it('simultaneous creations never share a position; the list shows them in creation order', async () => {
      await wipe(bizB.id);
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => create({ name: `Nueva ${i}`, slug: `nueva-${i}` }, tokens.b)));
      for (const r of results) expect(r.status).toBe(201);
      expect(results.map((r) => r.body.sortOrder).sort((x: number, y: number) => x - y)).toEqual([1, 2, 3, 4, 5, 6]);
      expect((await state(bizB.id)).map((r) => r.sortOrder)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('the public menu (also what the table QR menu reads) shows the new category last', async () => {
      await wipe(bizB.id);
      await create({ name: 'Uno', slug: 'uno' }, tokens.b).expect(201);
      await create({ name: 'Dos', slug: 'dos' }, tokens.b).expect(201);
      const pub = (await http().get('/categories').query({ businessSlug: 'order-b' }).expect(200)).body as Array<{ name: string }>;
      expect(pub.map((c) => c.name)).toEqual(['Uno', 'Dos']);
    });
  });
});
