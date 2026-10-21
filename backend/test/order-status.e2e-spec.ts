import type { AddressInfo } from 'node:net';
import bcrypt from 'bcrypt';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { Business } from '../src/business/business.entity.js';
import { Order } from '../src/order/order.entity.js';
import { OrderService } from '../src/order/order.service.js';
import { OrderStatus } from '../src/order/order-status.enum.js';
import { DEFAULT_RATE_LIMITS, RATE_LIMIT_CONFIG } from '../src/rate-limit/rate-limit.config.js';
import { RestaurantTable } from '../src/table/table.entity.js';
import { TableSession } from '../src/table/table-session.entity.js';
import { TableSessionStatus } from '../src/table/table-session-status.enum.js';
import { User } from '../src/user/user.entity.js';
import { UserRole } from '../src/user/user-role.enum.js';
import { runAllMigrations } from './support/run-all-migrations.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

const TEST_BCRYPT_COST = 4;
const PASSWORD = 'Sup3rSecret!K';
const minute = 60_000;
const huge = { limit: 100_000, ttlMs: minute };
const LIMITS = { ...DEFAULT_RATE_LIMITS, globalIp: huge, authenticatedUser: huge };

// 9E.20 — PATCH /orders/:id/status over HTTP (real controller, guards, validation pipe, service, audit and database): the contract of the
// endpoint and the conditional UPDATE behind it. Ephemeral local PGlite (a single connection), fictitious data. A request that read the
// order as NEW and then lost the race is simulated deterministically by letting another writer commit right after the service's read;
// the same race with independent connections on a real PostgreSQL is in order-status-concurrency.e2e-spec.ts (opt-in).
describe('PATCH /orders/:id/status (e2e, real local Postgres)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  let dataSource: DataSource;
  let bizA: Business;
  let bizB: Business;
  let sessionA: TableSession;
  let sessionB: TableSession;
  const tokens = { a: '', b: '', super: '' };
  const UNKNOWN = '00000000-0000-4000-8000-000000000000';

  const http = () => request(`http://127.0.0.1:${((app.getHttpServer() as { address: () => AddressInfo }).address()).port}`);
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const login = async (email: string) => (await http().post('/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;
  const patch = (id: string, body: unknown, token = tokens.a) => http().patch(`/orders/${id}/status`).set(as(token)).send(body as object);

  let seq = 0;
  const newOrder = async (businessId: string, tableSessionId: string, status = OrderStatus.NEW) => {
    seq += 1;
    const repo = dataSource.getRepository(Order);
    return repo.save(repo.create({ businessId, clientRequestId: `req-${seq}`, table: 'Mesa 1', tableSessionId, total: 2500, note: 'sin picante', status }));
  };
  const row = async (id: string) =>
    (await dataSource.query(`SELECT status, note, total, "table", business_id AS biz, table_session_id AS sess, client_request_id AS crid, order_number AS num FROM orders WHERE id = $1`, [id]))[0] as Record<string, unknown>;
  const audits = (entityId: string) =>
    dataSource.query(`SELECT action, user_id, user_email, business_id FROM audit_logs WHERE entity_id = $1 AND action IN ('ORDER_DELIVERED','ORDER_CANCELLED') ORDER BY created_at, id`, [entityId]) as Promise<
      Array<{ action: string; user_id: string; user_email: string; business_id: string }>
    >;
  // the audit entry is best-effort and fire-and-forget: give it a moment to land before asserting there is exactly one (or none)
  const settleAudit = async (entityId: string, expected: number) => {
    for (let i = 0; i < 40; i++) {
      if ((await audits(entityId)).length >= expected) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
    return audits(entityId);
  };

  // After the service READ the order (as NEW), another admin commits `rawSql` — the request then writes against a stale read.
  function otherWriterAfterRead(rawSql: string, params: unknown[]) {
    const service = app.get(OrderService) as unknown as { orderRepository: { findOne: (...a: unknown[]) => Promise<unknown> } };
    const repository = service.orderRepository;
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
    bizA = await businessRepo.save(businessRepo.create({ name: 'Order status A', slug: 'order-status-a' }));
    bizB = await businessRepo.save(businessRepo.create({ name: 'Order status B', slug: 'order-status-b' }));
    const userRepo = dataSource.getRepository(User);
    const passwordHash = await bcrypt.hash(PASSWORD, TEST_BCRYPT_COST);
    await userRepo.save([
      userRepo.create({ email: 'a@order-status.test', passwordHash, role: UserRole.ADMIN, businessId: bizA.id }),
      userRepo.create({ email: 'b@order-status.test', passwordHash, role: UserRole.ADMIN, businessId: bizB.id }),
      userRepo.create({ email: 'super@order-status.test', passwordHash, role: UserRole.SUPER_ADMIN, businessId: null }),
    ]);
    tokens.a = await login('a@order-status.test');
    tokens.b = await login('b@order-status.test');
    tokens.super = await login('super@order-status.test');

    const tableRepo = dataSource.getRepository(RestaurantTable);
    const tableA = await tableRepo.save(tableRepo.create({ businessId: bizA.id, name: 'Mesa 1', qrToken: 'qr-order-status-a' }));
    const tableB = await tableRepo.save(tableRepo.create({ businessId: bizB.id, name: 'Mesa 1', qrToken: 'qr-order-status-b' }));
    const sessionRepo = dataSource.getRepository(TableSession);
    sessionA = await sessionRepo.save(sessionRepo.create({ tableId: tableA.id, businessId: bizA.id, sessionToken: 'session-order-status-a', status: TableSessionStatus.OPEN }));
    sessionB = await sessionRepo.save(sessionRepo.create({ tableId: tableB.id, businessId: bizB.id, sessionToken: 'session-order-status-b', status: TableSessionStatus.OPEN }));
  }, 90_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.close();
    await testDb?.stop();
  });

  it.each([
    ['DELIVERED', 'ORDER_DELIVERED'],
    ['CANCELLED', 'ORDER_CANCELLED'],
  ])('NEW -> %s answers 200 with the order (items included), changes only its status, and audits it exactly once', async (status, action) => {
    const order = await newOrder(bizA.id, sessionA.id);
    const before = await row(order.id);
    const res = await patch(order.id, { status }).expect(200);
    expect(res.body).toMatchObject({ id: order.id, status, businessId: bizA.id, total: 2500, table: 'Mesa 1', note: 'sin picante' });
    expect(Array.isArray(res.body.items)).toBe(true);
    expect({ ...(await row(order.id)), status: 'NEW' }).toEqual({ ...before, status: 'NEW' });
    expect((await row(order.id)).status).toBe(status);
    const log = await settleAudit(order.id, 1);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ action, user_email: 'a@order-status.test', business_id: bizA.id });
  });

  it('invalid bodies are 400 and nothing changes: NEW is not a target, unknown values, a missing status, extra fields', async () => {
    const order = await newOrder(bizA.id, sessionA.id);
    for (const body of [{ status: 'NEW' }, { status: 'SHIPPED' }, {}, { status: 'DELIVERED', businessId: bizB.id }]) {
      await patch(order.id, body).expect(400);
    }
    await http().patch('/orders/not-a-uuid/status').set(as(tokens.a)).send({ status: 'DELIVERED' }).expect(400);
    expect((await row(order.id)).status).toBe('NEW');
    expect(await audits(order.id)).toHaveLength(0);
  });

  it.each([
    ['DELIVERED', 'CANCELLED'],
    ['DELIVERED', 'DELIVERED'],
    ['CANCELLED', 'DELIVERED'],
    ['CANCELLED', 'CANCELLED'],
  ])('a %s order asked for %s -> 409 INVALID_ORDER_TRANSITION, unchanged, no audit entry', async (from, to) => {
    const order = await newOrder(bizA.id, sessionA.id, from as OrderStatus);
    const res = await patch(order.id, { status: to }).expect(409);
    expect(res.body).toMatchObject({ errorCode: 'INVALID_ORDER_TRANSITION', message: `Order "${order.id}" cannot move from ${from} to ${to}` });
    expect((await row(order.id)).status).toBe(from);
    expect(await settleAudit(order.id, 0)).toHaveLength(0);
  });

  it('LOST RACE, DELIVERED first: the admin who asked CANCELLED after reading NEW gets 409 naming DELIVERED, writes nothing and leaves no audit entry', async () => {
    const order = await newOrder(bizA.id, sessionA.id);
    const spy = otherWriterAfterRead(`UPDATE orders SET status = 'DELIVERED' WHERE id = $1`, [order.id]);
    try {
      const res = await patch(order.id, { status: 'CANCELLED' }).expect(409);
      expect(res.body).toMatchObject({ errorCode: 'INVALID_ORDER_TRANSITION', message: `Order "${order.id}" cannot move from DELIVERED to CANCELLED` });
    } finally {
      spy.mockRestore();
    }
    expect((await row(order.id)).status).toBe('DELIVERED');
    expect(await settleAudit(order.id, 0)).toHaveLength(0);
  });

  it('LOST RACE, CANCELLED first (execution order reversed): DELIVERED gets 409 and the order stays CANCELLED', async () => {
    const order = await newOrder(bizA.id, sessionA.id);
    const spy = otherWriterAfterRead(`UPDATE orders SET status = 'CANCELLED' WHERE id = $1`, [order.id]);
    try {
      const res = await patch(order.id, { status: 'DELIVERED' }).expect(409);
      expect(res.body).toMatchObject({ errorCode: 'INVALID_ORDER_TRANSITION', message: `Order "${order.id}" cannot move from CANCELLED to DELIVERED` });
    } finally {
      spy.mockRestore();
    }
    expect((await row(order.id)).status).toBe('CANCELLED');
    expect(await settleAudit(order.id, 0)).toHaveLength(0);
  });

  it('LOST RACE with the SAME target: the second DELIVERED is a 409, not a second success or a second audit entry', async () => {
    const order = await newOrder(bizA.id, sessionA.id);
    const spy = otherWriterAfterRead(`UPDATE orders SET status = 'DELIVERED' WHERE id = $1`, [order.id]);
    try {
      await patch(order.id, { status: 'DELIVERED' }).expect(409);
    } finally {
      spy.mockRestore();
    }
    expect(await settleAudit(order.id, 0)).toHaveLength(0);
  });

  it('a column another writer changed between the read and the write is not restored to its old value', async () => {
    const order = await newOrder(bizA.id, sessionA.id);
    const spy = otherWriterAfterRead(`UPDATE orders SET note = 'alergia a la nuez' WHERE id = $1`, [order.id]);
    try {
      await patch(order.id, { status: 'DELIVERED' }).expect(200);
    } finally {
      spy.mockRestore();
    }
    const after = await row(order.id);
    expect(after).toMatchObject({ status: 'DELIVERED', note: 'alergia a la nuez' });
  });

  it('isolation: another restaurant\'s ADMIN gets 403 (not 404, not a conflict), nothing changes and nothing is audited; a SUPER_ADMIN may act and is the audited actor', async () => {
    const order = await newOrder(bizA.id, sessionA.id);
    const other = await newOrder(bizB.id, sessionB.id);
    const res = await patch(order.id, { status: 'CANCELLED' }, tokens.b).expect(403);
    expect(res.body.errorCode ?? '').not.toBe('INVALID_ORDER_TRANSITION');
    expect((await row(order.id)).status).toBe('NEW');
    expect(await settleAudit(order.id, 0)).toHaveLength(0);

    await patch(order.id, { status: 'CANCELLED' }, tokens.super).expect(200);
    const log = await settleAudit(order.id, 1);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ action: 'ORDER_CANCELLED', user_email: 'super@order-status.test', business_id: bizA.id });
    expect((await row(other.id)).status).toBe('NEW'); // the other restaurant's order is untouched
  });

  it('unknown order -> 404; no token -> 401', async () => {
    await patch(UNKNOWN, { status: 'DELIVERED' }).expect(404);
    await http().patch(`/orders/${UNKNOWN}/status`).send({ status: 'DELIVERED' }).expect(401);
  });
});
