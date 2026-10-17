import type { AddressInfo } from 'node:net';
import bcrypt from 'bcrypt';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { BusinessAdminService } from '../src/business/business-admin.service.js';
import { Business } from '../src/business/business.entity.js';
import { TEMPORARY_PASSWORD_ALPHABET } from '../src/auth/temporary-password.js';
import { User } from '../src/user/user.entity.js';
import { UserRole } from '../src/user/user-role.enum.js';
import { runAllMigrations } from './support/run-all-migrations.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

const TEST_BCRYPT_COST = 4; // seeding only; the endpoints always hash with cost 12
const PASSWORD = 'Seeded-Passw0rd!';
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const TEMP_PATTERN = new RegExp(`^[${TEMPORARY_PASSWORD_ALPHABET}]{5}(-[${TEMPORARY_PASSWORD_ALPHABET}]{5}){3}$`);

// SUPER_ADMIN management of a business's ADMIN accounts (8D.2d-3), end to end on a real local Postgres (ephemeral PGlite,
// real rate limits, a fake client IP per request through X-Real-IP).
//
// HONEST LIMIT. PGlite is a single Postgres session behind a socket: it cannot reproduce two independent connections racing
// (row locks, READ COMMITTED re-evaluation). The concurrent-reset test is a DETERMINISTIC interleaving (one request is paused
// between its read and its write while another commits) that proves the compare-and-set refuses the late writer; the
// "last active admin" rule is proven sequentially. How the Business row lock serialises truly simultaneous transactions is
// documented PostgreSQL behaviour, not demonstrated here.
describe('Business ADMIN management — SUPER_ADMIN only (e2e, real local Postgres)', () => {
  let testDb: TestDatabase;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let jwt: JwtService;
  let audit: { recordInTransaction: (...args: never[]) => Promise<void> };
  let counter = 0;
  const captured: string[] = [];
  const restoreWrites: Array<() => void> = [];
  const everyTemporaryPassword: string[] = [];

  // unique for the whole file (two octets: never wraps, so no request ever reuses another test's rate-limit bucket)
  const nextIp = () => `192.0.${((counter += 1) >> 8) & 255}.${counter & 255}`;
  const baseUrl = () => `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

  interface TestUser {
    id: string;
    email: string;
    role: UserRole;
    businessId: string | null;
  }

  async function makeBusiness(opts: { active?: boolean } = {}): Promise<Business> {
    const repo = dataSource.getRepository(Business);
    const n = (counter += 1);
    return repo.save(repo.create({ name: `Business ${n}`, slug: `biz-${n}-admins`, active: opts.active ?? true }));
  }

  async function makeUser(role: UserRole, businessId: string | null, opts: { active?: boolean; mustChange?: boolean; email?: string } = {}): Promise<TestUser> {
    const n = (counter += 1);
    const email = opts.email ?? `user${n}@admins.test`;
    const repo = dataSource.getRepository(User);
    const saved = await repo.save(repo.create({ email, passwordHash: await bcrypt.hash(PASSWORD, TEST_BCRYPT_COST), role, businessId, active: opts.active ?? true }));
    if (opts.mustChange) await dataSource.query(`UPDATE users SET must_change_password = true WHERE id = $1`, [saved.id]);
    return { id: saved.id, email, role, businessId };
  }

  const userRow = async (id: string) =>
    ((await dataSource.query(
      `SELECT email, role::text AS role, business_id, active, credentials_version, must_change_password, password_hash, md5(password_hash) AS hash_md5 FROM users WHERE id = $1`,
      [id],
    )) as Array<{ email: string; role: string; business_id: string | null; active: boolean; credentials_version: number; must_change_password: boolean; password_hash: string; hash_md5: string }>)[0]!;

  const tokenFor = async (user: TestUser) => {
    const { credentials_version: cv } = await userRow(user.id);
    return jwt.signAsync({ sub: user.id, email: user.email, role: user.role, businessId: user.businessId, cv });
  };

  type Method = 'get' | 'post';
  const call = (method: Method, path: string, token: string | null, body?: unknown) => {
    let req = request(baseUrl())[method](path).set('X-Real-IP', nextIp());
    if (token) req = req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body as object);
  };
  const freshSuperToken = async () => tokenFor(await makeUser(UserRole.SUPER_ADMIN, null));
  const adminsPath = (businessId: string, rest = '') => `/businesses/${businessId}/admins${rest}`;

  // Creates through the API and keeps every temporary password seen, to prove none of them leaks anywhere.
  async function createAdmin(superToken: string, businessId: string, email: string) {
    const res = await call('post', adminsPath(businessId), superToken, { email }).expect(201);
    everyTemporaryPassword.push(res.body.temporaryPassword);
    return res;
  }
  async function resetAdmin(superToken: string, businessId: string, userId: string) {
    const res = await call('post', adminsPath(businessId, `/${userId}/reset-password`), superToken).expect(200);
    everyTemporaryPassword.push(res.body.temporaryPassword);
    return res;
  }

  const auditRows = async (businessId: string, action?: string) =>
    (await dataSource.query(
      `SELECT business_id, user_id, user_email, action, entity_type, entity_id, metadata, ip_address FROM audit_logs WHERE business_id = $1 ${action ? 'AND action = $2' : ''} ORDER BY created_at, id`,
      action ? [businessId, action] : [businessId],
    )) as Array<{ business_id: string; user_id: string; user_email: string; action: string; entity_type: string; entity_id: string; metadata: Record<string, unknown> | null; ip_address: string | null }>;

  let biz: Business;
  let root: TestUser;
  let rootToken: string;

  // A fresh SUPER_ADMIN per test: the provisioning endpoints are rate limited PER USER (10/min), which is the very
  // thing under test further down, so tests must not drain one shared account's bucket.
  beforeEach(async () => {
    root = await makeUser(UserRole.SUPER_ADMIN, null);
    rootToken = await tokenFor(root);
  });

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
    // The AuditService instance THIS service uses (AuthModule provides a second, separate instance, so get(AuditService)
    // could return the wrong one).
    audit = (moduleFixture.get(BusinessAdminService) as unknown as { auditService: typeof audit }).auditService;
    await runAllMigrations(dataSource);

    biz = await makeBusiness();

    for (const stream of [process.stdout, process.stderr]) {
      const spy = vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
        captured.push(String(chunk));
        (rest.find((r) => typeof r === 'function') as (() => void) | undefined)?.();
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

  describe('access: SUPER_ADMIN only', () => {
    it('an ADMIN gets 403 on every route — even for their OWN business — and nothing changes', async () => {
      const b = await makeBusiness();
      const admin = await makeUser(UserRole.ADMIN, b.id);
      const other = await makeUser(UserRole.ADMIN, b.id);
      const adminToken = await tokenFor(admin);
      const before = await userRow(other.id);
      const routes: Array<[Method, string, unknown?]> = [
        ['get', adminsPath(b.id)],
        ['post', adminsPath(b.id), { email: 'hijack@admins.test' }],
        ['post', adminsPath(b.id, `/${other.id}/deactivate`)],
        ['post', adminsPath(b.id, `/${other.id}/activate`)],
        ['post', adminsPath(b.id, `/${other.id}/reset-password`)],
      ];
      for (const [method, path, body] of routes) {
        const res = await call(method, path, adminToken, body);
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(res.body.temporaryPassword).toBeUndefined();
      }
      expect(await userRow(other.id)).toEqual(before);
      expect(await dataSource.query(`SELECT 1 FROM users WHERE email = 'hijack@admins.test'`)).toEqual([]);
      expect(await auditRows(b.id)).toEqual([]);
    });

    it('no token or a bad token is 401, and a SUPER_ADMIN who must still change their own password is stopped first (403 PASSWORD_CHANGE_REQUIRED)', async () => {
      await call('get', adminsPath(biz.id), null).expect(401);
      await call('post', adminsPath(biz.id), 'garbage', { email: 'x@admins.test' }).expect(401);
      const restricted = await makeUser(UserRole.SUPER_ADMIN, null, { mustChange: true });
      const res = await call('post', adminsPath(biz.id), await tokenFor(restricted), { email: 'x@admins.test' }).expect(403);
      expect(res.body.errorCode).toBe('PASSWORD_CHANGE_REQUIRED');
    });
  });

  describe('creating ADMIN accounts', () => {
    it('creates several ADMINs for one business: right business, role ADMIN, active, must change password, version 0, a temporary password returned once', async () => {
      const b = await makeBusiness();
      const emails = ['one@admins.test', 'two@admins.test', 'three@admins.test'];
      const passwords: string[] = [];
      for (const email of emails) {
        const res = await createAdmin(rootToken, b.id, email);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers.pragma).toBe('no-cache');
        expect(Object.keys(res.body).sort()).toEqual(['temporaryPassword', 'user']);
        expect(Object.keys(res.body.user).sort()).toEqual(['active', 'businessId', 'createdAt', 'email', 'id', 'mustChangePassword', 'role', 'updatedAt']);
        expect(res.body.user).toMatchObject({ email, businessId: b.id, role: 'ADMIN', active: true, mustChangePassword: true });
        expect(res.body.temporaryPassword).toMatch(TEMP_PATTERN);

        const row = await userRow(res.body.user.id);
        expect(row).toMatchObject({ email, role: 'ADMIN', business_id: b.id, active: true, must_change_password: true, credentials_version: 0 });
        expect(row.password_hash.startsWith('$2b$12$')).toBe(true);
        expect(await bcrypt.compare(res.body.temporaryPassword, row.password_hash)).toBe(true);
        passwords.push(res.body.temporaryPassword);
      }
      expect(new Set(passwords).size).toBe(3); // distinct, random
      const list = await call('get', adminsPath(b.id), rootToken).expect(200);
      expect(list.body.map((u: { email: string }) => u.email)).toEqual(emails);
    });

    it('the temporary password works once for the login, forces the change and is then replaced by the user', async () => {
      const b = await makeBusiness();
      const created = await createAdmin(rootToken, b.id, 'first.login@admins.test');
      const login = await call('post', '/auth/login', null, { email: 'first.login@admins.test', password: created.body.temporaryPassword }).expect(200);
      expect(login.body.user).toMatchObject({ role: 'ADMIN', businessId: b.id, mustChangePassword: true });
      const blocked = await call('get', '/products/admin', login.body.accessToken).expect(403);
      expect(blocked.body.errorCode).toBe('PASSWORD_CHANGE_REQUIRED');
      const changed = await call('post', '/auth/change-password', login.body.accessToken, { currentPassword: created.body.temporaryPassword, newPassword: 'My-Own-Passw0rd!' }).expect(200);
      expect(changed.body.user.mustChangePassword).toBe(false);
      await call('get', '/products/admin', changed.body.accessToken).expect(200);
      await call('post', '/auth/login', null, { email: 'first.login@admins.test', password: created.body.temporaryPassword }).expect(401);
    });

    it('normalises the email (trim + lowercase) and refuses a duplicate in any case — against any user of any business, SUPER_ADMIN included', async () => {
      const b = await makeBusiness();
      const res = await call('post', adminsPath(b.id), rootToken, { email: '  Mixed.Case@Admins.TEST ' }).expect(201);
      everyTemporaryPassword.push(res.body.temporaryPassword);
      expect(res.body.user.email).toBe('mixed.case@admins.test');
      const otherBusiness = await makeBusiness();
      for (const email of ['mixed.case@admins.test', 'MIXED.CASE@ADMINS.TEST', root.email.toUpperCase()]) {
        for (const target of [b.id, otherBusiness.id]) {
          const dup = await call('post', adminsPath(target), rootToken, { email }).expect(409);
          expect(dup.body.errorCode).toBe('EMAIL_ALREADY_EXISTS');
          expect(dup.body.temporaryPassword).toBeUndefined();
        }
      }
      expect((await dataSource.query(`SELECT count(*)::int AS n FROM users WHERE lower(email) = 'mixed.case@admins.test'`) as Array<{ n: number }>)[0]!.n).toBe(1);
    });

    it('a strict whitelist: only { email }; password, role, businessId, active, mustChangePassword, credentialsVersion... are a 400', async () => {
      const b = await makeBusiness();
      const second = await freshSuperToken(); // (a second SUPER_ADMIN: every attempt, valid or not, costs one of the 10 provisioning attempts per minute)
      const before = (await dataSource.query(`SELECT count(*)::int AS n FROM users`) as Array<{ n: number }>)[0]!.n;
      for (const extra of [{ password: 'Chosen-By-Caller-1' }, { role: 'SUPER_ADMIN' }, { businessId: ZERO_UUID }, { active: false }, { mustChangePassword: false }, { credentialsVersion: 5 }, { id: ZERO_UUID }]) {
        await call('post', adminsPath(b.id), rootToken, { email: 'extra@admins.test', ...extra }).expect(400);
      }
      for (const body of [{}, { email: '' }, { email: 'not-an-email' }, { email: `${'a'.repeat(250)}@x.test` }, { email: ['a@b.test'] }, { email: 12345 }]) {
        await call('post', adminsPath(b.id), second, body).expect(400);
      }
      expect((await dataSource.query(`SELECT count(*)::int AS n FROM users`) as Array<{ n: number }>)[0]!.n).toBe(before);
    });

    it('an unknown business is 404 BUSINESS_NOT_FOUND and a malformed id is 400', async () => {
      expect((await call('post', adminsPath(ZERO_UUID), rootToken, { email: 'nobody@admins.test' }).expect(404)).body.errorCode).toBe('BUSINESS_NOT_FOUND');
      expect((await call('get', adminsPath(ZERO_UUID), rootToken).expect(404)).body.errorCode).toBe('BUSINESS_NOT_FOUND');
      await call('get', '/businesses/not-a-uuid/admins', rootToken).expect(400);
      await call('post', adminsPath(biz.id, '/not-a-uuid/reset-password'), rootToken).expect(400);
    });

    it('respects the per-business user ceiling (BUSINESS_MAX_USERS, default 20), SUPER_ADMIN included', async () => {
      const b = await makeBusiness();
      for (let i = 0; i < 19; i += 1) await makeUser(UserRole.ADMIN, b.id);
      await createAdmin(rootToken, b.id, 'last.slot@admins.test'); // the 20th
      const res = await call('post', adminsPath(b.id), rootToken, { email: 'over.limit@admins.test' }).expect(409);
      expect(res.body.errorCode).toBe('BUSINESS_USER_LIMIT_REACHED');
      expect(await dataSource.query(`SELECT 1 FROM users WHERE email = 'over.limit@admins.test'`)).toEqual([]);
    });
  });

  describe('listing', () => {
    it('lists only the ADMINs of that business, without hashes or internal fields; never SUPER_ADMIN rows or other businesses', async () => {
      const b = await makeBusiness();
      const other = await makeBusiness();
      const a1 = await makeUser(UserRole.ADMIN, b.id);
      const a2 = await makeUser(UserRole.ADMIN, b.id, { active: false });
      await makeUser(UserRole.ADMIN, other.id);
      await makeUser(UserRole.SUPER_ADMIN, b.id); // an (unusual) SUPER_ADMIN row that points at the business: still never listed
      const res = await call('get', adminsPath(b.id), rootToken).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.map((u: { id: string }) => u.id)).toEqual([a1.id, a2.id]);
      expect(res.body[1]).toMatchObject({ active: false, role: 'ADMIN' });
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(/\$2[aby]\$|passwordHash|password_hash|credentialsVersion|credentials_version/);
      for (const u of res.body) expect(Object.keys(u).sort()).toEqual(['active', 'businessId', 'createdAt', 'email', 'id', 'mustChangePassword', 'role', 'updatedAt']);
    });
  });

  describe('isolation between businesses and protection of other accounts', () => {
    it('a user of another business, a SUPER_ADMIN or an unknown id is the same 404 ADMIN_NOT_FOUND on every operation, and nothing changes', async () => {
      const a = await makeBusiness();
      const b = await makeBusiness();
      await makeUser(UserRole.ADMIN, a.id);
      const foreign = await makeUser(UserRole.ADMIN, b.id);
      const before = await userRow(foreign.id);
      const rootBefore = await userRow(root.id);
      const auditBefore = (await auditRows(a.id)).length;
      for (const target of [foreign.id, root.id, ZERO_UUID]) {
        for (const op of ['deactivate', 'activate', 'reset-password']) {
          const res = await call('post', adminsPath(a.id, `/${target}/${op}`), rootToken);
          expect(res.status, `${op} ${target}`).toBe(404);
          expect(res.body.errorCode).toBe('ADMIN_NOT_FOUND');
          expect(res.body.temporaryPassword).toBeUndefined();
        }
      }
      expect(await userRow(foreign.id)).toEqual(before);
      expect(await userRow(root.id)).toEqual(rootBefore);
      expect((await auditRows(a.id)).length).toBe(auditBefore);
    });

    it('the business in the URL decides: the same user id under a different business id is not found', async () => {
      const a = await makeBusiness();
      const b = await makeBusiness();
      const admin = await makeUser(UserRole.ADMIN, a.id);
      await makeUser(UserRole.ADMIN, a.id);
      expect((await call('post', adminsPath(b.id, `/${admin.id}/reset-password`), rootToken).expect(404)).body.errorCode).toBe('ADMIN_NOT_FOUND');
      await call('post', adminsPath(a.id, `/${admin.id}/reset-password`), rootToken).expect(200).then((r) => everyTemporaryPassword.push(r.body.temporaryPassword));
    });
  });

  describe('activating and deactivating', () => {
    it('deactivation blocks the user at once, revokes their tokens for good, touches nothing else and is audited; repeating it is a quiet no-op', async () => {
      const b = await makeBusiness();
      const keep = await makeUser(UserRole.ADMIN, b.id);
      const target = await makeUser(UserRole.ADMIN, b.id);
      const otherBusinessAdmin = await makeUser(UserRole.ADMIN, (await makeBusiness()).id);
      const targetToken = await tokenFor(target);
      await call('get', '/products/admin', targetToken).expect(200);
      const before = await userRow(target.id);
      const othersBefore = [await userRow(keep.id), await userRow(otherBusinessAdmin.id)];

      const res = await call('post', adminsPath(b.id, `/${target.id}/deactivate`), rootToken).expect(200);
      expect(res.body).toMatchObject({ id: target.id, active: false, role: 'ADMIN', businessId: b.id });
      expect(JSON.stringify(res.body)).not.toMatch(/temporaryPassword|\$2[aby]\$/);
      const after = await userRow(target.id);
      expect(after).toMatchObject({ active: false, role: 'ADMIN', business_id: b.id, hash_md5: before.hash_md5, credentials_version: before.credentials_version + 1 });
      await call('get', '/products/admin', targetToken).expect(401); // immediately
      await call('get', '/auth/me', targetToken).expect(401);
      await call('post', '/auth/login', null, { email: target.email, password: PASSWORD }).expect(401);
      expect((await dataSource.query(`SELECT active FROM businesses WHERE id = $1`, [b.id]) as Array<{ active: boolean }>)[0]!.active).toBe(true); // the business is not deactivated
      expect([await userRow(keep.id), await userRow(otherBusinessAdmin.id)]).toEqual(othersBefore);
      await call('get', '/products/admin', await tokenFor(keep)).expect(200); // the other admin keeps working

      const rows = await auditRows(b.id, 'USER_ADMIN_DEACTIVATED');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ business_id: b.id, user_id: root.id, user_email: root.email, entity_type: 'User', entity_id: target.id, metadata: { email: target.email } });

      const again = await call('post', adminsPath(b.id, `/${target.id}/deactivate`), rootToken).expect(200);
      expect(again.body.active).toBe(false);
      expect((await userRow(target.id)).credentials_version).toBe(after.credentials_version); // no second bump
      expect(await auditRows(b.id, 'USER_ADMIN_DEACTIVATED')).toHaveLength(1); // no second audit row
    });

    it('activation restores access with the SAME password, keeps old tokens revoked, does not clear must_change_password, is idempotent and audited', async () => {
      const b = await makeBusiness();
      await makeUser(UserRole.ADMIN, b.id);
      const target = await makeUser(UserRole.ADMIN, b.id, { mustChange: true });
      const oldToken = await tokenFor(target);
      await call('post', adminsPath(b.id, `/${target.id}/deactivate`), rootToken).expect(200);
      const deactivated = await userRow(target.id);

      const res = await call('post', adminsPath(b.id, `/${target.id}/activate`), rootToken).expect(200);
      expect(res.body).toMatchObject({ id: target.id, active: true, mustChangePassword: true });
      const after = await userRow(target.id);
      expect(after).toMatchObject({ active: true, must_change_password: true, hash_md5: deactivated.hash_md5, credentials_version: deactivated.credentials_version }); // not bumped again
      await call('get', '/auth/me', oldToken).expect(401); // still revoked: the deactivation bumped the version
      const login = await call('post', '/auth/login', null, { email: target.email, password: PASSWORD }).expect(200);
      expect(login.body.user.mustChangePassword).toBe(true);
      await call('get', '/auth/me', login.body.accessToken).expect(200);

      await call('post', adminsPath(b.id, `/${target.id}/activate`), rootToken).expect(200); // idempotent
      expect(await auditRows(b.id, 'USER_ADMIN_ACTIVATED')).toHaveLength(1);
      expect(await auditRows(b.id, 'USER_ADMIN_DEACTIVATED')).toHaveLength(1);
    });

    it('RULE: the last ACTIVE admin of a business cannot be deactivated (409 LAST_ACTIVE_ADMIN) — active OR suspended; inactive admins do not count', async () => {
      for (const businessActive of [true, false]) {
        const label = businessActive ? 'active' : 'suspended';
        const sole = await makeBusiness({ active: businessActive });
        const only = await makeUser(UserRole.ADMIN, sole.id);
        const refusal = await call('post', adminsPath(sole.id, `/${only.id}/deactivate`), rootToken);
        expect(refusal.status, `${label}: single active admin`).toBe(409);
        expect(refusal.body.errorCode).toBe('LAST_ACTIVE_ADMIN');
        const row = await userRow(only.id);
        expect(row.active, label).toBe(true);
        expect(await auditRows(sole.id, 'USER_ADMIN_DEACTIVATED')).toEqual([]);
        // an inactive admin next to the only active one does not make it deactivatable
        await makeUser(UserRole.ADMIN, sole.id, { active: false });
        expect((await call('post', adminsPath(sole.id, `/${only.id}/deactivate`), rootToken)).status, `${label}: one active + one inactive`).toBe(409);
        expect((await userRow(only.id)).credentials_version).toBe(row.credentials_version); // refused: nothing was bumped
      }
    });

    it('with two or more active admins one can be deactivated — in an active or a suspended business — and then the remaining one is protected', async () => {
      for (const businessActive of [true, false]) {
        const b = await makeBusiness({ active: businessActive });
        const first = await makeUser(UserRole.ADMIN, b.id);
        const second = await makeUser(UserRole.ADMIN, b.id);
        const third = await makeUser(UserRole.ADMIN, b.id);
        await call('post', adminsPath(b.id, `/${first.id}/deactivate`), rootToken).expect(200);
        await call('post', adminsPath(b.id, `/${second.id}/deactivate`), rootToken).expect(200); // `third` is still active
        expect((await call('post', adminsPath(b.id, `/${third.id}/deactivate`), rootToken).expect(409)).body.errorCode).toBe('LAST_ACTIVE_ADMIN');
        await call('post', adminsPath(b.id, `/${first.id}/activate`), rootToken).expect(200); // reactivating is always allowed
        await call('post', adminsPath(b.id, `/${third.id}/deactivate`), rootToken).expect(200); // `first` is active again
        expect((await call('post', adminsPath(b.id, `/${first.id}/deactivate`), rootToken).expect(409)).body.errorCode).toBe('LAST_ACTIVE_ADMIN');
        expect([(await userRow(first.id)).active, (await userRow(second.id)).active, (await userRow(third.id)).active]).toEqual([true, false, false]);
      }
    });

    it('a business with NO admins is valid while it is being provisioned: it lists empty and the first admin can be created (the rule only forbids removing the last active one)', async () => {
      for (const businessActive of [true, false]) {
        const b = await makeBusiness({ active: businessActive });
        expect((await call('get', adminsPath(b.id), rootToken).expect(200)).body).toEqual([]);
        const first = await createAdmin(rootToken, b.id, `first.${b.id.slice(0, 8)}@admins.test`);
        expect(first.body.user).toMatchObject({ active: true, businessId: b.id });
        expect((await call('post', adminsPath(b.id, `/${first.body.user.id}/deactivate`), rootToken).expect(409)).body.errorCode).toBe('LAST_ACTIVE_ADMIN'); // and it is now protected
      }
    });

    it('reactivating a business changes neither the activity nor the credentials of its administrators (the business lifecycle is untouched)', async () => {
      const b = await makeBusiness();
      const active = await makeUser(UserRole.ADMIN, b.id, { mustChange: true });
      const inactive = await makeUser(UserRole.ADMIN, b.id, { active: false });
      const before = [await userRow(active.id), await userRow(inactive.id)];
      await call('post', `/businesses/${b.id}/deactivate`, rootToken).expect(200);
      expect([await userRow(active.id), await userRow(inactive.id)]).toEqual(before); // suspending does not touch them either
      await call('post', `/businesses/${b.id}/activate`, rootToken).expect(200);
      expect([await userRow(active.id), await userRow(inactive.id)]).toEqual(before);
      const [a, i] = before;
      expect([a!.active, a!.must_change_password, i!.active]).toEqual([true, true, false]);
    });
  });

  describe('resetting a password', () => {
    it('stores a new hash, bumps the version, forces a change, revokes old tokens and returns the password once; a new reset replaces it', async () => {
      const b = await makeBusiness();
      const target = await makeUser(UserRole.ADMIN, b.id);
      const oldToken = await tokenFor(target);
      await call('get', '/products/admin', oldToken).expect(200);
      const before = await userRow(target.id);

      const res = await resetAdmin(rootToken, b.id, target.id);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(Object.keys(res.body).sort()).toEqual(['temporaryPassword', 'user']);
      expect(res.body.temporaryPassword).toMatch(TEMP_PATTERN);
      expect(res.body.user).toMatchObject({ id: target.id, mustChangePassword: true, active: true, role: 'ADMIN', businessId: b.id });
      const after = await userRow(target.id);
      expect(after.credentials_version).toBe(before.credentials_version + 1);
      expect(after.must_change_password).toBe(true);
      expect(after.password_hash.startsWith('$2b$12$')).toBe(true);
      expect(await bcrypt.compare(res.body.temporaryPassword, after.password_hash)).toBe(true);
      expect([after.role, after.business_id, after.email]).toEqual([before.role, before.business_id, before.email]);

      await call('get', '/products/admin', oldToken).expect(401); // old session revoked
      await call('post', '/auth/login', null, { email: target.email, password: PASSWORD }).expect(401); // old password dead
      const login = await call('post', '/auth/login', null, { email: target.email, password: res.body.temporaryPassword }).expect(200);
      expect(login.body.user.mustChangePassword).toBe(true);
      expect((await call('get', '/products/admin', login.body.accessToken).expect(403)).body.errorCode).toBe('PASSWORD_CHANGE_REQUIRED');

      // the response was "lost": a new authorised reset simply replaces it
      const second = await resetAdmin(rootToken, b.id, target.id);
      expect(second.body.temporaryPassword).not.toBe(res.body.temporaryPassword);
      await call('post', '/auth/login', null, { email: target.email, password: res.body.temporaryPassword }).expect(401);
      await call('post', '/auth/login', null, { email: target.email, password: second.body.temporaryPassword }).expect(200);
      expect((await userRow(target.id)).credentials_version).toBe(before.credentials_version + 2);
    });

    it('works for a deactivated admin (reactivation then needs no new password) and for a suspended business', async () => {
      const b = await makeBusiness();
      await makeUser(UserRole.ADMIN, b.id);
      const inactive = await makeUser(UserRole.ADMIN, b.id, { active: false });
      await resetAdmin(rootToken, b.id, inactive.id);
      expect((await userRow(inactive.id)).active).toBe(false); // the reset does not reactivate

      const suspended = await makeBusiness({ active: false });
      const inSuspended = await makeUser(UserRole.ADMIN, suspended.id);
      await resetAdmin(rootToken, suspended.id, inSuspended.id);
    });

    it('two concurrent resets from the same snapshot: exactly one wins (409 CREDENTIALS_CHANGED for the late one), one version bump, and the password the SUPER_ADMIN received is the one that works', async () => {
      const b = await makeBusiness();
      const target = await makeUser(UserRole.ADMIN, b.id);
      const before = await userRow(target.id);
      const original = dataSource.transaction.bind(dataSource) as (...args: unknown[]) => Promise<unknown>;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let paused!: () => void;
      const reachedWrite = new Promise<void>((resolve) => (paused = resolve));
      const spy = vi.spyOn(dataSource, 'transaction').mockImplementationOnce((async (...args: unknown[]) => {
        paused(); // request A has read version v and is about to write...
        await gate; // ...and waits
        return original(...args);
      }) as never);
      try {
        const late = call('post', adminsPath(b.id, `/${target.id}/reset-password`), rootToken).then((r) => r);
        await reachedWrite;
        const winner = await resetAdmin(rootToken, b.id, target.id); // B commits first
        release();
        const lateRes = await late;

        expect(lateRes.status).toBe(409);
        expect(lateRes.body.errorCode).toBe('CREDENTIALS_CHANGED');
        expect(lateRes.body.temporaryPassword).toBeUndefined(); // the late writer's password was never returned
        const after = await userRow(target.id);
        expect(after.credentials_version).toBe(before.credentials_version + 1);
        expect(await bcrypt.compare(winner.body.temporaryPassword, after.password_hash)).toBe(true);
        expect(await auditRows(b.id, 'USER_ADMIN_PASSWORD_RESET')).toHaveLength(1); // the refused attempt left no trace of a change
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('audit', () => {
    it('create, activate, deactivate and reset are recorded against the TARGET business with the SUPER_ADMIN as actor; metadata is only the email; no secret anywhere', async () => {
      const b = await makeBusiness();
      await makeUser(UserRole.ADMIN, b.id);
      const created = await createAdmin(rootToken, b.id, 'audited@admins.test');
      const id = created.body.user.id as string;
      await call('post', adminsPath(b.id, `/${id}/deactivate`), rootToken).expect(200);
      await call('post', adminsPath(b.id, `/${id}/activate`), rootToken).expect(200);
      const reset = await resetAdmin(rootToken, b.id, id);

      const rows = await auditRows(b.id);
      expect(rows.map((r) => r.action)).toEqual(['USER_ADMIN_CREATED', 'USER_ADMIN_DEACTIVATED', 'USER_ADMIN_ACTIVATED', 'USER_ADMIN_PASSWORD_RESET']);
      for (const r of rows) {
        expect(r).toMatchObject({ business_id: b.id, user_id: root.id, user_email: root.email, entity_type: 'User', entity_id: id, metadata: { email: 'audited@admins.test' } });
        expect(r.ip_address).toMatch(/^192\.0\.\d+\.\d+$/);
      }
      const text = JSON.stringify(await dataSource.query(`SELECT * FROM audit_logs WHERE business_id = $1`, [b.id]));
      for (const secret of [created.body.temporaryPassword as string, reset.body.temporaryPassword as string, rootToken]) expect(text).not.toContain(secret);
      expect(text).not.toMatch(/\$2[aby]\$/);
      // and the entries are readable through the existing audit endpoint, scoped to that business
      const listed = await call('get', `/audit-logs?businessId=${b.id}&entityType=User`, rootToken).expect(200);
      expect(JSON.stringify(listed.body)).toContain('USER_ADMIN_PASSWORD_RESET');
    });

    it('is written IN THE SAME TRANSACTION as the change: if the audit insert fails the whole operation rolls back (no change without a trace)', async () => {
      const b = await makeBusiness();
      const keep = await makeUser(UserRole.ADMIN, b.id);
      const target = await makeUser(UserRole.ADMIN, b.id);
      const before = await userRow(target.id);
      const usersBefore = (await dataSource.query(`SELECT count(*)::int AS n FROM users`) as Array<{ n: number }>)[0]!.n;

      for (const [method, path, body] of [
        ['post', adminsPath(b.id), { email: 'untraced@admins.test' }],
        ['post', adminsPath(b.id, `/${target.id}/deactivate`), undefined],
        ['post', adminsPath(b.id, `/${target.id}/reset-password`), undefined],
      ] as Array<[Method, string, unknown]>) {
        const spy = vi.spyOn(audit, 'recordInTransaction' as never).mockRejectedValueOnce(new Error('audit store down') as never);
        try {
          const res = await call(method, path, rootToken, body);
          expect(res.status, path).toBe(500);
          expect(res.body.temporaryPassword).toBeUndefined();
        } finally {
          spy.mockRestore();
        }
      }
      expect(await userRow(target.id)).toEqual(before); // not deactivated, not reset
      expect((await dataSource.query(`SELECT count(*)::int AS n FROM users`) as Array<{ n: number }>)[0]!.n).toBe(usersBefore); // not created
      expect(await dataSource.query(`SELECT 1 FROM users WHERE email = 'untraced@admins.test'`)).toEqual([]);
      expect(keep.id).toBeDefined();
    });
  });

  describe('suspended businesses', () => {
    it('the SUPER_ADMIN can still manage the accounts (list, create, reset, deactivate, activate) while the ADMINs of that business cannot operate, active or not', async () => {
      const suspended = await makeBusiness({ active: false });
      const existing = await makeUser(UserRole.ADMIN, suspended.id);
      const spare = await makeUser(UserRole.ADMIN, suspended.id);

      await call('get', adminsPath(suspended.id), rootToken).expect(200);
      const created = await createAdmin(rootToken, suspended.id, 'in.suspended@admins.test');
      await resetAdmin(rootToken, suspended.id, existing.id);
      await call('post', adminsPath(suspended.id, `/${spare.id}/deactivate`), rootToken).expect(200);
      await call('post', adminsPath(suspended.id, `/${spare.id}/activate`), rootToken).expect(200);

      // the business itself is untouched by any of it ...
      expect((await dataSource.query(`SELECT active FROM businesses WHERE id = $1`, [suspended.id]) as Array<{ active: boolean }>)[0]!.active).toBe(false);
      // ... and its admins cannot get in, even the brand-new one with a valid temporary password
      const login = await call('post', '/auth/login', null, { email: 'in.suspended@admins.test', password: created.body.temporaryPassword }).expect(403);
      expect(login.body.errorCode).toBe('BUSINESS_INACTIVE');
      expect((await call('get', '/products/admin', await tokenFor(spare)).expect(403)).body.errorCode).toBe('BUSINESS_INACTIVE');
    });
  });

  describe('rate limits (the real ones)', () => {
    it('create: the 11th attempt of the same SUPER_ADMIN in a minute is a 429, failed attempts included; reset has its own counter; reads are not limited', async () => {
      const limited = await makeUser(UserRole.SUPER_ADMIN, null);
      const token = await tokenFor(limited);
      for (let i = 0; i < 10; i += 1) await call('post', adminsPath(biz.id), token, { email: 'invalid' }).expect(400); // every attempt counts
      const res = await call('post', adminsPath(biz.id), token, { email: 'valid.after.limit@admins.test' });
      expect(res.status).toBe(429);
      expect(res.body.errorCode).toBe('RATE_LIMITED');
      expect(await dataSource.query(`SELECT 1 FROM users WHERE email = 'valid.after.limit@admins.test'`)).toEqual([]);
      // each route has its own counter (the project's rate-limit buckets are per route): reset is not blocked by create's
      expect((await call('post', adminsPath(biz.id, `/${ZERO_UUID}/reset-password`), token)).status).toBe(404);
      await call('get', adminsPath(biz.id), token).expect(200); // reads are not part of the policy
    });

    it('reset: the 11th attempt of the same SUPER_ADMIN in a minute is a 429', async () => {
      const limited = await makeUser(UserRole.SUPER_ADMIN, null);
      const token = await tokenFor(limited);
      for (let i = 0; i < 10; i += 1) await call('post', adminsPath(biz.id, `/${ZERO_UUID}/reset-password`), token).expect(404);
      const res = await call('post', adminsPath(biz.id, `/${ZERO_UUID}/reset-password`), token);
      expect(res.status).toBe(429);
      expect(res.body.errorCode).toBe('RATE_LIMITED');
    });

    it('the per-IP cap is 20 per minute, counted before authentication (unauthenticated attempts count too)', async () => {
      const ip = nextIp();
      const post = () => request(baseUrl()).post(adminsPath(biz.id)).set('X-Real-IP', ip).send({ email: 'x@admins.test' });
      for (let i = 0; i < 20; i += 1) await post().expect(401);
      expect((await post()).status).toBe(429);
    });

    it('activate / deactivate: 30 per minute per SUPER_ADMIN on each route; the 31st is a 429 and changes nothing', async () => {
      const limited = await makeUser(UserRole.SUPER_ADMIN, null);
      const token = await tokenFor(limited);
      const b = await makeBusiness();
      const target = await makeUser(UserRole.ADMIN, b.id);
      await makeUser(UserRole.ADMIN, b.id);
      for (let i = 0; i < 30; i += 1) await call('post', adminsPath(b.id, `/${target.id}/activate`), token).expect(200); // idempotent no-ops
      const res = await call('post', adminsPath(b.id, `/${target.id}/activate`), token);
      expect(res.status).toBe(429);
      expect(res.body.errorCode).toBe('RATE_LIMITED');
      expect((await userRow(target.id)).active).toBe(true);
    });
  });

  it('no temporary password, hash or token appears in the logs, in the database outside the hash column, or in any ordinary response', async () => {
    const logs = captured.join('');
    expect(everyTemporaryPassword.length).toBeGreaterThan(10);
    for (const password of everyTemporaryPassword) expect(logs.includes(password), 'a temporary password reached the logs').toBe(false);
    expect(logs).not.toMatch(/\$2[aby]\$\d\d\$/);
    expect(logs).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./);
    // never stored in clear anywhere: not in users (except as a bcrypt hash), not in audit_logs
    const dump = JSON.stringify(await dataSource.query(`SELECT id, email, role, business_id, active, credentials_version, must_change_password FROM users`)) + JSON.stringify(await dataSource.query(`SELECT * FROM audit_logs`));
    for (const password of everyTemporaryPassword) expect(dump.includes(password)).toBe(false);
  });
});
