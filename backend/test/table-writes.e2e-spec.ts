import type { AddressInfo } from 'node:net';
import bcrypt from 'bcrypt';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { Business } from '../src/business/business.entity.js';
import { DEFAULT_RATE_LIMITS, RATE_LIMIT_CONFIG } from '../src/rate-limit/rate-limit.config.js';
import { RestaurantTable } from '../src/table/table.entity.js';
import { TableService } from '../src/table/table.service.js';
import { generateOpaqueToken } from '../src/table/token.util.js';
import { User } from '../src/user/user.entity.js';
import { UserRole } from '../src/user/user-role.enum.js';
import { runAllMigrations } from './support/run-all-migrations.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

const TEST_BCRYPT_COST = 4;
const PASSWORD = 'Sup3rSecret!K';
const minute = 60_000;
const huge = { limit: 100_000, ttlMs: minute };
const LIMITS = { ...DEFAULT_RATE_LIMITS, globalIp: huge, authenticatedUser: huge };

// 9E.22 — PATCH /tables/:id and POST /tables/:id/qr/rotate over HTTP (real controllers, guards, validation pipe, services, audit and
// database). The moment another admin writes "in the middle" is simulated by running that write right after the service's read; the same
// races with independent connections on a real PostgreSQL are in table-concurrency.e2e-spec.ts (opt-in).
describe('Table writes (e2e, real local Postgres)', () => {
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
  const patch = (id: string, body: object, token = tokens.a) => http().patch(`/tables/${id}`).set(as(token)).send(body);
  const rotate = (id: string, token = tokens.a) => http().post(`/tables/${id}/qr/rotate`).set(as(token));
  const getQr = (id: string, token = tokens.a) => http().get(`/tables/${id}/qr`).set(as(token));
  const join = (qrToken: string) => http().post('/table-sessions/join').send({ qrToken });

  let seq = 0;
  const newTable = async (extra: Partial<RestaurantTable> = {}, businessId = bizA.id) => {
    seq += 1;
    const repo = dataSource.getRepository(RestaurantTable);
    return repo.save(repo.create({ businessId, name: `Mesa ${seq}`, qrToken: generateOpaqueToken(), ...extra }));
  };
  const row = async (id: string) =>
    (await dataSource.query(`SELECT name, active, qr_token AS qr, deleted_at AS del FROM restaurant_tables WHERE id = $1`, [id]))[0] as { name: string; active: boolean; qr: string; del: Date | null };
  const audits = (entityId: string) =>
    dataSource.query(`SELECT action, user_email, business_id FROM audit_logs WHERE entity_id = $1 AND action IN ('TABLE_UPDATED','TABLE_DEACTIVATED') ORDER BY created_at, id`, [entityId]) as Promise<
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

  // After TableService READ the table, another admin commits `rawSql` — the request then writes against a stale read.
  function otherWriterAfterRead(rawSql: string, params: unknown[]) {
    const service = app.get(TableService) as unknown as { tableRepository: { findOne: (...a: unknown[]) => Promise<unknown> } };
    const repository = service.tableRepository;
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
    bizA = await businessRepo.save(businessRepo.create({ name: 'Table writes A', slug: 'table-writes-a' }));
    bizB = await businessRepo.save(businessRepo.create({ name: 'Table writes B', slug: 'table-writes-b' }));
    const userRepo = dataSource.getRepository(User);
    const passwordHash = await bcrypt.hash(PASSWORD, TEST_BCRYPT_COST);
    await userRepo.save([
      userRepo.create({ email: 'a@table-writes.test', passwordHash, role: UserRole.ADMIN, businessId: bizA.id }),
      userRepo.create({ email: 'b@table-writes.test', passwordHash, role: UserRole.ADMIN, businessId: bizB.id }),
      userRepo.create({ email: 'super@table-writes.test', passwordHash, role: UserRole.SUPER_ADMIN, businessId: null }),
    ]);
    tokens.a = await login('a@table-writes.test');
    tokens.b = await login('b@table-writes.test');
    tokens.super = await login('super@table-writes.test');
  }, 90_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.close();
    await testDb?.stop();
  });

  it('PATCH answers 200 with the COMPLETE table when only one field is sent (the omitted one is present and unchanged), never the qrToken, and audits once', async () => {
    const t = await newTable({ name: 'Mesa 1', active: true });
    const res = await patch(t.id, { name: 'Terraza' }).expect(200);
    expect(res.body).toMatchObject({ id: t.id, businessId: bizA.id, name: 'Terraza', active: true });
    expect(res.body).toHaveProperty('createdAt');
    expect(res.body).toHaveProperty('updatedAt');
    expect(res.body).not.toHaveProperty('qrToken');
    const res2 = await patch(t.id, { active: false }).expect(200);
    expect(res2.body).toMatchObject({ id: t.id, name: 'Terraza', active: false });
    expect((await settleAudit(t.id, 2)).map((a) => a.action)).toEqual(['TABLE_UPDATED', 'TABLE_DEACTIVATED']);
  });

  it('PATCH: invalid bodies are 400, an unknown table 404, an open session still blocks deactivation (409 TABLE_HAS_OPEN_SESSION); none of them leaves an audit entry or a change', async () => {
    const t = await newTable({ name: 'Mesa 1' });
    for (const body of [{ name: '' }, { active: 'yes' }, { qrToken: 'x' }, { businessId: bizB.id }]) await patch(t.id, body).expect(400);
    await patch(UNKNOWN, { name: 'x' }).expect(404);
    await http().post(`/tables/${t.id}/sessions`).set(as(tokens.a)).expect(201);
    const res = await patch(t.id, { active: false }).expect(409);
    expect(res.body.errorCode).toBe('TABLE_HAS_OPEN_SESSION');
    expect(await row(t.id)).toMatchObject({ name: 'Mesa 1', active: true });
    expect(await settleAudit(t.id, 0)).toHaveLength(0);
  });

  it('ROTATE returns the new token, which GET /qr then hands out; the old QR stops joining, the new one joins the SAME open session', async () => {
    const t = await newTable({ name: 'Mesa QR' });
    await http().post(`/tables/${t.id}/sessions`).set(as(tokens.a)).expect(201);
    const joined = (await join(t.qrToken).expect(200)).body;
    expect(joined.tableName).toBe('Mesa QR');

    const res = await rotate(t.id).expect(201);
    expect(res.body.qrToken).toEqual(expect.any(String));
    expect(res.body.qrToken).not.toBe(t.qrToken);
    expect((await getQr(t.id).expect(200)).body.qrToken).toBe(res.body.qrToken);

    expect((await join(t.qrToken).expect(404)).body.errorCode).toBe('TABLE_SESSION_UNAVAILABLE');
    const again = (await join(res.body.qrToken).expect(200)).body;
    expect(again.sessionToken).toBe(joined.sessionToken); // the open session was not touched
    expect((await http().post('/table-sessions/status').send({ sessionToken: joined.sessionToken }).expect(200)).body).toEqual({ open: true });
  });

  it('ROTATE writes only the token: a deactivation + rename committed after the read are NOT undone', async () => {
    const t = await newTable({ name: 'Mesa 1' });
    const spy = otherWriterAfterRead(`UPDATE restaurant_tables SET active = false, name = 'Fuera de servicio' WHERE id = $1`, [t.id]);
    try {
      await rotate(t.id).expect(201);
    } finally {
      spy.mockRestore();
    }
    expect(await row(t.id)).toMatchObject({ active: false, name: 'Fuera de servicio' });
    expect((await row(t.id)).qr).not.toBe(t.qrToken);
  });

  it('ROTATE of a table DELETED after the read: 404, it stays deleted, its token is unchanged', async () => {
    const t = await newTable();
    const spy = otherWriterAfterRead(`UPDATE restaurant_tables SET deleted_at = now() WHERE id = $1`, [t.id]);
    try {
      await rotate(t.id).expect(404);
    } finally {
      spy.mockRestore();
    }
    const after = await row(t.id);
    expect(after.del).not.toBeNull();
    expect(after.qr).toBe(t.qrToken);
  });

  it('ROTATE lost to ANOTHER rotation: 409 TABLE_CONCURRENT_MODIFICATION, and the stored token is the winner\'s (no stale token is ever handed out)', async () => {
    const t = await newTable();
    const winner = generateOpaqueToken();
    const spy = otherWriterAfterRead(`UPDATE restaurant_tables SET qr_token = $2 WHERE id = $1`, [t.id, winner]);
    try {
      const res = await rotate(t.id).expect(409);
      expect(res.body.errorCode).toBe('TABLE_CONCURRENT_MODIFICATION');
    } finally {
      spy.mockRestore();
    }
    expect((await row(t.id)).qr).toBe(winner);
  });

  it('ROTATE works for an inactive table (as before) and an unknown table is a 404', async () => {
    const t = await newTable({ active: false });
    await rotate(t.id).expect(201);
    await rotate(UNKNOWN).expect(404);
  });

  it('isolation: another restaurant\'s ADMIN gets 403 on PATCH, rotate and GET /qr and nothing changes; a SUPER_ADMIN may act on any table', async () => {
    const t = await newTable({ name: 'Mesa 1' });
    await patch(t.id, { name: 'x' }, tokens.b).expect(403);
    await rotate(t.id, tokens.b).expect(403);
    await getQr(t.id, tokens.b).expect(403);
    expect(await row(t.id)).toMatchObject({ name: 'Mesa 1', qr: t.qrToken });
    await patch(t.id, { name: 'Por SUPER' }, tokens.super).expect(200);
    await rotate(t.id, tokens.super).expect(201);
    expect(await row(t.id)).toMatchObject({ name: 'Por SUPER' });
    expect((await row(t.id)).qr).not.toBe(t.qrToken);
  });
});
