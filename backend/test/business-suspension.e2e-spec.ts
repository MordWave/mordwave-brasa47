import bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AuditLog } from '../src/audit/audit-log.entity.js';
import { Business } from '../src/business/business.entity.js';
import { Category } from '../src/category/category.entity.js';
import { Order } from '../src/order/order.entity.js';
import { Product } from '../src/product/product.entity.js';
import { RestaurantTable } from '../src/table/table.entity.js';
import { TableSession } from '../src/table/table-session.entity.js';
import { generateOpaqueToken } from '../src/table/token.util.js';
import { User } from '../src/user/user.entity.js';
import { UserRole } from '../src/user/user-role.enum.js';
import { runAllMigrations } from './support/run-all-migrations.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

const TEST_BCRYPT_COST = 4;

// Real-database proof that Business.active (a suspended restaurant) is enforced where it matters: ADMIN access
// (login and tokens issued before the suspension), customer join/status/orders, and opening table sessions — while
// SUPER_ADMIN keeps working and nothing is deleted. There is no endpoint to suspend a business yet (that is the next
// phase), so the test flips the column directly, exactly what an operator with SQL would do today.
//
// What this does NOT prove: genuine concurrency. PGlite is one Postgres session behind one socket, so truly
// concurrent transactions are not representable here (see businesses-create.e2e-spec.ts). The lock order
// Business -> RestaurantTable -> TableSession and the read-under-lock are verified deterministically in the unit
// specs (order.service.spec.ts, table-session.service.spec.ts); here only that the locking statements run correctly
// against a real Postgres engine and that the rules hold end to end.
describe('Business.active enforcement (e2e, real local Postgres)', () => {
  let testDb: TestDatabase;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let jwt: JwtService;

  let bizA: Business; // the one that gets suspended
  let bizB: Business; // stays active throughout
  let tableA: RestaurantTable;
  let tableA2: RestaurantTable;
  let tableB: RestaurantTable;
  let productA: Product;
  let productB: Product;

  const password = 'Sup3rSecret!Pass';
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  let adminAToken: string; // obtained by a real login BEFORE the suspension
  let adminBToken: string;
  let superToken: string;
  let sessionTokenA: string; // customer's token for tableA, obtained through the public join
  let sessionTokenB: string;

  const http = () => request(app.getHttpServer());
  const setActive = (id: string, active: boolean) => dataSource.getRepository(Business).update(id, { active });
  const orderBody = (sessionToken: string, productId: string) => ({
    sessionToken,
    clientRequestId: randomUUID(),
    items: [{ productId, quantity: 1, removed: [], added: [] }],
  });
  const countOrders = (businessId: string) => dataSource.getRepository(Order).count({ where: { businessId } });

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
    process.env.MEDIA_PUBLIC_BASE_URL = 'https://api.example.com';

    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = moduleFixture.get(DataSource);
    jwt = moduleFixture.get(JwtService);
    await runAllMigrations(dataSource);

    const businessRepo = dataSource.getRepository(Business);
    const userRepo = dataSource.getRepository(User);
    const tableRepo = dataSource.getRepository(RestaurantTable);
    const categoryRepo = dataSource.getRepository(Category);
    const productRepo = dataSource.getRepository(Product);

    bizA = await businessRepo.save(businessRepo.create({ name: 'Negocio A', slug: 'negocio-a' }));
    bizB = await businessRepo.save(businessRepo.create({ name: 'Negocio B', slug: 'negocio-b' }));
    const seedMenu = async (biz: Business, suffix: string) => {
      const cat = await categoryRepo.save(categoryRepo.create({ name: `Cat ${suffix}`, slug: `cat-${suffix}`, businessId: biz.id }));
      return productRepo.save(productRepo.create({ name: `Prod ${suffix}`, price: 5000, categoryId: cat.id, businessId: biz.id }));
    };
    productA = await seedMenu(bizA, 'a');
    productB = await seedMenu(bizB, 'b');
    tableA = await tableRepo.save(tableRepo.create({ name: 'Mesa A1', businessId: bizA.id, qrToken: generateOpaqueToken() }));
    tableA2 = await tableRepo.save(tableRepo.create({ name: 'Mesa A2', businessId: bizA.id, qrToken: generateOpaqueToken() }));
    tableB = await tableRepo.save(tableRepo.create({ name: 'Mesa B1', businessId: bizB.id, qrToken: generateOpaqueToken() }));

    const passwordHash = await bcrypt.hash(password, TEST_BCRYPT_COST);
    const adminA = await userRepo.save(userRepo.create({ email: 'admin-a@suspension.test', passwordHash, role: UserRole.ADMIN, businessId: bizA.id }));
    const adminB = await userRepo.save(userRepo.create({ email: 'admin-b@suspension.test', passwordHash, role: UserRole.ADMIN, businessId: bizB.id }));
    const superAdmin = await userRepo.save(userRepo.create({ email: 'root@suspension.test', passwordHash, role: UserRole.SUPER_ADMIN, businessId: null }));

    // The login endpoint is rate limited to 5 per minute, so only ADMIN A really logs in (the token that must stop
    // working after the suspension); the other identities get a token signed with the same claims the login uses.
    adminAToken = (await http().post('/auth/login').send({ email: adminA.email, password }).expect(200)).body.accessToken;
    const sign = (u: User) => jwt.signAsync({ sub: u.id, email: u.email, role: u.role, businessId: u.businessId });
    adminBToken = await sign(adminB);
    superToken = await sign(superAdmin);

    // Open one session per business through the real admin endpoint and let the customer join, as in production.
    await http().post(`/tables/${tableA.id}/sessions`).set(bearer(adminAToken)).expect(201);
    await http().post(`/tables/${tableB.id}/sessions`).set(bearer(adminBToken)).expect(201);
    sessionTokenA = (await http().post('/table-sessions/join').send({ qrToken: tableA.qrToken }).expect(200)).body.sessionToken;
    sessionTokenB = (await http().post('/table-sessions/join').send({ qrToken: tableB.qrToken }).expect(200)).body.sessionToken;
  }, 90_000);

  afterAll(async () => {
    delete process.env.MEDIA_PUBLIC_BASE_URL;
    await app?.close();
    await testDb?.stop();
  });

  describe('active business: no regression', () => {
    it('ADMIN works exactly as before (JWT from a real login)', async () => {
      await http().get('/auth/me').set(bearer(adminAToken)).expect(200);
      const me = await http().get('/businesses/me').set(bearer(adminAToken)).expect(200);
      expect(me.body).toMatchObject({ id: bizA.id, active: true });
      await http().get('/tables/admin').set(bearer(adminAToken)).expect(200);
      await http().get('/orders/admin').set(bearer(adminAToken)).expect(200);
    });

    it('a customer can join, poll and order (this runs the Business FOR SHARE + Table + Session locks on a real engine)', async () => {
      const status = await http().post('/table-sessions/status').send({ sessionToken: sessionTokenA }).expect(200);
      expect(status.body).toEqual({ open: true });

      const res = await http().post('/orders').send(orderBody(sessionTokenA, productA.id)).expect(201);
      expect(res.body.businessId).toBe(bizA.id);
      expect(await countOrders(bizA.id)).toBe(1);
    });

    it('opening a session on an active business still works (second table)', async () => {
      await http().post(`/tables/${tableA2.id}/sessions`).set(bearer(adminAToken)).expect(201);
      await http().patch(`/tables/${tableA2.id}/sessions/current`).set(bearer(adminAToken)).expect(200); // close it again
    });
  });

  describe('business A suspended (active = false)', () => {
    let ordersBefore: number;
    let auditBefore: number;
    let productsBefore: number;
    let usersBefore: number;

    beforeAll(async () => {
      ordersBefore = await countOrders(bizA.id);
      auditBefore = await dataSource.getRepository(AuditLog).count({ where: { businessId: bizA.id } });
      productsBefore = await dataSource.getRepository(Product).count({ where: { businessId: bizA.id } });
      usersBefore = await dataSource.getRepository(User).count({ where: { businessId: bizA.id } });
      await setActive(bizA.id, false);
    });

    describe('ADMIN of the suspended business', () => {
      it('the JWT issued BEFORE the suspension stops authorizing: 403 BUSINESS_INACTIVE on admin routes', async () => {
        for (const path of ['/businesses/me', '/tables/admin', '/orders/admin', '/products/admin', '/categories/admin', '/audit-logs']) {
          const res = await http().get(path).set(bearer(adminAToken));
          expect(res.status, path).toBe(403);
          expect(res.body.errorCode, path).toBe('BUSINESS_INACTIVE');
        }
        await http().patch('/businesses/me').set(bearer(adminAToken)).send({ name: 'Hack' }).expect(403);
      });

      it('403, not 401: the session is not mistaken for an expired one', async () => {
        const res = await http().get('/businesses/me').set(bearer(adminAToken));
        expect(res.status).toBe(403);
        expect(res.status).not.toBe(401);
      });

      it('cannot open table sessions', async () => {
        const res = await http().post(`/tables/${tableA2.id}/sessions`).set(bearer(adminAToken)).expect(403);
        expect(res.body.errorCode).toBe('BUSINESS_INACTIVE');
      });

      it('login: correct password -> 403 BUSINESS_INACTIVE and no token', async () => {
        const res = await http().post('/auth/login').send({ email: 'admin-a@suspension.test', password }).expect(403);
        expect(res.body.errorCode).toBe('BUSINESS_INACTIVE');
        expect(res.body.accessToken).toBeUndefined();
      });

      it('login: wrong password -> the generic 401, the suspension is not revealed', async () => {
        const res = await http().post('/auth/login').send({ email: 'admin-a@suspension.test', password: 'Wrong-Pass-1!' }).expect(401);
        expect(res.body.errorCode).toBeUndefined();
        expect(JSON.stringify(res.body)).not.toMatch(/suspend|inactive/i);
      });

      it('an unknown token is still 401 (user.active and business.active are different things)', async () => {
        await http().get('/businesses/me').set(bearer('not-a-jwt')).expect(401);
      });
    });

    describe('the other business and the SUPER_ADMIN', () => {
      it('ADMIN of business B is unaffected', async () => {
        await http().get('/businesses/me').set(bearer(adminBToken)).expect(200);
        await http().get('/tables/admin').set(bearer(adminBToken)).expect(200);
        await http().post('/orders').send(orderBody(sessionTokenB, productB.id)).expect(201);
      });

      it('SUPER_ADMIN keeps administering the suspended business (reads and writes, with ?businessId=)', async () => {
        const me = await http().get(`/businesses/me?businessId=${bizA.id}`).set(bearer(superToken)).expect(200);
        expect(me.body).toMatchObject({ id: bizA.id, active: false });
        await http().get(`/tables/admin?businessId=${bizA.id}`).set(bearer(superToken)).expect(200);
        await http().get(`/orders/admin?businessId=${bizA.id}`).set(bearer(superToken)).expect(200);
        await http().get(`/products/admin?businessId=${bizA.id}`).set(bearer(superToken)).expect(200);
        await http().patch(`/businesses/me?businessId=${bizA.id}`).set(bearer(superToken)).send({ hours: 'Reabre pronto' }).expect(200);
      });

      it('SUPER_ADMIN can still list the suspended business for the picker, flagged inactive', async () => {
        const res = await http().get('/businesses?active=false').set(bearer(superToken)).expect(200);
        expect(res.body.items.map((b: { id: string }) => b.id)).toContain(bizA.id);
      });

      it('but not even a SUPER_ADMIN can open a customer session on it', async () => {
        const res = await http().post(`/tables/${tableA2.id}/sessions?businessId=${bizA.id}`).set(bearer(superToken)).expect(403);
        expect(res.body.errorCode).toBe('BUSINESS_INACTIVE');
        expect(await dataSource.getRepository(TableSession).count({ where: { tableId: tableA2.id } })).toBe(1); // only the one closed earlier
      });
    });

    describe('customers', () => {
      it('join (a new session) is refused with the vague TABLE_SESSION_UNAVAILABLE, no token', async () => {
        const res = await http().post('/table-sessions/join').send({ qrToken: tableA.qrToken }).expect(404);
        expect(res.body.errorCode).toBe('TABLE_SESSION_UNAVAILABLE');
        expect(JSON.stringify(res.body)).not.toMatch(/sessionToken|suspend|BUSINESS_INACTIVE/);
      });

      it('a customer already seated: status reports the session over', async () => {
        const res = await http().post('/table-sessions/status').send({ sessionToken: sessionTokenA }).expect(200);
        expect(res.body).toEqual({ open: false });
      });

      it('POST /orders with a still-open session token is refused with TABLE_SESSION_UNAVAILABLE and creates nothing', async () => {
        const before = await countOrders(bizA.id);
        const res = await http().post('/orders').send(orderBody(sessionTokenA, productA.id)).expect(404);
        expect(res.body.errorCode).toBe('TABLE_SESSION_UNAVAILABLE');
        expect(await countOrders(bizA.id)).toBe(before);
      });

      it('an idempotent retry of an order placed before the suspension does not return it either', async () => {
        const existing = await dataSource.getRepository(Order).findOneOrFail({ where: { businessId: bizA.id } });
        const retry = { sessionToken: sessionTokenA, clientRequestId: existing.clientRequestId, items: [{ productId: productA.id, quantity: 1, removed: [], added: [] }] };
        await http().post('/orders').send(retry).expect(404);
      });

      it('the public menu of the suspended business is gone (404), the other one is served', async () => {
        await http().get('/categories?businessSlug=negocio-a').expect(404);
        await http().get('/products?businessSlug=negocio-a').expect(404);
        const ok = await http().get('/products?businessSlug=negocio-b').expect(200);
        expect(ok.body).toHaveLength(1);
      });

      it('business B customers are unaffected (join and order)', async () => {
        await http().post('/table-sessions/join').send({ qrToken: tableB.qrToken }).expect(200);
        await http().post('/orders').send(orderBody(sessionTokenB, productB.id)).expect(201);
      });
    });

    it('nothing was deleted: orders, audit trail, products and users are all still there', async () => {
      expect(await countOrders(bizA.id)).toBe(ordersBefore);
      expect(await dataSource.getRepository(AuditLog).count({ where: { businessId: bizA.id } })).toBeGreaterThanOrEqual(auditBefore);
      expect(await dataSource.getRepository(Product).count({ where: { businessId: bizA.id } })).toBe(productsBefore);
      expect(await dataSource.getRepository(User).count({ where: { businessId: bizA.id } })).toBe(usersBefore);
      expect(await dataSource.getRepository(RestaurantTable).count({ where: { businessId: bizA.id } })).toBe(2);
    });
  });

  describe('business A reactivated', () => {
    beforeAll(async () => {
      await setActive(bizA.id, true);
    });

    it('the same JWT works again and a fresh login succeeds', async () => {
      await http().get('/businesses/me').set(bearer(adminAToken)).expect(200);
      const login = await http().post('/auth/login').send({ email: 'admin-a@suspension.test', password }).expect(200);
      expect(login.body.accessToken).toEqual(expect.any(String));
    });

    it('customers can join and order again; a session closed by the ADMIN is not reopened by reactivation', async () => {
      await http().patch(`/tables/${tableA.id}/sessions/current`).set(bearer(adminAToken)).expect(200); // close the old one
      expect((await http().post('/table-sessions/status').send({ sessionToken: sessionTokenA }).expect(200)).body).toEqual({ open: false });

      await http().post(`/tables/${tableA.id}/sessions`).set(bearer(adminAToken)).expect(201);
      const joined = await http().post('/table-sessions/join').send({ qrToken: tableA.qrToken }).expect(200);
      expect(joined.body.sessionToken).not.toBe(sessionTokenA);
      await http().post('/orders').send(orderBody(joined.body.sessionToken, productA.id)).expect(201);
    });

    it('the public menu is back', async () => {
      await http().get('/categories?businessSlug=negocio-a').expect(200);
    });
  });
});
