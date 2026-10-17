import type { AddressInfo } from 'node:net';
import bcrypt from 'bcrypt';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { Business } from '../src/business/business.entity.js';
import { User } from '../src/user/user.entity.js';
import { UserRole } from '../src/user/user-role.enum.js';
import { UserService } from '../src/user/user.service.js';
import { runAllMigrations } from './support/run-all-migrations.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

const TEST_BCRYPT_COST = 4; // only for SEEDING users; the endpoint itself always hashes with cost 12
const PASSWORD = 'Original-Passw0rd!';
const NEW_PASSWORD = 'Brand-New-Passw0rd!';

// POST /auth/change-password and the credentials-version (`cv`) revocation of JWTs, end to end on a real local Postgres
// (ephemeral PGlite, never Supabase), with the REAL rate limits (every test uses its own client IP through X-Real-IP,
// the same mechanism as Railway, and its own user).
//
// HONEST LIMIT. PGlite is one Postgres session behind a socket, so it cannot reproduce two independent connections
// racing. The races below are DETERMINISTIC interleavings: a request is paused between its read and its write while
// another change commits, which proves the compare-and-set refuses the late writer. The row-lock / READ COMMITTED
// re-evaluation that makes the same guarantee hold under truly simultaneous connections is a documented PostgreSQL
// behaviour, NOT something this file demonstrates.
describe('POST /auth/change-password and credentials-version revocation (e2e, real local Postgres)', () => {
  let testDb: TestDatabase;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let jwt: JwtService;
  let userService: UserService;
  let business: Business;
  let counter = 0;
  const captured: string[] = [];
  const restoreWrites: Array<() => void> = [];

  const nextIp = () => `198.51.100.${(counter += 1)}`;
  const baseUrl = () => `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const http = () => request(baseUrl());

  interface TestUser {
    id: string;
    email: string;
    password: string;
    role: UserRole;
    businessId: string | null;
  }

  async function makeUser(role: UserRole = UserRole.ADMIN, businessId?: string | null): Promise<TestUser> {
    const n = (counter += 1);
    const email = `user${n}@change-password.test`;
    const repo = dataSource.getRepository(User);
    const biz = businessId === undefined ? (role === UserRole.SUPER_ADMIN ? null : business.id) : businessId;
    const saved = await repo.save(repo.create({ email, passwordHash: await bcrypt.hash(PASSWORD, TEST_BCRYPT_COST), role, businessId: biz }));
    return { id: saved.id, email, password: PASSWORD, role, businessId: biz };
  }

  const row = async (id: string) =>
    ((await dataSource.query(
      `SELECT credentials_version, must_change_password, role::text AS role, business_id, active, password_hash, md5(password_hash) AS hash_md5 FROM users WHERE id = $1`,
      [id],
    )) as Array<{ credentials_version: number; must_change_password: boolean; role: string; business_id: string | null; active: boolean; password_hash: string; hash_md5: string }>)[0]!;

  const loginAs = (user: TestUser, password = user.password) => http().post('/auth/login').set('X-Real-IP', nextIp()).send({ email: user.email, password });
  const tokenFor = (user: TestUser, cv?: unknown) =>
    jwt.signAsync({ sub: user.id, email: user.email, role: user.role, businessId: user.businessId, ...(cv === undefined ? {} : { cv }) });
  const me = (token: string) => http().get('/auth/me').set('Authorization', `Bearer ${token}`).set('X-Real-IP', nextIp());
  const change = (token: string, body: unknown, ip = nextIp()) =>
    http().post('/auth/change-password').set('Authorization', `Bearer ${token}`).set('X-Real-IP', ip).send(body as object);
  const payloadOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;

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
    process.env.CLIENT_IP_HEADER = 'x-real-ip';

    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication<INestApplication<App>>();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    dataSource = moduleFixture.get(DataSource);
    jwt = moduleFixture.get(JwtService);
    userService = moduleFixture.get(UserService);
    await runAllMigrations(dataSource);

    const businessRepo = dataSource.getRepository(Business);
    business = await businessRepo.save(businessRepo.create({ name: 'Change Password Co', slug: 'change-password-co' }));

    // everything the app prints from here on is captured, to prove no secret ever reaches the logs
    for (const stream of [process.stdout, process.stderr]) {
      const spy = vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
        captured.push(String(chunk));
        const cb = rest.find((r) => typeof r === 'function') as (() => void) | undefined;
        cb?.();
        return true;
      }) as never);
      restoreWrites.push(() => spy.mockRestore());
    }
  }, 60_000);

  afterAll(async () => {
    for (const restore of restoreWrites) restore();
    delete process.env.CLIENT_IP_HEADER;
    await app?.close();
    await testDb?.stop();
  });

  describe('login and the cv claim', () => {
    it('login still works for an existing user: same response shape, generic 401 for a wrong password or an unknown email', async () => {
      const user = await makeUser();
      const ok = await loginAs(user).expect(200);
      expect(Object.keys(ok.body).sort()).toEqual(['accessToken', 'user']);
      expect(ok.body.user).toEqual({ id: user.id, email: user.email, role: 'ADMIN', businessId: business.id, active: true });

      const wrong = await loginAs(user, 'definitely-wrong-1').expect(401);
      const unknown = await http().post('/auth/login').set('X-Real-IP', nextIp()).send({ email: 'nobody@change-password.test', password: 'whatever-123' }).expect(401);
      expect(wrong.body).toEqual(unknown.body);
    });

    it('a new token carries cv = 0 for a user at version 0, plus exactly the same claims as before', async () => {
      const user = await makeUser();
      const { body } = await loginAs(user).expect(200);
      const payload = payloadOf(body.accessToken);
      expect(Object.keys(payload).sort()).toEqual(['businessId', 'cv', 'email', 'exp', 'iat', 'role', 'sub']);
      expect(payload).toMatchObject({ sub: user.id, email: user.email, role: 'ADMIN', businessId: business.id, cv: 0 });
      expect(Number(payload.exp) - Number(payload.iat)).toBe(24 * 3600); // expiry unchanged (JWT_EXPIRES_IN=1d)
    });

    it('an old token WITHOUT cv is accepted while the user is at version 0 (existing sessions survive the deploy)', async () => {
      const user = await makeUser();
      const legacy = await tokenFor(user); // exactly what the previous runtime signed
      expect(payloadOf(legacy)).not.toHaveProperty('cv');
      await me(legacy).expect(200);
    });

    it.each([
      ['a string', '0'],
      ['a float', 0.5],
      ['negative', -1],
      ['null', null],
      ['an object', { v: 0 }],
      ['a boolean', true],
    ])('a token with a malformed cv (%s) is a 401, even though it is correctly signed', async (_label, cv) => {
      const user = await makeUser();
      await me(await jwt.signAsync({ sub: user.id, email: user.email, role: user.role, businessId: user.businessId, cv })).expect(401);
    });

    it('a cv that does not match the database is a 401 whatever the direction (older or newer than the stored version)', async () => {
      const user = await makeUser();
      await me(await tokenFor(user, 0)).expect(200);
      await me(await tokenFor(user, 1)).expect(401);
      await dataSource.query(`UPDATE users SET credentials_version = 4 WHERE id = $1`, [user.id]);
      await me(await tokenFor(user, 4)).expect(200);
      await me(await tokenFor(user, 3)).expect(401);
      await me(await tokenFor(user)).expect(401); // no cv = 0 now stale
    });

    it('the version the server trusts is the database row, not any other claim a client could send (role/businessId in the token are ignored too)', async () => {
      const user = await makeUser();
      const forged = await jwt.signAsync({ sub: user.id, email: 'x@y.z', role: UserRole.SUPER_ADMIN, businessId: null, cv: 0 });
      const res = await me(forged).expect(200);
      expect(res.body).toMatchObject({ role: 'ADMIN', businessId: business.id }); // req.user comes from the row
    });
  });

  describe('a successful change', () => {
    it('ADMIN: new hash (bcrypt cost 12), version +1 exactly once, must_change_password cleared, new session returned, no secrets in the response', async () => {
      const user = await makeUser();
      await dataSource.query(`UPDATE users SET must_change_password = true WHERE id = $1`, [user.id]);
      const before = await row(user.id);
      const token = (await loginAs(user).expect(200)).body.accessToken as string;

      const res = await change(token, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(200);

      expect(Object.keys(res.body).sort()).toEqual(['accessToken', 'user']);
      expect(res.body.user).toEqual({ id: user.id, email: user.email, role: 'ADMIN', businessId: business.id, active: true });
      expect(payloadOf(res.body.accessToken)).toMatchObject({ sub: user.id, role: 'ADMIN', businessId: business.id, cv: 1 });
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(NEW_PASSWORD);
      expect(text).not.toMatch(/\$2[aby]\$|passwordHash|password_hash/);

      const after = await row(user.id);
      expect(after.credentials_version).toBe(before.credentials_version + 1);
      expect(after.must_change_password).toBe(false);
      expect(after.password_hash.startsWith('$2b$12$')).toBe(true);
      expect(await bcrypt.compare(NEW_PASSWORD, after.password_hash)).toBe(true);
      expect(await bcrypt.compare(PASSWORD, after.password_hash)).toBe(false);
      expect([after.role, after.business_id, after.active]).toEqual([before.role, before.business_id, before.active]); // nothing else touched
    });

    it('the old token is rejected, the legacy (no cv) token too, the new token works, and the old password stops logging in', async () => {
      const user = await makeUser();
      const old = (await loginAs(user).expect(200)).body.accessToken as string;
      const legacy = await tokenFor(user);
      await me(old).expect(200);

      const res = await change(old, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(200);

      await me(old).expect(401);
      await me(legacy).expect(401);
      await me(res.body.accessToken).expect(200);
      await loginAs(user, PASSWORD).expect(401);
      const relogin = await loginAs(user, NEW_PASSWORD).expect(200);
      expect(payloadOf(relogin.body.accessToken).cv).toBe(1);
    });

    it('every OTHER device is signed out as well: all tokens issued before the change stop working', async () => {
      const user = await makeUser();
      const phone = (await loginAs(user).expect(200)).body.accessToken as string;
      const laptop = (await loginAs(user).expect(200)).body.accessToken as string;
      const tablet = await tokenFor(user, 0);

      const res = await change(phone, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(200);

      for (const stale of [phone, laptop, tablet]) await me(stale).expect(401);
      await me(res.body.accessToken).expect(200);
    });

    it('a second change bumps the version again, one at a time (1 -> 2), and the previous new token dies', async () => {
      const user = await makeUser();
      const first = await change(await tokenFor(user, 0), { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(200);
      const second = await change(first.body.accessToken, { currentPassword: NEW_PASSWORD, newPassword: 'Yet-Another-Passw0rd!' }).expect(200);
      expect(payloadOf(second.body.accessToken).cv).toBe(2);
      expect((await row(user.id)).credentials_version).toBe(2);
      await me(first.body.accessToken).expect(401);
      await me(second.body.accessToken).expect(200);
    });

    it('SUPER_ADMIN can change their own password too, and it keeps no business', async () => {
      const root = await makeUser(UserRole.SUPER_ADMIN, null);
      const res = await change(await tokenFor(root, 0), { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(200);
      expect(res.body.user).toEqual({ id: root.id, email: root.email, role: 'SUPER_ADMIN', businessId: null, active: true });
      expect(payloadOf(res.body.accessToken)).toMatchObject({ role: 'SUPER_ADMIN', businessId: null, cv: 1 });
      await me(res.body.accessToken).expect(200);
    });

    it('a user created the way the bootstrap CLI does (explicit columns, SUPER_ADMIN, no business) logs in with cv = 0 and can change the password', async () => {
      const email = 'cli-made@change-password.test';
      await dataSource.query(`INSERT INTO users (email, password_hash, role, business_id, active) VALUES ($1, $2, 'SUPER_ADMIN', NULL, true)`, [
        email,
        await bcrypt.hash(PASSWORD, TEST_BCRYPT_COST),
      ]);
      const login = await http().post('/auth/login').set('X-Real-IP', nextIp()).send({ email, password: PASSWORD }).expect(200);
      expect(payloadOf(login.body.accessToken)).toMatchObject({ role: 'SUPER_ADMIN', businessId: null, cv: 0 });
      await change(login.body.accessToken, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(200);
    });
  });

  describe('refusals leave everything exactly as it was', () => {
    async function expectUntouched(user: TestUser, token: string, before: Awaited<ReturnType<typeof row>>) {
      const after = await row(user.id);
      expect(after.hash_md5).toBe(before.hash_md5);
      expect(after.credentials_version).toBe(before.credentials_version);
      await me(token).expect(200); // not signed out by a failed attempt
    }

    it('a wrong current password is a 403 CURRENT_PASSWORD_INCORRECT — not a 401, so the frontend does not log the user out', async () => {
      const user = await makeUser();
      const token = await tokenFor(user, 0);
      const before = await row(user.id);
      const res = await change(token, { currentPassword: 'not-the-password-1', newPassword: NEW_PASSWORD }).expect(403);
      expect(res.body.errorCode).toBe('CURRENT_PASSWORD_INCORRECT');
      expect(JSON.stringify(res.body)).not.toMatch(/not-the-password|\$2[aby]\$/);
      await expectUntouched(user, token, before);
    });

    it('the same password again is a 400 PASSWORD_UNCHANGED', async () => {
      const user = await makeUser();
      const token = await tokenFor(user, 0);
      const before = await row(user.id);
      const res = await change(token, { currentPassword: PASSWORD, newPassword: PASSWORD }).expect(400);
      expect(res.body.errorCode).toBe('PASSWORD_UNCHANGED');
      await expectUntouched(user, token, before);
    });

    it.each([
      ['shorter than 12 characters', 'Short-pw-1!', 'PASSWORD_TOO_SHORT'],
      ['blank', '              ', 'PASSWORD_REQUIRED'],
      ['73 bytes', 'a'.repeat(73), 'PASSWORD_TOO_LONG'],
      ['37 two-byte characters (74 bytes)', 'ñ'.repeat(37), 'PASSWORD_TOO_LONG'],
    ])('policy: a new password %s -> 400 %s', async (_label, newPassword, code) => {
      const user = await makeUser();
      const token = await tokenFor(user, 0);
      const before = await row(user.id);
      const res = await change(token, { currentPassword: PASSWORD, newPassword }).expect(400);
      expect(res.body.errorCode).toBe(code);
      expect(JSON.stringify(res.body)).not.toContain(newPassword.trim() === '' ? 'impossible-needle' : newPassword);
      await expectUntouched(user, token, before);
    });

    it('policy: the email address as the new password is refused, whatever its case', async () => {
      const user = await makeUser();
      const token = await tokenFor(user, 0);
      const before = await row(user.id);
      const res = await change(token, { currentPassword: PASSWORD, newPassword: user.email.toUpperCase() }).expect(400);
      expect(res.body.errorCode).toBe('PASSWORD_EQUALS_EMAIL');
      await expectUntouched(user, token, before);
    });

    // (one user per request below: a malformed body still costs an attempt of the 5-per-minute per-user bucket,
    // which is charged before validation, so a single user could not send them all)
    it('a strict whitelist: any extra field is a 400 and nothing changes (no id, email, role, version or must_change_password can be smuggled in)', async () => {
      const other = await makeUser();
      const otherBefore = await row(other.id);
      for (const extra of [{ id: other.id }, { userId: other.id }, { email: 'x@y.z' }, { role: 'SUPER_ADMIN' }, { credentialsVersion: 99 }, { mustChangePassword: true }, { businessId: null }]) {
        const actor = await makeUser();
        const token = await tokenFor(actor, 0);
        const before = await row(actor.id);
        await change(token, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, ...extra }).expect(400);
        await expectUntouched(actor, token, before);
      }
      expect((await row(other.id)).hash_md5).toBe(otherBefore.hash_md5);
    });

    it('missing, empty or non-string fields are a 400', async () => {
      for (const body of [{}, { currentPassword: PASSWORD }, { newPassword: NEW_PASSWORD }, { currentPassword: '', newPassword: NEW_PASSWORD }, { currentPassword: PASSWORD, newPassword: 12345678901234 }, { currentPassword: ['a'], newPassword: NEW_PASSWORD }]) {
        const actor = await makeUser();
        const token = await tokenFor(actor, 0);
        const before = await row(actor.id);
        await change(token, body).expect(400);
        await expectUntouched(actor, token, before);
      }
    });

    it('without a token, or with a revoked or malformed one: 401, and nothing is written', async () => {
      const user = await makeUser();
      const before = await row(user.id);
      await http().post('/auth/change-password').set('X-Real-IP', nextIp()).send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(401);
      await change('not.a.jwt', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(401);
      await change(await tokenFor(user, 7), { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(401);
      await change(await tokenFor(user, 'x'), { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(401);
      expect((await row(user.id)).hash_md5).toBe(before.hash_md5);
    });

    it('a deactivated user or an ADMIN of a suspended business cannot change the password (the guards run first)', async () => {
      const inactive = await makeUser();
      await dataSource.query(`UPDATE users SET active = false WHERE id = $1`, [inactive.id]);
      await change(await tokenFor(inactive, 0), { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(401);

      const suspendedBusiness = await dataSource.getRepository(Business).save(dataSource.getRepository(Business).create({ name: 'Suspended', slug: `suspended-${counter}`, active: false }));
      const admin = await makeUser(UserRole.ADMIN, suspendedBusiness.id);
      const before = await row(admin.id);
      const res = await change(await tokenFor(admin, 0), { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(403);
      expect(res.body.errorCode).toBe('BUSINESS_INACTIVE');
      expect((await row(admin.id)).hash_md5).toBe(before.hash_md5);
    });
  });

  describe('byte limits (bcrypt only reads 72 bytes)', () => {
    it('exactly 72 bytes is accepted, and the whole password counts (a different 73rd byte is not silently ignored because it is refused)', async () => {
      const user = await makeUser();
      const exactly72 = 'ñ'.repeat(36);
      const res = await change(await tokenFor(user, 0), { currentPassword: PASSWORD, newPassword: exactly72 }).expect(200);
      expect(Buffer.byteLength(exactly72, 'utf8')).toBe(72);
      expect(await bcrypt.compare(exactly72, (await row(user.id)).password_hash)).toBe(true);
      await me(res.body.accessToken).expect(200);
    });

    it('exactly 12 characters is accepted', async () => {
      const user = await makeUser();
      await change(await tokenFor(user, 0), { currentPassword: PASSWORD, newPassword: 'Twelve-chars' }).expect(200);
    });
  });

  describe('audit', () => {
    const auditRows = async (userId: string) =>
      (await dataSource.query(`SELECT business_id, user_id, user_email, action, entity_type, entity_id, metadata FROM audit_logs WHERE user_id = $1 ORDER BY created_at`, [userId])) as Array<{
        business_id: string;
        user_id: string;
        user_email: string;
        action: string;
        entity_type: string;
        entity_id: string;
        metadata: unknown;
      }>;

    it('a successful ADMIN change is audited, scoped to their business, with EMPTY metadata and no secret anywhere in the row', async () => {
      const user = await makeUser();
      const res = await change(await tokenFor(user, 0), { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(200);
      const rows = await auditRows(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ business_id: business.id, user_id: user.id, user_email: user.email, action: 'USER_PASSWORD_CHANGED', entity_type: 'User', entity_id: user.id });
      expect(rows[0]!.metadata == null || Object.keys(rows[0]!.metadata as object).length === 0).toBe(true);
      const text = JSON.stringify(await dataSource.query(`SELECT * FROM audit_logs WHERE user_id = $1`, [user.id]));
      for (const secret of [PASSWORD, NEW_PASSWORD, res.body.accessToken as string]) expect(text).not.toContain(secret);
      expect(text).not.toMatch(/\$2[aby]\$/);
    });

    it('failed attempts are not audited; a SUPER_ADMIN change is NOT audited (no business to scope it to: the platform-level audit trail is still pending)', async () => {
      const user = await makeUser();
      await change(await tokenFor(user, 0), { currentPassword: 'wrong-password-12', newPassword: NEW_PASSWORD }).expect(403);
      expect(await auditRows(user.id)).toEqual([]);

      const root = await makeUser(UserRole.SUPER_ADMIN, null);
      await change(await tokenFor(root, 0), { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(200);
      expect(await auditRows(root.id)).toEqual([]);
    });
  });

  describe('concurrency (deterministic interleavings — see the note at the top about PGlite)', () => {
    it('a login that verified the OLD password while a change commits can only get a token with the OLD version, which never works', async () => {
      const user = await makeUser();
      const other = await tokenFor(user, 0);
      const original = userService.findByEmailWithPassword.bind(userService);
      const spy = vi.spyOn(userService, 'findByEmailWithPassword').mockImplementationOnce(async (email: string) => {
        const snapshot = await original(email); // login has read hash + version (v0) ...
        await change(other, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(200); // ... and the change commits now
        return snapshot;
      });
      try {
        const login = await loginAs(user).expect(200); // the old password WAS correct when it was checked
        expect(payloadOf(login.body.accessToken).cv).toBe(0); // the version of the row whose hash was verified
        expect((await row(user.id)).credentials_version).toBe(1);
        await me(login.body.accessToken).expect(401); // so the token is worthless
      } finally {
        spy.mockRestore();
      }
      await loginAs(user, NEW_PASSWORD).expect(200);
    });

    it('two changes from the same snapshot: only the first commits, the late one gets 409 CREDENTIALS_CHANGED and cannot overwrite the newer password', async () => {
      const user = await makeUser();
      const tokenA = await tokenFor(user, 0);
      const tokenB = await tokenFor(user, 0);
      const original = userService.findByIdWithPassword.bind(userService);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let readDone!: () => void;
      const read = new Promise<void>((resolve) => (readDone = resolve));
      const spy = vi.spyOn(userService, 'findByIdWithPassword').mockImplementationOnce(async (id: string) => {
        const snapshot = await original(id); // A has read version 0 ...
        readDone();
        await gate; // ... and is paused before its write
        return snapshot;
      });
      try {
        const late = change(tokenA, { currentPassword: PASSWORD, newPassword: 'Late-Writer-Passw0rd!' }).then((r) => r);
        await read;
        const winner = await change(tokenB, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(200);
        release();
        const lateRes = await late;

        expect(lateRes.status).toBe(409);
        expect(lateRes.body.errorCode).toBe('CREDENTIALS_CHANGED');
        expect(JSON.stringify(lateRes.body)).not.toContain('accessToken');
        const after = await row(user.id);
        expect(after.credentials_version).toBe(1); // bumped exactly once, not twice
        expect(await bcrypt.compare(NEW_PASSWORD, after.password_hash)).toBe(true); // the winner's password survived
        expect(await bcrypt.compare('Late-Writer-Passw0rd!', after.password_hash)).toBe(false);
        await me(winner.body.accessToken).expect(200);
      } finally {
        spy.mockRestore();
      }
    });

    it('the compare-and-set itself: a stale expected version matches no row and writes nothing', async () => {
      const user = await makeUser();
      const before = await row(user.id);
      expect(await userService.replacePasswordIfUnchanged(user.id, before.credentials_version + 5, 'irrelevant-hash')).toBeNull();
      expect(await userService.replacePasswordIfUnchanged(user.id, before.credentials_version - 1, 'irrelevant-hash')).toBeNull();
      expect((await row(user.id)).hash_md5).toBe(before.hash_md5);

      const updated = await userService.replacePasswordIfUnchanged(user.id, before.credentials_version, await bcrypt.hash(NEW_PASSWORD, TEST_BCRYPT_COST));
      expect(updated).toMatchObject({ id: user.id, credentialsVersion: before.credentials_version + 1, role: UserRole.ADMIN, businessId: business.id });
      // the same snapshot cannot be used twice
      expect(await userService.replacePasswordIfUnchanged(user.id, before.credentials_version, 'irrelevant-hash')).toBeNull();
      expect((await row(user.id)).credentials_version).toBe(before.credentials_version + 1);
    });

    it('it never touches an inactive user or another user', async () => {
      const user = await makeUser();
      const other = await makeUser();
      const otherBefore = await row(other.id);
      await dataSource.query(`UPDATE users SET active = false WHERE id = $1`, [user.id]);
      expect(await userService.replacePasswordIfUnchanged(user.id, 0, 'h')).toBeNull();
      expect((await row(other.id)).hash_md5).toBe(otherBefore.hash_md5);
    });
  });

  describe('rate limits (the real ones: 10/min per IP, 5/min per user; failed attempts count)', () => {
    it('the 6th attempt of the same USER within a minute is a 429, even from different IPs and even if every attempt failed', async () => {
      const user = await makeUser();
      const bystander = await makeUser();
      const token = await tokenFor(user, 0);
      for (let i = 0; i < 5; i += 1) {
        await change(token, { currentPassword: `wrong-password-${i}x`, newPassword: NEW_PASSWORD }).expect(403);
      }
      const limited = await change(token, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
      expect(limited.status).toBe(429);
      expect(limited.body.errorCode).toBe('RATE_LIMITED');
      expect((await row(user.id)).credentials_version).toBe(0); // even the CORRECT password is refused while limited
      // another user is unaffected
      await change(await tokenFor(bystander, 0), { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(200);
    });

    it('the 11th request from the same IP within a minute is a 429, across different users (and unauthenticated requests count too)', async () => {
      const ip = nextIp();
      const users: TestUser[] = [];
      for (let i = 0; i < 4; i += 1) users.push(await makeUser());
      for (let i = 0; i < 4; i += 1) {
        await change(await tokenFor(users[i]!, 0), { currentPassword: 'wrong-password-12', newPassword: NEW_PASSWORD }, ip).expect(403);
      }
      for (let i = 0; i < 6; i += 1) {
        await http().post('/auth/change-password').set('X-Real-IP', ip).send({ currentPassword: 'a', newPassword: 'b' }).expect(401);
      }
      const limited = await change(await tokenFor(users[0]!, 0), { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, ip);
      expect(limited.status).toBe(429);
      expect(limited.body.errorCode).toBe('RATE_LIMITED');
    });

    it('the change-password limits do not touch the login limit, and the global ceilings still apply on top', async () => {
      const user = await makeUser();
      const ip = nextIp();
      for (let i = 0; i < 5; i += 1) await http().post('/auth/login').set('X-Real-IP', ip).send({ email: user.email, password: 'wrong-password-12' }).expect(401);
      await http().post('/auth/login').set('X-Real-IP', ip).send({ email: user.email, password: 'wrong-password-12' }).expect(429);
      // that IP's login bucket is spent, but its change-password bucket is its own
      await change(await tokenFor(user, 0), { currentPassword: 'wrong-password-12', newPassword: NEW_PASSWORD }, ip).expect(403);
    });
  });

  it('no password, hash or token ever reached the application logs (stdout/stderr were captured for this whole file)', () => {
    const logs = captured.join('');
    for (const secret of [PASSWORD, NEW_PASSWORD, 'Late-Writer-Passw0rd!', 'Yet-Another-Passw0rd!', 'Twelve-chars', 'wrong-password-12']) {
      expect(logs.includes(secret), `log contains a password`).toBe(false);
    }
    expect(logs).not.toMatch(/\$2[aby]\$\d\d\$/);
    expect(logs).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./); // no JWT
  });
});
