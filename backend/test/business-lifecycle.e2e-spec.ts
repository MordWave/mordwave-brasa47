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
import { TableSessionStatus } from '../src/table/table-session-status.enum.js';
import { generateOpaqueToken } from '../src/table/token.util.js';
import { User } from '../src/user/user.entity.js';
import { UserRole } from '../src/user/user-role.enum.js';
import { runAllMigrations } from './support/run-all-migrations.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

const TEST_BCRYPT_COST = 4;

// Real-database proof of the SUPER_ADMIN business lifecycle: GET/PATCH /businesses/:id and POST
// /businesses/:id/deactivate|activate. Same isolation as the other e2e files (ephemeral local PGlite).
//
// What this proves: contracts, transaction atomicity (a real rollback via a failing trigger), the pending-order rule,
// session closing, idempotence, audit and cache invalidation. What it does NOT prove: genuine concurrency. PGlite is one
// Postgres session behind one socket, so truly concurrent transactions are not representable; the ordering that the
// Business row lock gives (and the lock order) is covered deterministically in business-lifecycle.service.spec.ts.
describe('Business lifecycle — SUPER_ADMIN (e2e, real local Postgres)', () => {
  let testDb: TestDatabase;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let jwt: JwtService;

  let bizA: Business;
  let bizB: Business;
  let tableA1: RestaurantTable;
  let tableA2: RestaurantTable;
  let tableB1: RestaurantTable;
  let productA: Product;
  let superId: string;
  let superToken: string;
  let adminAToken: string;
  let adminBToken: string;

  const password = 'Sup3rSecret!Pass';
  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const get = (path: string, token: string | null = superToken) => (token ? http().get(path).set(bearer(token)) : http().get(path));
  const post = (path: string, body: object = {}, token: string | null = superToken) => {
    const req = http().post(path).send(body);
    return token ? req.set(bearer(token)) : req;
  };
  const patch = (path: string, body: object, token: string | null = superToken) => {
    const req = http().patch(path).send(body);
    return token ? req.set(bearer(token)) : req;
  };
  const openSessions = (businessId: string) =>
    dataSource.getRepository(TableSession).count({ where: { businessId, status: TableSessionStatus.OPEN } });
  const auditOf = (businessId: string, action: string) =>
    dataSource.getRepository(AuditLog).find({ where: { businessId, action }, order: { createdAt: 'ASC' } });
  const businessRow = (id: string) => dataSource.getRepository(Business).findOneByOrFail({ id });

  // Opens a session on a table through the real admin endpoint, then lets a customer join (as in production).
  async function seat(table: RestaurantTable, adminToken: string): Promise<string> {
    await post(`/tables/${table.id}/sessions`, {}, adminToken).expect(201);
    return (await http().post('/table-sessions/join').send({ qrToken: table.qrToken }).expect(200)).body.sessionToken;
  }
  const order = (sessionToken: string) =>
    http()
      .post('/orders')
      .send({ sessionToken, clientRequestId: randomUUID(), items: [{ productId: productA.id, quantity: 1, removed: [], added: [] }] });

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

    bizA = await businessRepo.save(businessRepo.create({ name: 'Negocio A', slug: 'negocio-a', address: 'Calle A 1', phone: '+56 1', hours: 'Lun-Dom' }));
    bizB = await businessRepo.save(businessRepo.create({ name: 'Negocio B', slug: 'negocio-b', address: 'Calle B 1' }));
    const cat = await categoryRepo.save(categoryRepo.create({ name: 'Cat', slug: 'cat', businessId: bizA.id }));
    productA = await productRepo.save(productRepo.create({ name: 'Prod A', price: 5000, categoryId: cat.id, businessId: bizA.id }));
    tableA1 = await tableRepo.save(tableRepo.create({ name: 'Mesa A1', businessId: bizA.id, qrToken: generateOpaqueToken() }));
    tableA2 = await tableRepo.save(tableRepo.create({ name: 'Mesa A2', businessId: bizA.id, qrToken: generateOpaqueToken() }));
    tableB1 = await tableRepo.save(tableRepo.create({ name: 'Mesa B1', businessId: bizB.id, qrToken: generateOpaqueToken() }));

    const passwordHash = await bcrypt.hash(password, TEST_BCRYPT_COST);
    const mk = (email: string, role: UserRole, businessId: string | null) => userRepo.save(userRepo.create({ email, passwordHash, role, businessId }));
    const adminA = await mk('admin-a@lifecycle.test', UserRole.ADMIN, bizA.id);
    const adminB = await mk('admin-b@lifecycle.test', UserRole.ADMIN, bizB.id);
    const superAdmin = await mk('root@lifecycle.test', UserRole.SUPER_ADMIN, null);
    superId = superAdmin.id;
    // Tokens signed with the claims /auth/login uses (the strategy re-reads the user from the DB on every request).
    const sign = (u: User) => jwt.signAsync({ sub: u.id, email: u.email, role: u.role, businessId: u.businessId });
    adminAToken = await sign(adminA);
    adminBToken = await sign(adminB);
    superToken = await sign(superAdmin);
  }, 90_000);

  afterAll(async () => {
    delete process.env.MEDIA_PUBLIC_BASE_URL;
    await app?.close();
    await testDb?.stop();
  });

  describe('authorization (all four endpoints)', () => {
    const calls: Array<[string, (token: string | null) => request.Test]> = [
      ['GET /businesses/:id', (t) => get(`/businesses/${randomUUID()}`, t)],
      ['PATCH /businesses/:id', (t) => patch(`/businesses/${randomUUID()}`, { name: 'x' }, t)],
      ['POST /businesses/:id/deactivate', (t) => post(`/businesses/${randomUUID()}/deactivate`, {}, t)],
      ['POST /businesses/:id/activate', (t) => post(`/businesses/${randomUUID()}/activate`, {}, t)],
    ];

    it.each(calls)('%s: no JWT -> 401, ADMIN -> 403 (even for their own business)', async (_label, call) => {
      await call(null).expect(401);
      await call(adminAToken).expect(403);
    });

    it('an ADMIN cannot read, edit, suspend or reactivate their OWN business through the :id routes', async () => {
      await get(`/businesses/${bizA.id}`, adminAToken).expect(403);
      await patch(`/businesses/${bizA.id}`, { name: 'Mío ahora' }, adminAToken).expect(403);
      await post(`/businesses/${bizA.id}/deactivate`, {}, adminAToken).expect(403);
      await post(`/businesses/${bizA.id}/activate`, {}, adminAToken).expect(403);
      expect(await businessRow(bizA.id)).toMatchObject({ name: 'Negocio A', active: true });
    });

    it('unknown business -> 404 BUSINESS_NOT_FOUND; malformed id -> 400', async () => {
      for (const call of [
        () => get(`/businesses/${randomUUID()}`),
        () => patch(`/businesses/${randomUUID()}`, { name: 'x' }),
        () => post(`/businesses/${randomUUID()}/deactivate`),
        () => post(`/businesses/${randomUUID()}/activate`),
      ]) {
        const res = await call().expect(404);
        expect(res.body.errorCode).toBe('BUSINESS_NOT_FOUND');
      }
      await get('/businesses/not-a-uuid').expect(400);
      await post('/businesses/not-a-uuid/deactivate').expect(400);
    });

    it('GET/PATCH /businesses/me are untouched: ADMIN still works, "me" is never read as an id', async () => {
      const me = await get('/businesses/me', adminAToken).expect(200);
      expect(me.body.id).toBe(bizA.id);
      await patch('/businesses/me', { hours: 'Lun-Dom 12-23' }, adminAToken).expect(200);
      await patch('/businesses/me', { hours: 'Lun-Dom' }, adminAToken).expect(200); // restore
      await get('/businesses/me').expect(400); // SUPER_ADMIN without ?businessId= keeps its old answer
    });
  });

  describe('GET /businesses/:id', () => {
    it('returns any business, inactive ones included, in the presenter shape (no storage key)', async () => {
      const res = await get(`/businesses/${bizB.id}`).expect(200);
      expect(res.body).toMatchObject({ id: bizB.id, slug: 'negocio-b', active: true, logoUrl: null });
      expect(res.body.logoStorageKey).toBeUndefined();
    });
  });

  describe('PATCH /businesses/:id', () => {
    it('edits name, address, phone and hours, trims, and audits the real change with from/to', async () => {
      const res = await patch(`/businesses/${bizB.id}`, { name: '  Negocio B Renovado ', phone: ' +56 9 1111 ', hours: 'Mar-Dom' }).expect(200);
      expect(res.body).toMatchObject({ name: 'Negocio B Renovado', phone: '+56 9 1111', hours: 'Mar-Dom', address: 'Calle B 1', slug: 'negocio-b' });

      const [entry] = await auditOf(bizB.id, 'BUSINESS_UPDATED');
      expect(entry).toMatchObject({
        businessId: bizB.id,
        entityId: bizB.id,
        entityType: 'Business',
        userId: superId,
        userEmail: 'root@lifecycle.test',
      });
      expect(entry!.metadata).toEqual({
        changes: {
          name: { from: 'Negocio B', to: 'Negocio B Renovado' },
          phone: { from: null, to: '+56 9 1111' },
          hours: { from: null, to: 'Mar-Dom' },
        },
      });
    });

    it('a blank or null optional field clears it; the name cannot be cleared', async () => {
      const res = await patch(`/businesses/${bizB.id}`, { phone: '   ', hours: null }).expect(200);
      expect(res.body).toMatchObject({ phone: null, hours: null });
      await patch(`/businesses/${bizB.id}`, { name: '   ' }).expect(400);
      await patch(`/businesses/${bizB.id}`, { name: null }).expect(400);
    });

    it('a PATCH that changes nothing is a 200 with no new audit entry and no new updatedAt', async () => {
      const before = await businessRow(bizB.id);
      const auditBefore = (await auditOf(bizB.id, 'BUSINESS_UPDATED')).length;

      await patch(`/businesses/${bizB.id}`, { name: 'Negocio B Renovado', address: 'Calle B 1' }).expect(200);
      await patch(`/businesses/${bizB.id}`, {}).expect(200);

      expect((await auditOf(bizB.id, 'BUSINESS_UPDATED')).length).toBe(auditBefore);
      expect((await businessRow(bizB.id)).updatedAt.getTime()).toBe(before.updatedAt.getTime());
    });

    it.each([
      ['slug', { slug: 'otro-slug' }],
      ['id', { id: randomUUID() }],
      ['active', { active: false }],
      ['primaryColor', { primaryColor: '#112233' }],
      ['accentColor', { accentColor: '#112233' }],
      ['logoStorageKey', { logoStorageKey: 'businesses/x/logo/y.webp' }],
      ['logoUrl', { logoUrl: 'https://x/y.webp' }],
      ['coverStorageKey', { coverStorageKey: 'businesses/x/cover/y.webp' }],
      ['coverUrl', { coverUrl: 'https://x/y.webp' }],
      ['createdAt', { createdAt: '2020-01-01T00:00:00Z' }],
      ['users', { users: [{ email: 'a@b.c' }] }],
    ])('%s is not editable (400) and nothing changes', async (_field, body) => {
      const before = await businessRow(bizB.id);
      await patch(`/businesses/${bizB.id}`, { name: 'Intento', ...body }).expect(400);
      expect(await businessRow(bizB.id)).toMatchObject({ name: before.name, slug: 'negocio-b', active: true, id: bizB.id });
    });

    it('enforces the same ceilings as PATCH /businesses/me', async () => {
      await patch(`/businesses/${bizB.id}`, { name: 'n'.repeat(121) }).expect(400);
      await patch(`/businesses/${bizB.id}`, { address: 'a'.repeat(201) }).expect(400);
      await patch(`/businesses/${bizB.id}`, { phone: 'p'.repeat(41) }).expect(400);
      await patch(`/businesses/${bizB.id}`, { hours: 'h'.repeat(201) }).expect(400);
    });

    it('does not touch any other business', async () => {
      expect(await businessRow(bizA.id)).toMatchObject({ name: 'Negocio A', address: 'Calle A 1', phone: '+56 1', hours: 'Lun-Dom', active: true });
    });
  });

  describe('deactivate / activate', () => {
    let sessionA1: string;
    let sessionA2: string;
    let sessionB1: string;
    let pendingOrderId: string;

    it('with a pending (NEW) order -> 409 BUSINESS_HAS_PENDING_ORDERS, nothing changes, no session is closed, no audit', async () => {
      sessionA1 = await seat(tableA1, adminAToken);
      sessionA2 = await seat(tableA2, adminAToken);
      sessionB1 = await seat(tableB1, adminBToken);
      pendingOrderId = (await order(sessionA1).expect(201)).body.id;
      const openBefore = await openSessions(bizA.id);

      const res = await post(`/businesses/${bizA.id}/deactivate`, { reason: 'Prueba' }).expect(409);

      expect(res.body.errorCode).toBe('BUSINESS_HAS_PENDING_ORDERS');
      expect(res.body.count).toBe(1);
      expect((await businessRow(bizA.id)).active).toBe(true);
      expect(await openSessions(bizA.id)).toBe(openBefore);
      expect(openBefore).toBe(2);
      expect(await auditOf(bizA.id, 'BUSINESS_DEACTIVATED')).toHaveLength(0);
      await get('/products?businessSlug=negocio-a').expect(200); // still public and serving
    });

    it('rejects forcing the suspension: no acknowledge/force flag exists (400)', async () => {
      await post(`/businesses/${bizA.id}/deactivate`, { acknowledgePendingOrders: true }).expect(400);
      await post(`/businesses/${bizA.id}/deactivate`, { force: true }).expect(400);
      expect((await businessRow(bizA.id)).active).toBe(true);
    });

    it('rollback: a failure while closing sessions undoes the whole suspension (real transaction rollback)', async () => {
      await patch(`/orders/${pendingOrderId}/status`, { status: 'DELIVERED' }, adminAToken).expect(200); // no pending now
      await get('/products?businessSlug=negocio-a').expect(200); // cache the positive resolution
      await dataSource.query(`CREATE FUNCTION zz_fail_session_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced failure'; END $$`);
      await dataSource.query('CREATE TRIGGER zz_fail BEFORE UPDATE ON table_sessions FOR EACH ROW EXECUTE FUNCTION zz_fail_session_update()');
      try {
        const res = await post(`/businesses/${bizA.id}/deactivate`);
        expect(res.status).toBe(500);
      } finally {
        await dataSource.query('DROP TRIGGER zz_fail ON table_sessions');
        await dataSource.query('DROP FUNCTION zz_fail_session_update()');
      }

      expect((await businessRow(bizA.id)).active).toBe(true); // the UPDATE businesses was rolled back
      expect(await openSessions(bizA.id)).toBe(2);
      expect(await auditOf(bizA.id, 'BUSINESS_DEACTIVATED')).toHaveLength(0);
      await get('/products?businessSlug=negocio-a').expect(200);
      await get('/businesses/me', adminAToken).expect(200); // ADMIN not suspended
    });

    it('deactivates (no pending): active=false, ALL its open sessions closed, nothing deleted, audited with reason and count', async () => {
      const ordersBefore = await dataSource.getRepository(Order).count({ where: { businessId: bizA.id } });
      const productsBefore = await dataSource.getRepository(Product).count({ where: { businessId: bizA.id } });
      const tablesBefore = await dataSource.getRepository(RestaurantTable).count({ where: { businessId: bizA.id } });

      const res = await post(`/businesses/${bizA.id}/deactivate`, { reason: '  Falta de pago  ' }).expect(200);

      expect(res.body).toMatchObject({ id: bizA.id, active: false, slug: 'negocio-a' });
      expect(await openSessions(bizA.id)).toBe(0);
      const closed = await dataSource.getRepository(TableSession).find({ where: { businessId: bizA.id } });
      expect(closed.every((s) => s.status === TableSessionStatus.CLOSED && s.closedAt instanceof Date)).toBe(true);

      // nothing was deleted
      expect(await dataSource.getRepository(Order).count({ where: { businessId: bizA.id } })).toBe(ordersBefore);
      expect(await dataSource.getRepository(Product).count({ where: { businessId: bizA.id } })).toBe(productsBefore);
      expect(await dataSource.getRepository(RestaurantTable).count({ where: { businessId: bizA.id } })).toBe(tablesBefore);
      expect(await dataSource.getRepository(User).count({ where: { businessId: bizA.id } })).toBe(1);

      const entries = await auditOf(bizA.id, 'BUSINESS_DEACTIVATED');
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ businessId: bizA.id, entityId: bizA.id, userId: superId, userEmail: 'root@lifecycle.test', metadata: { reason: 'Falta de pago', closedSessions: 2 } });
    });

    it('the suspension is effective everywhere: public menu gone at once (cache invalidated), customers and ADMIN blocked', async () => {
      await get('/products?businessSlug=negocio-a', null).expect(404); // was cached as valid before the deactivation
      expect((await http().post('/table-sessions/status').send({ sessionToken: sessionA1 }).expect(200)).body).toEqual({ open: false });
      await order(sessionA1).expect(404);
      await get('/businesses/me', adminAToken).expect(403);
      await get(`/businesses/${bizA.id}`).expect(200); // SUPER_ADMIN can still read it
    });

    it('is idempotent: deactivating again is a 200 with no second audit entry and no new effects', async () => {
      const res = await post(`/businesses/${bizA.id}/deactivate`, { reason: 'otra vez' }).expect(200);
      expect(res.body.active).toBe(false);
      expect(await auditOf(bizA.id, 'BUSINESS_DEACTIVATED')).toHaveLength(1);
    });

    it('can still be edited while inactive', async () => {
      const res = await patch(`/businesses/${bizA.id}`, { hours: 'Cerrado temporalmente' }).expect(200);
      expect(res.body).toMatchObject({ hours: 'Cerrado temporalmente', active: false });
    });

    it('the other business is untouched: active, its session still open, menu and orders working', async () => {
      expect(await businessRow(bizB.id)).toMatchObject({ active: true });
      expect(await openSessions(bizB.id)).toBe(1);
      expect((await http().post('/table-sessions/status').send({ sessionToken: sessionB1 }).expect(200)).body).toEqual({ open: true });
      await get('/products?businessSlug=negocio-b', null).expect(200);
      await get('/businesses/me', adminBToken).expect(200);
    });

    it('activate: flips the flag, does NOT reopen sessions, restores the menu and ADMIN, and audits once', async () => {
      const res = await post(`/businesses/${bizA.id}/activate`).expect(200);

      expect(res.body.active).toBe(true);
      expect(await openSessions(bizA.id)).toBe(0); // not reopened
      expect((await http().post('/table-sessions/status').send({ sessionToken: sessionA2 }).expect(200)).body).toEqual({ open: false });
      await get('/products?businessSlug=negocio-a', null).expect(200);
      await get('/businesses/me', adminAToken).expect(200);

      const entries = await auditOf(bizA.id, 'BUSINESS_REACTIVATED');
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ businessId: bizA.id, entityId: bizA.id, userId: superId, userEmail: 'root@lifecycle.test' });
    });

    it('activate is idempotent (200, no second audit) and tables open NEW sessions afterwards', async () => {
      await post(`/businesses/${bizA.id}/activate`).expect(200);
      expect(await auditOf(bizA.id, 'BUSINESS_REACTIVATED')).toHaveLength(1);

      const fresh = await seat(tableA1, adminAToken);
      expect(fresh).not.toBe(sessionA1);
      await order(fresh).expect(201);
    });

    it('only NEW orders count as pending: a cancelled one is ignored, the fresh NEW one blocks (409 count 1), delivering it unblocks', async () => {
      const session = await currentSession(tableA1);
      const cancelled = (await order(session).expect(201)).body.id;
      await patch(`/orders/${cancelled}/status`, { status: 'CANCELLED' }, adminAToken).expect(200);

      const blocked = await post(`/businesses/${bizA.id}/deactivate`).expect(409);
      expect(blocked.body.count).toBe(1); // the order placed right after the reactivation; the cancelled one is not counted
      expect((await businessRow(bizA.id)).active).toBe(true);

      const stillNew = await dataSource.getRepository(Order).find({ where: { businessId: bizA.id, status: 'NEW' as never } });
      expect(stillNew).toHaveLength(1);
      await patch(`/orders/${stillNew[0]!.id}/status`, { status: 'DELIVERED' }, adminAToken).expect(200);

      await post(`/businesses/${bizA.id}/deactivate`, { reason: 'segunda vez' }).expect(200);
      expect(await openSessions(bizA.id)).toBe(0);
      expect(await auditOf(bizA.id, 'BUSINESS_DEACTIVATED')).toHaveLength(2); // two real transitions, two entries
    });
  });

  async function currentSession(table: RestaurantTable): Promise<string> {
    return (await http().post('/table-sessions/join').send({ qrToken: table.qrToken }).expect(200)).body.sessionToken;
  }
});
