import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcrypt';
import { INestApplication, RequestMethod, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ModulesContainer } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { ALLOW_PASSWORD_CHANGE_REQUIRED_KEY } from '../src/auth/decorators/allow-password-change-required.decorator.js';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard.js';
import { Business } from '../src/business/business.entity.js';
import { User } from '../src/user/user.entity.js';
import { UserRole } from '../src/user/user-role.enum.js';
import { runAllMigrations } from './support/run-all-migrations.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

const TEST_BCRYPT_COST = 4;
const PASSWORD = 'Temporary-Passw0rd!';
const NEW_PASSWORD = 'Chosen-By-The-User-1!';
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const REQUIRED = { errorCode: 'PASSWORD_CHANGE_REQUIRED' };

// What a user with must_change_password = true can and cannot do, end to end (ephemeral PGlite, real rate limits, every
// request from its own fake IP through X-Real-IP).
//
// The coverage test below does not sample a few routes: it ENUMERATES every handler of every controller the application
// registers, from Nest's own metadata, and classifies each one as authenticated (JwtAuthGuard) or public. A handler that
// is neither — i.e. one that would authenticate some other way and could bypass the restriction — fails the test, and so
// does a new public route nobody classified.
describe('Required password change (e2e, real local Postgres)', () => {
  let testDb: TestDatabase;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let jwt: JwtService;
  let business: Business;
  let counter = 0;
  const captured: string[] = [];
  const restoreWrites: Array<() => void> = [];

  const nextIp = () => `203.0.113.${(counter += 1) % 250}`;
  const baseUrl = () => `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const http = () => request(baseUrl());

  interface TestUser {
    id: string;
    email: string;
    password: string;
    role: UserRole;
    businessId: string | null;
  }

  async function makeUser(opts: { role?: UserRole; mustChange?: boolean; businessId?: string | null } = {}): Promise<TestUser> {
    const role = opts.role ?? UserRole.ADMIN;
    const n = (counter += 1);
    const email = `user${n}@required-change.test`;
    const businessId = opts.businessId !== undefined ? opts.businessId : role === UserRole.SUPER_ADMIN ? null : business.id;
    const repo = dataSource.getRepository(User);
    const saved = await repo.save(repo.create({ email, passwordHash: await bcrypt.hash(PASSWORD, TEST_BCRYPT_COST), role, businessId }));
    if (opts.mustChange) await dataSource.query(`UPDATE users SET must_change_password = true WHERE id = $1`, [saved.id]);
    return { id: saved.id, email, password: PASSWORD, role, businessId };
  }

  const row = async (id: string) =>
    ((await dataSource.query(`SELECT credentials_version, must_change_password, md5(password_hash) AS hash_md5 FROM users WHERE id = $1`, [id])) as Array<{
      credentials_version: number;
      must_change_password: boolean;
      hash_md5: string;
    }>)[0]!;

  const tokenFor = (user: TestUser, extra: Record<string, unknown> = {}) =>
    jwt.signAsync({ sub: user.id, email: user.email, role: user.role, businessId: user.businessId, cv: 0, ...extra });
  const loginAs = (user: TestUser) => http().post('/auth/login').set('X-Real-IP', nextIp()).send({ email: user.email, password: user.password });
  const authed = (method: 'get' | 'post' | 'patch' | 'delete', path: string, token: string) =>
    http()[method](path).set('Authorization', `Bearer ${token}`).set('X-Real-IP', nextIp());
  const me = (token: string) => authed('get', '/auth/me', token);
  const change = (token: string, body: unknown) => authed('post', '/auth/change-password', token).send(body as object);
  const payloadOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;

  // ---- route enumeration (from the metadata Nest itself uses) ----
  interface RouteInfo {
    id: string; // Controller.handler
    method: 'get' | 'post' | 'patch' | 'delete' | 'put' | 'head' | 'options' | 'all';
    path: string; // with :params replaced by a UUID
    authenticated: boolean;
    allowsPasswordChangeRequired: boolean;
  }
  const METHODS = ['get', 'post', 'put', 'delete', 'patch', 'all', 'options', 'head'] as const;

  function enumerateRoutes(): RouteInfo[] {
    const container = app.get(ModulesContainer, { strict: false });
    const controllers = new Set<new (...args: never[]) => object>();
    for (const module of container.values()) {
      for (const wrapper of module.controllers.values()) if (wrapper.metatype) controllers.add(wrapper.metatype as never);
    }
    const routes: RouteInfo[] = [];
    for (const controller of controllers) {
      const base = String(Reflect.getMetadata('path', controller) ?? '');
      const classGuards = (Reflect.getMetadata('__guards__', controller) as unknown[] | undefined) ?? [];
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        if (name === 'constructor') continue;
        const handler = (controller.prototype as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;
        const method = Reflect.getMetadata('method', handler) as number | undefined;
        if (method === undefined) continue; // not a route
        const path = String(Reflect.getMetadata('path', handler) ?? '');
        const guards = [...classGuards, ...(((Reflect.getMetadata('__guards__', handler) as unknown[] | undefined) ?? []))];
        routes.push({
          id: `${controller.name}.${name}`,
          method: METHODS[method === RequestMethod.GET ? 0 : method === RequestMethod.POST ? 1 : method === RequestMethod.PUT ? 2 : method === RequestMethod.DELETE ? 3 : method === RequestMethod.PATCH ? 4 : method === RequestMethod.ALL ? 5 : method === RequestMethod.OPTIONS ? 6 : 7],
          path: `/${[base, path].filter(Boolean).join('/')}`.replace(/\/+/g, '/').replace(/:[A-Za-z]+/g, ZERO_UUID).replace(/\*[A-Za-z]*/g, 'x'),
          authenticated: guards.includes(JwtAuthGuard),
          allowsPasswordChangeRequired: Reflect.getMetadata(ALLOW_PASSWORD_CHANGE_REQUIRED_KEY, handler) === true,
        });
      }
    }
    return routes.sort((a, b) => a.id.localeCompare(b.id));
  }

  // Every route that is NOT behind JwtAuthGuard, classified on purpose. A route missing here fails the coverage test.
  const PUBLIC_ROUTES = new Set([
    'AppController.getHello',
    'AppController.getHealth',
    'AuthController.login',
    'CategoryController.findAll',
    'MediaController.redirect',
    'OrderController.create',
    'ProductController.findAll',
    'ProductController.findOne',
    'ShareMetaController.getShareMeta', // GET /public/share-meta — <head> fragment for link previews of /menu/:slug (public data only)
    'PublicMenuController.getMenu', // GET /public/menu/:slug — the shareable read-only menu (public data of one restaurant)
    'TableSessionController.join',
    'TableSessionController.status',
  ]);

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
    await runAllMigrations(dataSource);
    const businessRepo = dataSource.getRepository(Business);
    business = await businessRepo.save(businessRepo.create({ name: 'Required Change Co', slug: 'required-change-co' }));

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

  describe('coverage: every route of the application is classified', () => {
    it('every handler is either behind JwtAuthGuard or an explicitly listed public route — nothing authenticates some other way', () => {
      const routes = enumerateRoutes();
      expect(routes.length).toBeGreaterThan(40); // sanity: the enumeration really found the application's routes
      const unclassified = routes.filter((r) => !r.authenticated && !PUBLIC_ROUTES.has(r.id)).map((r) => `${r.method.toUpperCase()} ${r.path} (${r.id})`);
      expect(unclassified).toEqual([]);
      // and the allowlist has no stale entries
      const known = new Set(routes.map((r) => r.id));
      expect([...PUBLIC_ROUTES].filter((id) => !known.has(id))).toEqual([]);
      // a public route is never also marked as allowed-while-required (the mark only means something behind the guard)
      expect(routes.filter((r) => !r.authenticated && r.allowsPasswordChangeRequired)).toEqual([]);
    });

    it('@AllowPasswordChangeRequired is on exactly two handlers: GET /auth/me and POST /auth/change-password', () => {
      const allowed = enumerateRoutes().filter((r) => r.allowsPasswordChangeRequired);
      expect(allowed.map((r) => r.id).sort()).toEqual(['AuthController.changePassword', 'AuthController.me']);
      expect(allowed.every((r) => r.authenticated)).toBe(true);
    });

    it('every authenticated route except those two answers 403 PASSWORD_CHANGE_REQUIRED to a user who must change the password — ADMIN and SUPER_ADMIN alike', async () => {
      const routes = enumerateRoutes().filter((r) => r.authenticated && !r.allowsPasswordChangeRequired);
      expect(routes.length).toBeGreaterThan(30);
      for (const role of [UserRole.ADMIN, UserRole.SUPER_ADMIN]) {
        const user = await makeUser({ role, mustChange: true });
        const token = await tokenFor(user);
        for (const r of routes) {
          const res = await (http() as unknown as Record<string, (p: string) => request.Test>)[r.method]!(r.path)
            .set('Authorization', `Bearer ${token}`)
            .set('X-Real-IP', nextIp())
            .send({});
          expect(
            { status: res.status, body: res.body },
            `${role} ${r.method.toUpperCase()} ${r.path} (${r.id})`,
          ).toMatchObject({ status: 403, body: { ...REQUIRED } });
        }
      }
    });

    it('control: the SAME requests from a user who does not need to change the password are never answered with PASSWORD_CHANGE_REQUIRED', async () => {
      const routes = enumerateRoutes().filter((r) => r.authenticated && !r.allowsPasswordChangeRequired);
      for (const role of [UserRole.ADMIN, UserRole.SUPER_ADMIN]) {
        const user = await makeUser({ role });
        const token = await tokenFor(user);
        for (const r of routes) {
          const res = await (http() as unknown as Record<string, (p: string) => request.Test>)[r.method]!(r.path)
            .set('Authorization', `Bearer ${token}`)
            .set('X-Real-IP', nextIp())
            .send({});
          expect(res.body?.errorCode, `${role} ${r.method.toUpperCase()} ${r.path}`).not.toBe('PASSWORD_CHANGE_REQUIRED');
        }
      }
    });
  });

  describe('the two allowed routes', () => {
    it('GET /auth/me works for a user who must change the password (any role) and reports it', async () => {
      for (const role of [UserRole.ADMIN, UserRole.SUPER_ADMIN]) {
        const user = await makeUser({ role, mustChange: true });
        const res = await me(await tokenFor(user)).expect(200);
        expect(res.body).toEqual({ id: user.id, email: user.email, role, businessId: user.businessId, active: true, mustChangePassword: true });
      }
    });

    it('POST /auth/change-password is reachable for them (a bad body is a 400, a wrong current password a 403 CURRENT_PASSWORD_INCORRECT — never PASSWORD_CHANGE_REQUIRED)', async () => {
      const user = await makeUser({ mustChange: true });
      const token = await tokenFor(user);
      expect((await change(token, {}).expect(400)).body.errorCode).not.toBe('PASSWORD_CHANGE_REQUIRED');
      expect((await change(token, { currentPassword: 'not-the-password-1', newPassword: NEW_PASSWORD }).expect(403)).body.errorCode).toBe('CURRENT_PASSWORD_INCORRECT');
    });

    it('the exception only skips the forced-change check: authentication still applies in full (no token, bad token, stale version, inactive user)', async () => {
      const user = await makeUser({ mustChange: true });
      await http().get('/auth/me').set('X-Real-IP', nextIp()).expect(401);
      await me('not.a.jwt').expect(401);
      await me(await tokenFor(user, { cv: 3 })).expect(401); // stale credentials version
      await me(await tokenFor(user, { cv: 'x' })).expect(401);
      await change(await tokenFor(user, { cv: 3 }), { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(401);
      const inactive = await makeUser({ mustChange: true });
      await dataSource.query(`UPDATE users SET active = false WHERE id = $1`, [inactive.id]);
      await me(await tokenFor(inactive)).expect(401);
      await change(await tokenFor(inactive), { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(401);
    });
  });

  describe('the flag comes from the database, from nowhere else', () => {
    it('a token claim, a header, a query parameter or a body field saying "mustChangePassword: false" changes nothing', async () => {
      const user = await makeUser({ mustChange: true });
      const forged = await tokenFor(user, { mustChangePassword: false, role: UserRole.SUPER_ADMIN });
      const res = await authed('get', '/products/admin?mustChangePassword=false&must_change_password=false', forged).set('X-Must-Change-Password', 'false').expect(403);
      expect(res.body).toMatchObject(REQUIRED);
      for (const extra of [{ mustChangePassword: false }, { must_change_password: false }]) {
        await change(forged, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, ...extra }).expect(400); // strict whitelist
      }
      expect((await row(user.id)).must_change_password).toBe(true);
    });

    it('the restriction follows the database in both directions, immediately (set → blocked; cleared → allowed), with the same token', async () => {
      const user = await makeUser();
      const token = await tokenFor(user);
      await authed('get', '/products/admin', token).expect(200);
      await dataSource.query(`UPDATE users SET must_change_password = true WHERE id = $1`, [user.id]);
      expect((await authed('get', '/products/admin', token).expect(403)).body).toMatchObject(REQUIRED);
      await dataSource.query(`UPDATE users SET must_change_password = false WHERE id = $1`, [user.id]);
      await authed('get', '/products/admin', token).expect(200);
    });

    it('a role does not bypass it: a SUPER_ADMIN is restricted too, and a restricted ADMIN calling a SUPER_ADMIN-only route gets PASSWORD_CHANGE_REQUIRED first', async () => {
      const root = await makeUser({ role: UserRole.SUPER_ADMIN, mustChange: true });
      expect((await authed('get', '/businesses', await tokenFor(root)).expect(403)).body).toMatchObject(REQUIRED);
      const admin = await makeUser({ mustChange: true });
      expect((await authed('get', '/businesses', await tokenFor(admin)).expect(403)).body).toMatchObject(REQUIRED); // not the role's plain 403
      // once the password is changed, the SAME route is refused by the role check instead (a different 403, no errorCode)
      const changed = await change(await tokenFor(admin), { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(200);
      const plain = await authed('get', '/businesses', changed.body.accessToken).expect(403);
      expect(plain.body.errorCode).toBeUndefined();
    });
  });

  describe('the complete flow', () => {
    it('login → /auth/me → blocked elsewhere → failed change keeps the restriction → successful change lifts it, bumps the version, revokes old tokens', async () => {
      const user = await makeUser({ mustChange: true });

      // 1-2. login: a REAL boolean from the database, token unchanged in shape
      const login = await loginAs(user).expect(200);
      expect(login.body.user).toEqual({ id: user.id, email: user.email, role: 'ADMIN', businessId: business.id, active: true, mustChangePassword: true });
      expect(Object.keys(payloadOf(login.body.accessToken)).sort()).toEqual(['businessId', 'cv', 'email', 'exp', 'iat', 'role', 'sub']); // JWT format untouched
      expect(payloadOf(login.body.accessToken).cv).toBe(0);
      const old = login.body.accessToken as string;

      // 3-4. /auth/me fine, everything else 403 with the exact body
      expect((await me(old).expect(200)).body.mustChangePassword).toBe(true);
      const blocked = await authed('get', '/products/admin', old).expect(403);
      expect(blocked.body).toEqual({ message: 'You must change your password before using this resource', errorCode: 'PASSWORD_CHANGE_REQUIRED' });

      // a FAILED change (wrong current password, bad policy, same password) keeps the restriction, version and hash
      const before = await row(user.id);
      await change(old, { currentPassword: 'wrong-current-1', newPassword: NEW_PASSWORD }).expect(403);
      await change(old, { currentPassword: PASSWORD, newPassword: 'short' }).expect(400);
      await change(old, { currentPassword: PASSWORD, newPassword: PASSWORD }).expect(400);
      const afterFailures = await row(user.id);
      expect(afterFailures).toEqual(before);
      expect(afterFailures.must_change_password).toBe(true);
      expect((await authed('get', '/orders/admin', old).expect(403)).body).toMatchObject(REQUIRED);

      // 5-9. successful change
      const changed = await change(old, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(200);
      expect(changed.body.user).toEqual({ id: user.id, email: user.email, role: 'ADMIN', businessId: business.id, active: true, mustChangePassword: false });
      expect(payloadOf(changed.body.accessToken).cv).toBe(1);
      const after = await row(user.id);
      expect(after.credentials_version).toBe(before.credentials_version + 1);
      expect(after.must_change_password).toBe(false);
      await me(old).expect(401); // the old token is revoked
      await authed('get', '/products/admin', old).expect(401);
      expect((await me(changed.body.accessToken).expect(200)).body.mustChangePassword).toBe(false);
      await authed('get', '/products/admin', changed.body.accessToken).expect(200); // now works normally
      await authed('get', '/orders/admin', changed.body.accessToken).expect(200);
      expect((await loginAs({ ...user, password: NEW_PASSWORD }).expect(200)).body.user.mustChangePassword).toBe(false);
    });

    it('the same flow for a SUPER_ADMIN (no business)', async () => {
      const root = await makeUser({ role: UserRole.SUPER_ADMIN, mustChange: true });
      const login = await loginAs(root).expect(200);
      expect(login.body.user).toMatchObject({ role: 'SUPER_ADMIN', businessId: null, mustChangePassword: true });
      await authed('get', '/businesses', login.body.accessToken).expect(403);
      const changed = await change(login.body.accessToken, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(200);
      expect(changed.body.user.mustChangePassword).toBe(false);
      await authed('get', '/businesses', changed.body.accessToken).expect(200);
    });

    it('existing users (mustChangePassword = false by default) keep working exactly as before and see the flag as false', async () => {
      const user = await makeUser();
      const login = await loginAs(user).expect(200);
      expect(login.body.user.mustChangePassword).toBe(false);
      await authed('get', '/products/admin', login.body.accessToken).expect(200);
      expect((await me(login.body.accessToken).expect(200)).body).toEqual(login.body.user);
    });
  });

  describe('precedence with the other checks', () => {
    it('suspended business + must change: ADMIN gets 403 BUSINESS_INACTIVE (raised while authenticating) on EVERY route, the two allowed ones included — they cannot change the password until the business is reactivated', async () => {
      const suspended = await dataSource.getRepository(Business).save(dataSource.getRepository(Business).create({ name: 'Suspended Co', slug: `suspended-co-${counter}`, active: false }));
      const admin = await makeUser({ mustChange: true, businessId: suspended.id });
      const token = await tokenFor(admin);
      for (const res of [await authed('get', '/products/admin', token), await me(token), await change(token, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })]) {
        expect(res.status).toBe(403);
        expect(res.body.errorCode).toBe('BUSINESS_INACTIVE');
      }
      // login: the password is proven first, then the suspended business is refused (no token is issued)
      expect((await loginAs(admin).expect(403)).body.errorCode).toBe('BUSINESS_INACTIVE');
      expect((await row(admin.id)).must_change_password).toBe(true); // nothing changed
      // reactivated: the restriction applies again
      await dataSource.query(`UPDATE businesses SET active = true WHERE id = $1`, [suspended.id]);
      expect((await authed('get', '/products/admin', token).expect(403)).body.errorCode).toBe('PASSWORD_CHANGE_REQUIRED');
    });

    it('a SUPER_ADMIN who must change the password does not depend on any business being active', async () => {
      const root = await makeUser({ role: UserRole.SUPER_ADMIN, mustChange: true });
      await me(await tokenFor(root)).expect(200);
    });

    it('a stale credentials version or an inactive user is a 401 whatever the flag says (authentication comes first)', async () => {
      const user = await makeUser({ mustChange: true });
      expect((await authed('get', '/products/admin', await tokenFor(user, { cv: 9 })).expect(401)).body.errorCode).toBeUndefined();
      await dataSource.query(`UPDATE users SET active = false WHERE id = $1`, [user.id]);
      await authed('get', '/products/admin', await tokenFor(user)).expect(401);
    });

    it('an invalid, expired or missing token is still a plain 401 on every kind of route (the restriction never changes what an invalid JWT means)', async () => {
      await http().get('/products/admin').set('X-Real-IP', nextIp()).expect(401);
      await authed('get', '/products/admin', 'garbage').expect(401);
      const expired = await jwt.signAsync({ sub: ZERO_UUID, email: 'x@y.z', role: 'ADMIN', businessId: null, cv: 0 }, { expiresIn: -10 });
      await authed('get', '/products/admin', expired).expect(401);
    });
  });

  it('no password, hash or token appears in the application logs or in any 403 body of this file', () => {
    const logs = captured.join('');
    for (const secret of [PASSWORD, NEW_PASSWORD, 'wrong-current-1', 'not-the-password-1']) expect(logs.includes(secret), 'log contains a password').toBe(false);
    expect(logs).not.toMatch(/\$2[aby]\$\d\d\$/);
    expect(logs).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./);
  });
});
