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
import { User } from '../src/user/user.entity.js';
import { UserRole } from '../src/user/user-role.enum.js';
import { runAllMigrations } from './support/run-all-migrations.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

const TEST_BCRYPT_COST = 4; // seeding only; the endpoints always hash with cost 12
const PASSWORD = 'Seeded-Passw0rd!';
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

// Definitive deletion of a deactivated, never-used ADMIN account (9D.1), end to end on ephemeral PGlite with the real rate
// limits. HONEST LIMIT: PGlite is a single Postgres session, so truly simultaneous transactions cannot race here. The
// "concurrent" tests are DETERMINISTIC interleavings (one request is held just before its transaction while another commits)
// that prove the state is re-judged under the lock at delete time. The real row-lock behaviour was exercised against an
// independent PostgreSQL (see the checkpoint), not here.
describe('Safe deletion of ADMIN accounts — SUPER_ADMIN only (e2e, real local Postgres)', () => {
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


  const deletePath = (businessId: string, userId: string) => adminsPath(businessId, `/${userId}/delete`);
  const exists = async (id: string) => ((await dataSource.query(`SELECT 1 FROM users WHERE id = $1`, [id])) as unknown[]).length === 1;

  // A business with one KEEPER (active admin that makes the others deactivable) and the admin under test, created through
  // the API (so its audit trail is the real one) and deactivated through the API.
  async function scenario(opts: { deactivate?: boolean } = {}) {
    const b = await makeBusiness();
    const keeper = await createAdmin(rootToken, b.id, `keeper${(counter += 1)}@del.test`);
    const email = `target${(counter += 1)}@del.test`;
    const created = await createAdmin(rootToken, b.id, email);
    const id = created.body.user.id as string;
    if (opts.deactivate !== false) await call('post', adminsPath(b.id, `/${id}/deactivate`), rootToken).expect(200);
    return { b, id, email, tempPassword: created.body.temporaryPassword as string, keeperId: keeper.body.user.id as string };
  }
  const del = (token: string | null, businessId: string, userId: string, confirmEmail?: string) =>
    call('post', deletePath(businessId, userId), token, confirmEmail === undefined ? {} : { confirmEmail });

  describe('the eligible case', () => {
    it('deletes a deactivated admin that never changed its initial password — even one that logged in with the temporary password — and nothing else', async () => {
      const s = await scenario({ deactivate: false });
      // it DID log in with the temporary password (logins are not audited): all it got was a restricted token
      const login = await call('post', '/auth/login', null, { email: s.email, password: s.tempPassword }).expect(200);
      const blocked = await call('get', '/products/admin', login.body.accessToken).expect(403);
      expect(blocked.body.errorCode).toBe('PASSWORD_CHANGE_REQUIRED');
      await call('post', adminsPath(s.b.id, `/${s.id}/deactivate`), rootToken).expect(200);
      const keeperBefore = await userRow(s.keeperId);
      const usersBefore = ((await dataSource.query(`SELECT count(*)::int AS n FROM users`)) as Array<{ n: number }>)[0]!.n;

      const res = await del(rootToken, s.b.id, s.id, s.email).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({ deleted: true, alreadyDeleted: false, id: s.id, email: s.email, businessId: s.b.id });
      expect(JSON.stringify(res.body)).not.toMatch(/hash|password|token/i);

      expect(await exists(s.id)).toBe(false);
      expect(await userRow(s.keeperId)).toEqual(keeperBefore);
      expect(((await dataSource.query(`SELECT count(*)::int AS n FROM users`)) as Array<{ n: number }>)[0]!.n).toBe(usersBefore - 1);
      expect(await dataSource.query(`SELECT 1 FROM businesses WHERE id = $1`, [s.b.id])).toHaveLength(1);

      // every token it held is dead, and so is its password
      await call('get', '/auth/me', login.body.accessToken).expect(401);
      await call('post', '/auth/login', null, { email: s.email, password: s.tempPassword }).expect(401);
      const list = await call('get', adminsPath(s.b.id), rootToken).expect(200);
      expect((list.body as Array<{ id: string }>).map((a) => a.id)).toEqual([s.keeperId]);
    });

    it('the confirmation e-mail is normalised (trim + case)', async () => {
      const s = await scenario();
      await call('post', deletePath(s.b.id, s.id), rootToken, { confirmEmail: `  ${s.email.toUpperCase()}  ` }).expect(200);
      expect(await exists(s.id)).toBe(false);
    });

    it('frees the e-mail at once: a new account with the same address gets a NEW id, and the old tokens never revive', async () => {
      const s = await scenario({ deactivate: false });
      const oldToken = (await call('post', '/auth/login', null, { email: s.email, password: s.tempPassword }).expect(200)).body.accessToken as string;
      await call('post', adminsPath(s.b.id, `/${s.id}/deactivate`), rootToken).expect(200);
      await del(rootToken, s.b.id, s.id, s.email).expect(200);
      await call('get', '/auth/me', oldToken).expect(401);

      const again = await createAdmin(rootToken, s.b.id, s.email);
      expect(again.body.user.id).not.toBe(s.id);
      await call('get', '/auth/me', oldToken).expect(401); // same e-mail, different account: the old token stays dead
      const newLogin = await call('post', '/auth/login', null, { email: s.email, password: again.body.temporaryPassword }).expect(200);
      expect(newLogin.body.user.id).toBe(again.body.user.id);
      await call('get', '/auth/me', newLogin.body.accessToken).expect(200);
    });
  });

  describe('identity of the history', () => {
    it('events of an EARLIER account with the same e-mail never count for (or against) the current one: the whole cycle can repeat', async () => {
      const s = await scenario();
      await del(rootToken, s.b.id, s.id, s.email).expect(200);
      const second = await createAdmin(rootToken, s.b.id, s.email);
      await call('post', adminsPath(s.b.id, `/${second.body.user.id}/deactivate`), rootToken).expect(200);
      await del(rootToken, s.b.id, second.body.user.id, s.email).expect(200);
      expect(await exists(second.body.user.id)).toBe(false);
      expect(await auditRows(s.b.id, 'USER_ADMIN_DELETED')).toHaveLength(2);
    });

    it('a deletion of the same e-mail by ANOTHER id, or of the same id in ANOTHER business, is not taken for "already deleted"', async () => {
      const s = await scenario();
      await del(rootToken, s.b.id, s.id, s.email).expect(200);
      const second = await createAdmin(rootToken, s.b.id, s.email); // same e-mail, new id, still alive
      const res = await del(rootToken, s.b.id, second.body.user.id, s.email);
      expect(res.status).toBe(409);
      expect(res.body.errorCode).toBe('ADMIN_STILL_ACTIVE');
      expect(await exists(second.body.user.id)).toBe(true);
      const ghostId = '99999999-9999-4999-8999-999999999999';
      expect((await del(rootToken, s.b.id, ghostId, s.email).expect(404)).body.errorCode).toBe('ADMIN_NOT_FOUND');
      const other = await makeBusiness();
      expect((await del(rootToken, other.id, s.id, s.email).expect(404)).body.errorCode).toBe('ADMIN_NOT_FOUND');
    });
  });

  describe('audit', () => {
    it('records USER_ADMIN_DELETED against the business with the SUPER_ADMIN as actor, keeps the whole earlier trail, and holds no secret', async () => {
      const s = await scenario();
      await del(rootToken, s.b.id, s.id, s.email).expect(200);
      const rows = await auditRows(s.b.id, 'USER_ADMIN_DELETED');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        business_id: s.b.id,
        user_id: root.id,
        user_email: root.email,
        action: 'USER_ADMIN_DELETED',
        entity_type: 'User',
        entity_id: s.id,
        metadata: { email: s.email },
      });
      expect(Object.keys(rows[0]!.metadata ?? {})).toEqual(['email']);
      // the trail about the deleted account survives it
      const about = (await auditRows(s.b.id)).filter((r) => r.entity_id === s.id).map((r) => r.action);
      expect(about).toEqual(['USER_ADMIN_CREATED', 'USER_ADMIN_DEACTIVATED', 'USER_ADMIN_DELETED']);
      const all = JSON.stringify(await auditRows(s.b.id));
      expect(all).not.toContain(s.tempPassword);
      expect(all).not.toMatch(/\$2[aby]\$/);
    });

    it('if the audit write fails the account is NOT deleted (same transaction): 500, row intact, no trace', async () => {
      const s = await scenario();
      const before = await userRow(s.id);
      const spy = vi.spyOn(audit, 'recordInTransaction' as never).mockRejectedValueOnce(new Error('audit store down') as never);
      try {
        await del(rootToken, s.b.id, s.id, s.email).expect(500);
      } finally {
        spy.mockRestore();
      }
      expect(await userRow(s.id)).toEqual(before);
      expect(await auditRows(s.b.id, 'USER_ADMIN_DELETED')).toEqual([]);
      await del(rootToken, s.b.id, s.id, s.email).expect(200); // and a retry succeeds
    });
  });

  describe('who may call it', () => {
    it('an ADMIN (even of that business) is 403 and nothing changes; no token is 401; a SUPER_ADMIN who must change password is stopped first', async () => {
      const s = await scenario();
      const adminToken = await tokenFor({ id: s.keeperId, email: 'keeper@del.test', role: UserRole.ADMIN, businessId: s.b.id });
      const before = await userRow(s.id);
      await del(adminToken, s.b.id, s.id, s.email).expect(403);
      await del(null, s.b.id, s.id, s.email).expect(401);
      const restricted = await makeUser(UserRole.SUPER_ADMIN, null, { mustChange: true });
      const res = await del(await tokenFor(restricted), s.b.id, s.id, s.email).expect(403);
      expect(res.body.errorCode).toBe('PASSWORD_CHANGE_REQUIRED');
      expect(await userRow(s.id)).toEqual(before);
      expect(await auditRows(s.b.id, 'USER_ADMIN_DELETED')).toEqual([]);
    });
  });

  describe('target validation', () => {
    it('a SUPER_ADMIN can never be deleted (403 ROLE_NOT_ALLOWED), even if inactive with a pending password change', async () => {
      const b = await makeBusiness();
      const sa = await makeUser(UserRole.SUPER_ADMIN, null, { active: false, mustChange: true });
      const before = await userRow(sa.id);
      const res = await del(rootToken, b.id, sa.id, sa.email).expect(403);
      expect(res.body.errorCode).toBe('ROLE_NOT_ALLOWED');
      expect(await userRow(sa.id)).toEqual(before);
    });

    it('an admin of ANOTHER business, a missing id and a missing business are 404 (never revealing the other tenant); a malformed id is 400', async () => {
      const s = await scenario();
      const other = await makeBusiness();
      const wrong = await del(rootToken, other.id, s.id, s.email).expect(404);
      expect(wrong.body.errorCode).toBe('ADMIN_NOT_FOUND');
      expect(JSON.stringify(wrong.body)).not.toContain(s.email);
      expect((await del(rootToken, s.b.id, ZERO_UUID, s.email).expect(404)).body.errorCode).toBe('ADMIN_NOT_FOUND');
      expect((await del(rootToken, ZERO_UUID, s.id, s.email).expect(404)).body.errorCode).toBe('BUSINESS_NOT_FOUND');
      await del(rootToken, s.b.id, 'not-a-uuid', s.email).expect(400);
      expect(await exists(s.id)).toBe(true);
    });
  });

  describe('confirmation', () => {
    it('requires the exact e-mail: wrong, missing or extra fields are 400 and nothing is deleted', async () => {
      const s = await scenario();
      expect((await del(rootToken, s.b.id, s.id, 'someone.else@del.test').expect(400)).body.errorCode).toBe('CONFIRMATION_MISMATCH');
      await del(rootToken, s.b.id, s.id).expect(400);
      await call('post', deletePath(s.b.id, s.id), rootToken, { confirmEmail: s.email, force: true }).expect(400);
      await call('post', deletePath(s.b.id, s.id), rootToken, { confirmEmail: 'not an email' }).expect(400);
      expect(await exists(s.id)).toBe(true);
      expect(await auditRows(s.b.id, 'USER_ADMIN_DELETED')).toEqual([]);
    });
  });

  describe('eligibility (each refusal is distinct and changes nothing)', () => {
    const refuse = async (b: Business, id: string, email: string, code: string, status = 409) => {
      const before = await userRow(id);
      const res = await del(rootToken, b.id, id, email);
      expect(res.status).toBe(status);
      expect(res.body.errorCode).toBe(code);
      expect(await userRow(id)).toEqual(before);
      expect(await auditRows(b.id, 'USER_ADMIN_DELETED')).toEqual([]);
    };

    it('an ACTIVE admin is refused (ADMIN_STILL_ACTIVE)', async () => {
      const s = await scenario({ deactivate: false });
      await refuse(s.b, s.id, s.email, 'ADMIN_STILL_ACTIVE');
    });

    it('the last ACTIVE admin of a business is refused with its own code (LAST_ACTIVE_ADMIN)', async () => {
      const b = await makeBusiness();
      const only = await createAdmin(rootToken, b.id, `only${(counter += 1)}@del.test`);
      await refuse(b, only.body.user.id, only.body.user.email, 'LAST_ACTIVE_ADMIN');
    });

    it('an admin that already changed its initial password is refused (ADMIN_PASSWORD_ALREADY_CHANGED)', async () => {
      const s = await scenario({ deactivate: false });
      const login = await call('post', '/auth/login', null, { email: s.email, password: s.tempPassword }).expect(200);
      await call('post', '/auth/change-password', login.body.accessToken, { currentPassword: s.tempPassword, newPassword: 'My-Own-Passw0rd!' }).expect(200);
      await call('post', adminsPath(s.b.id, `/${s.id}/deactivate`), rootToken).expect(200);
      await refuse(s.b, s.id, s.email, 'ADMIN_PASSWORD_ALREADY_CHANGED');
    });

    it('an admin with audit rows attributed to it is refused (ADMIN_HAS_ACTIVITY): by user id, by author e-mail, or in the platform trail', async () => {
      const insertAudit = (businessId: string, userId: string | null, userEmail: string) =>
        dataSource.query(`INSERT INTO audit_logs (business_id, user_id, user_email, action, entity_type) VALUES ($1, $2, $3, 'PRODUCT_CREATED', 'Product')`, [businessId, userId, userEmail]);

      const byId = await scenario();
      await insertAudit(byId.b.id, byId.id, byId.email);
      await refuse(byId.b, byId.id, byId.email, 'ADMIN_HAS_ACTIVITY');

      const byEmail = await scenario();
      const otherBiz = await makeBusiness();
      await insertAudit(otherBiz.id, null, byEmail.email.toUpperCase()); // another business, author snapshot only
      await refuse(byEmail.b, byEmail.id, byEmail.email, 'ADMIN_HAS_ACTIVITY');

      const platform = await scenario();
      await dataSource.query(`INSERT INTO platform_audit_logs (action, source, target_user_id, target_email) VALUES ('TEST_EVENT', 'test-suite', $1, $2)`, [platform.id, platform.email]);
      await refuse(platform.b, platform.id, platform.email, 'ADMIN_HAS_ACTIVITY');
    });

    it('a history other than exactly created + deactivated is refused (ADMIN_HISTORY_INCOMPATIBLE): reset, reactivation, missing trail, mismatching version', async () => {
      const reset = await scenario();
      await resetAdmin(rootToken, reset.b.id, reset.id);
      await refuse(reset.b, reset.id, reset.email, 'ADMIN_HISTORY_INCOMPATIBLE');

      const cycled = await scenario();
      await call('post', adminsPath(cycled.b.id, `/${cycled.id}/activate`), rootToken).expect(200);
      await call('post', adminsPath(cycled.b.id, `/${cycled.id}/deactivate`), rootToken).expect(200);
      await refuse(cycled.b, cycled.id, cycled.email, 'ADMIN_HISTORY_INCOMPATIBLE');

      const untraced = await makeBusiness();
      await createAdmin(rootToken, untraced.id, `keeper${(counter += 1)}@del.test`);
      const ghost = await makeUser(UserRole.ADMIN, untraced.id, { active: false, mustChange: true });
      await dataSource.query(`UPDATE users SET credentials_version = 1 WHERE id = $1`, [ghost.id]);
      await refuse(untraced, ghost.id, ghost.email, 'ADMIN_HISTORY_INCOMPATIBLE'); // looks pristine, but nothing in the trail says so
    });

    it('a trail whose rows are not exactly this account\'s CREATED + DEACTIVATED (type, business, e-mail, count) is refused (ADMIN_HISTORY_INCOMPATIBLE)', async () => {
      // a row about the account that is not the exact CREATED/DEACTIVATED of this business, type and e-mail
      const drift = await scenario();
      await dataSource.query(`UPDATE users SET credentials_version = 2 WHERE id = $1`, [drift.id]);
      await refuse(drift.b, drift.id, drift.email, 'ADMIN_HISTORY_INCOMPATIBLE');
      const foreign = await scenario();
      await dataSource.query(`UPDATE audit_logs SET entity_type = 'Product' WHERE entity_id = $1 AND action = 'USER_ADMIN_CREATED'`, [foreign.id]);
      await refuse(foreign.b, foreign.id, foreign.email, 'ADMIN_HISTORY_INCOMPATIBLE');
      const otherEmail = await scenario();
      await dataSource.query(`UPDATE audit_logs SET metadata = '{"email":"someone.else@del.test"}' WHERE entity_id = $1 AND action = 'USER_ADMIN_DEACTIVATED'`, [otherEmail.id]);
      await refuse(otherEmail.b, otherEmail.id, otherEmail.email, 'ADMIN_HISTORY_INCOMPATIBLE');
      const extra = await scenario();
      await dataSource.query(`INSERT INTO audit_logs (business_id, user_id, user_email, action, entity_type, entity_id, metadata) VALUES ($1, $2, $3, 'USER_ADMIN_DEACTIVATED', 'User', $4, $5)`, [extra.b.id, root.id, root.email, extra.id, JSON.stringify({ email: extra.email })]);
      await refuse(extra.b, extra.id, extra.email, 'ADMIN_HISTORY_INCOMPATIBLE'); // two deactivations is not the pristine trail
    });
  });

  describe('repeated and concurrent requests', () => {
    it('a repeat after success answers 200 alreadyDeleted (proved by the audit trail), writes nothing more, and still demands the e-mail; unrelated ids stay 404', async () => {
      const s = await scenario();
      await del(rootToken, s.b.id, s.id, s.email).expect(200);
      const again = await del(rootToken, s.b.id, s.id, s.email).expect(200);
      expect(again.body).toEqual({ deleted: true, alreadyDeleted: true, id: s.id, email: s.email, businessId: s.b.id });
      expect(await auditRows(s.b.id, 'USER_ADMIN_DELETED')).toHaveLength(1);
      expect((await del(rootToken, s.b.id, s.id, 'wrong@del.test').expect(400)).body.errorCode).toBe('CONFIRMATION_MISMATCH');
      const other = await makeBusiness();
      expect((await del(rootToken, other.id, s.id, s.email).expect(404)).body.errorCode).toBe('ADMIN_NOT_FOUND'); // another business has no such deletion
    });

    // A request is held just before its transaction; another request commits; then the first one proceeds and must judge
    // the CURRENT state, not the one that existed when it arrived.
    async function heldRequest<T>(whileHeld: () => Promise<unknown>, send: () => Promise<T>): Promise<T> {
      const original = dataSource.transaction.bind(dataSource) as (...args: unknown[]) => Promise<unknown>;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let paused!: () => void;
      const reached = new Promise<void>((resolve) => (paused = resolve));
      const spy = vi.spyOn(dataSource, 'transaction').mockImplementationOnce((async (...args: unknown[]) => {
        paused();
        await gate;
        return original(...args);
      }) as never);
      try {
        const held = send();
        await reached;
        await whileHeld();
        release();
        return await held;
      } finally {
        spy.mockRestore();
      }
    }

    it('two simultaneous deletions of the same admin: exactly one deletes and audits, the other is told it was already done', async () => {
      const s = await scenario();
      const late = await heldRequest(
        () => del(rootToken, s.b.id, s.id, s.email).expect(200),
        () => Promise.resolve(del(rootToken, s.b.id, s.id, s.email)).then((r) => r),
      );
      expect(late.status).toBe(200);
      expect(late.body.alreadyDeleted).toBe(true);
      expect(await auditRows(s.b.id, 'USER_ADMIN_DELETED')).toHaveLength(1);
      expect(await exists(s.id)).toBe(false);
    });

    it('eligibility is re-judged at delete time: if the admin is reactivated, or its password reset, while the request is in flight, the deletion is refused', async () => {
      const activated = await scenario();
      const r1 = await heldRequest(
        () => call('post', adminsPath(activated.b.id, `/${activated.id}/activate`), rootToken).expect(200),
        () => Promise.resolve(del(rootToken, activated.b.id, activated.id, activated.email)).then((r) => r),
      );
      expect(r1.status).toBe(409);
      expect(r1.body.errorCode).toBe('ADMIN_STILL_ACTIVE');
      expect(await exists(activated.id)).toBe(true);

      const reset = await scenario();
      const r2 = await heldRequest(
        () => resetAdmin(rootToken, reset.b.id, reset.id),
        () => Promise.resolve(del(rootToken, reset.b.id, reset.id, reset.email)).then((r) => r),
      );
      expect(r2.status).toBe(409);
      expect(r2.body.errorCode).toBe('ADMIN_HISTORY_INCOMPATIBLE');
      expect(await exists(reset.id)).toBe(true);
      expect(await auditRows(reset.b.id, 'USER_ADMIN_DELETED')).toEqual([]);
    });
  });

  describe('rate limit', () => {
    it('shares the provisioning cap (10 per minute per SUPER_ADMIN): the 11th attempt is a 429 and deletes nothing, refused attempts included', async () => {
      const s = await scenario();
      for (let i = 0; i < 10; i += 1) await del(rootToken, s.b.id, s.id, 'wrong@del.test').expect(400);
      await del(rootToken, s.b.id, s.id, s.email).expect(429);
      expect(await exists(s.id)).toBe(true);
    });
  });

  it('no temporary password appears in the logs or in the audit trail', async () => {
    expect(everyTemporaryPassword.length).toBeGreaterThan(0);
    const logs = captured.join('\n');
    for (const password of everyTemporaryPassword) {
      expect(logs).not.toContain(password);
      expect(JSON.stringify(await dataSource.query(`SELECT metadata FROM audit_logs`))).not.toContain(password);
    }
  });
});
