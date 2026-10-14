import type { AddressInfo } from 'node:net';
import bcrypt from 'bcrypt';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { Business } from '../src/business/business.entity.js';
import {
  DEFAULT_RATE_LIMITS,
  RATE_LIMIT_CONFIG,
  type RateLimitConfig,
} from '../src/rate-limit/rate-limit.config.js';
import { User } from '../src/user/user.entity.js';
import { UserRole } from '../src/user/user-role.enum.js';
import { runAllMigrations } from './support/run-all-migrations.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

const TEST_BCRYPT_COST = 4;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';
const password = 'Sup3rSecret!';

// The real counters, tiny numbers: small enough to hit them in a handful of
// requests, and distinct enough from each other to tell which one tripped.
const minute = 60_000;
const bucket = (limit: number) => ({ limit, ttlMs: minute });
const REDUCED: RateLimitConfig = {
  globalIp: bucket(40),
  authenticatedUser: bucket(6),
  policies: {
    publicMenu: { ip: bucket(3) },
    login: { ip: bucket(5) }, // same as production on purpose
    upload: { user: bucket(2) },
    ordersCreate: { session: bucket(3), ip: bucket(6) },
    tableJoin: { ip: bucket(3) },
    tableStatus: { session: bucket(4), ip: bucket(8), skipGlobalIp: true },
    media: { ip: bucket(8), skipGlobalIp: true },
  },
};

// Real-database e2e of rate limiting (ephemeral local PGlite, never
// Supabase). Every test uses its own fake client IP through X-Real-IP
// (CLIENT_IP_HEADER=x-real-ip, the same mechanism as Railway), so counters
// never leak between tests — and "the user changes IP" is just another
// header value.
//
// PGlite's socket tolerates a single connection, so the app is booted once
// per limits configuration and closed before the next boot.
describe('Rate limiting (e2e, real local Postgres — never Supabase)', () => {
  let testDb: TestDatabase;
  let app: INestApplication<App> | undefined;
  let adminOne: string;
  let adminTwo: string;
  let ipCounter = 0;

  const nextIp = () => `198.51.100.${(ipCounter += 1)}`;

  async function boot(config: RateLimitConfig) {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(RATE_LIMIT_CONFIG)
      .useValue(config)
      .compile();
    const instance = moduleFixture.createNestApplication<INestApplication<App>>();
    instance.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    // Listen once on a fixed ephemeral port and aim supertest at that URL.
    // Handing supertest the bare http.Server makes it bind (and release) a
    // new ephemeral port for every request; with ~200 requests here, running
    // in parallel with the other e2e files, that port churn was enough to
    // make unrelated files occasionally talk to the wrong local socket.
    await instance.listen(0, '127.0.0.1');
    app = instance;
    return moduleFixture.get(DataSource);
  }

  const baseUrl = () => `http://127.0.0.1:${(app!.getHttpServer().address() as AddressInfo).port}`;
  const http = () => request(baseUrl());
  const asIp = (ip: string) => ({ 'X-Real-IP': ip });

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

    const dataSource = await boot(REDUCED);
    await runAllMigrations(dataSource);

    const businessRepo = dataSource.getRepository(Business);
    const userRepo = dataSource.getRepository(User);
    const business = await businessRepo.save(
      businessRepo.create({ name: 'Rate Limit', slug: 'rate-limit-e2e' }),
    );
    const hash = await bcrypt.hash(password, TEST_BCRYPT_COST);
    for (const email of ['one@rl-e2e.test', 'two@rl-e2e.test']) {
      await userRepo.save(
        userRepo.create({
          email,
          passwordHash: hash,
          role: UserRole.ADMIN,
          businessId: business.id,
        }),
      );
    }

    const login = async (email: string): Promise<string> => {
      const res = await http()
        .post('/auth/login')
        .set(asIp(nextIp()))
        .send({ email, password })
        .expect(200);
      return res.body.accessToken;
    };
    adminOne = await login('one@rl-e2e.test');
    adminTwo = await login('two@rl-e2e.test');
  }, 60_000);

  afterAll(async () => {
    delete process.env.CLIENT_IP_HEADER;
    await app?.close();
    await testDb?.stop();
  });

  const menu = (ip: string) =>
    http().get('/products').query({ businessSlug: 'rate-limit-e2e' }).set(asIp(ip));
  const me = (token: string, ip: string) =>
    http().get('/auth/me').set('Authorization', `Bearer ${token}`).set(asIp(ip));
  const placeOrder = (sessionToken: string | undefined, ip: string) =>
    http()
      .post('/orders')
      .set(asIp(ip))
      .send({
        ...(sessionToken ? { sessionToken } : {}),
        clientRequestId: UNKNOWN_UUID,
        items: [{ productId: UNKNOWN_UUID, quantity: 1 }],
      });
  const poll = (sessionToken: string, ip: string) =>
    http().post('/table-sessions/status').set(asIp(ip)).send({ sessionToken });

  describe('429 response', () => {
    it('devuelve { statusCode, errorCode, message } con Retry-After y sin datos internos', async () => {
      const ip = nextIp();
      for (let i = 0; i < REDUCED.policies.publicMenu.ip!.limit; i += 1) {
        await menu(ip).expect(200);
      }
      const res = await menu(ip).expect(429);

      expect(res.body).toEqual({
        statusCode: 429,
        errorCode: 'RATE_LIMITED',
        message: 'Too many requests',
      });
      expect(res.headers['retry-after']).toMatch(/^\d+$/);
      expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(60);

      const serialized = JSON.stringify(res.body) + JSON.stringify(res.headers);
      expect(serialized).not.toContain(ip);
      expect(serialized).not.toMatch(/publicMenu|bucket|ProductController/i);
    });
  });

  describe('menú público', () => {
    it('GET /products alcanza 429 al superar el límite por IP', async () => {
      const ip = nextIp();
      await menu(ip).expect(200);
      await menu(ip).expect(200);
      await menu(ip).expect(200);
      await menu(ip).expect(429);
    });

    it('otra IP no comparte el contador', async () => {
      const busy = nextIp();
      for (let i = 0; i < 4; i += 1) await menu(busy);
      await menu(busy).expect(429);
      await menu(nextIp()).expect(200);
    });

    it('GET /categories y GET /products tienen contadores independientes', async () => {
      const ip = nextIp();
      for (let i = 0; i < 4; i += 1) await menu(ip);
      await menu(ip).expect(429);
      await http()
        .get('/categories')
        .query({ businessSlug: 'rate-limit-e2e' })
        .set(asIp(ip))
        .expect(200);
    });

    it('GET /categories también se limita', async () => {
      const ip = nextIp();
      const categories = () =>
        http().get('/categories').query({ businessSlug: 'rate-limit-e2e' }).set(asIp(ip));
      for (let i = 0; i < 3; i += 1) await categories().expect(200);
      await categories().expect(429);
    });
  });

  describe('login', () => {
    it('sigue limitado a 5 intentos por IP', async () => {
      const ip = nextIp();
      const attempt = () =>
        http()
          .post('/auth/login')
          .set(asIp(ip))
          .send({ email: 'one@rl-e2e.test', password: 'wrong-password' });
      for (let i = 0; i < 5; i += 1) await attempt().expect(401);
      const res = await attempt().expect(429);
      expect(res.body.errorCode).toBe('RATE_LIMITED');
      expect(res.headers['retry-after']).toBeDefined();
    });
  });

  describe('Admin autenticado (por userId, no por IP)', () => {
    it('dos ADMIN bajo la misma IP tienen buckets distintos', async () => {
      const sharedIp = nextIp();
      for (let i = 0; i < REDUCED.authenticatedUser.limit; i += 1) {
        await me(adminOne, sharedIp).expect(200);
      }
      await me(adminOne, sharedIp).expect(429);
      // Same Wi-Fi, other admin: untouched.
      await me(adminTwo, sharedIp).expect(200);
    });

    it('el mismo ADMIN conserva su bucket aunque cambie de IP', async () => {
      // adminOne was exhausted above; the 60s window is still open.
      const res = await me(adminOne, nextIp()).expect(429);
      expect(res.body.errorCode).toBe('RATE_LIMITED');
      expect(res.headers['retry-after']).toBeDefined();
    });

    it('un token falsificado no obtiene bucket propio: responde 401, sin tocar buckets de usuario', async () => {
      await http()
        .get('/auth/me')
        .set('Authorization', 'Bearer forged.jwt.value')
        .set(asIp(nextIp()))
        .expect(401);
    });

  });

  describe('subidas de imagen (30/min/user → 2 en este test)', () => {
    it('limita por usuario y no por IP', async () => {
      const upload = (token: string, ip: string) =>
        http()
          .post(`/products/${UNKNOWN_UUID}/image`)
          .set('Authorization', `Bearer ${token}`)
          .set(asIp(ip));
      // adminOne's generic bucket is spent; use a fresh user-scoped check via
      // adminTwo, whose generic bucket still has room (1 of 6 used above).
      const ip = nextIp();
      const first = await upload(adminTwo, ip);
      const second = await upload(adminTwo, ip);
      expect(first.status).not.toBe(429);
      expect(second.status).not.toBe(429);
      const third = await upload(adminTwo, nextIp());
      expect(third.status).toBe(429);
      expect(third.body.errorCode).toBe('RATE_LIMITED');
    });
  });

  describe('POST /orders (por sessionToken y por IP)', () => {
    it('el mismo sessionToken alcanza su límite', async () => {
      const ip = nextIp();
      for (let i = 0; i < 3; i += 1) {
        const res = await placeOrder('table-one-token', ip);
        expect(res.status).not.toBe(429);
      }
      const res = await placeOrder('table-one-token', ip).expect(429);
      expect(res.body.errorCode).toBe('RATE_LIMITED');
      expect(res.headers['retry-after']).toBeDefined();
    });

    it('el mismo sessionToken comparte bucket aunque cambie la IP (todos los dispositivos de la mesa)', async () => {
      for (let i = 0; i < 3; i += 1) await placeOrder('table-shared-token', nextIp());
      await placeOrder('table-shared-token', nextIp()).expect(429);
    });

    it('dos sessionToken distintos bajo la misma IP tienen buckets separados', async () => {
      const sharedIp = nextIp();
      for (let i = 0; i < 3; i += 1) await placeOrder('table-a-token', sharedIp);
      await placeOrder('table-a-token', sharedIp).expect(429);
      // Another table behind the same Wi-Fi is unaffected.
      const other = await placeOrder('table-b-token', sharedIp);
      expect(other.status).not.toBe(429);
      expect(other.body.errorCode).toBe('TABLE_SESSION_UNAVAILABLE');
    });

    it('el límite adicional por IP también se activa con sessionTokens distintos', async () => {
      const ip = nextIp();
      for (let i = 0; i < REDUCED.policies.ordersCreate.ip!.limit; i += 1) {
        const res = await placeOrder(`rotating-token-${i}`, ip);
        expect(res.status).not.toBe(429);
      }
      const res = await placeOrder('rotating-token-next', ip).expect(429);
      expect(res.body.errorCode).toBe('RATE_LIMITED');
    });

    it('sin sessionToken usa la IP como tracker de respaldo', async () => {
      const ip = nextIp();
      for (let i = 0; i < 3; i += 1) {
        // The endpoint's own validation still decides: 400, not 429.
        await placeOrder(undefined, ip).expect(400);
      }
      await placeOrder(undefined, ip).expect(429);
      await placeOrder(undefined, nextIp()).expect(400);
    });
  });

  describe('table-sessions', () => {
    it('join: 429 al superar el límite por IP', async () => {
      const ip = nextIp();
      const join = () =>
        http().post('/table-sessions/join').set(asIp(ip)).send({ qrToken: 'unknown-qr' });
      for (let i = 0; i < 3; i += 1) {
        const res = await join();
        expect(res.status).not.toBe(429);
      }
      await join().expect(429);
    });

    it('status: el mismo sessionToken alcanza su límite; otro token en la misma IP no', async () => {
      const ip = nextIp();
      for (let i = 0; i < 4; i += 1) {
        const res = await poll('status-token-a', ip);
        expect(res.status).toBe(200);
      }
      await poll('status-token-a', ip).expect(429);
      await poll('status-token-b', ip).expect(200);
    });

    it('status: el límite por IP (8) se activa con sessionTokens distintos', async () => {
      const ip = nextIp();
      for (let i = 0; i < REDUCED.policies.tableStatus.ip!.limit; i += 1) {
        await poll(`status-rot-${i}`, ip).expect(200);
      }
      await poll('status-rot-next', ip).expect(429);
    });
  });

  describe('health y diagnóstico', () => {
    it('/health nunca se limita', async () => {
      const ip = nextIp();
      for (let i = 0; i < REDUCED.globalIp.limit + 5; i += 1) {
        await http().get('/health').set(asIp(ip)).expect(200);
      }
    });

    it('/diagnostics/client-ip ya no existe (404 con y sin token)', async () => {
      await http().get('/diagnostics/client-ip').set(asIp(nextIp())).expect(404);
      await http()
        .get('/diagnostics/client-ip')
        .set('Authorization', `Bearer ${adminTwo}`)
        .set(asIp(nextIp()))
        .expect(404);
    });
  });

  describe('techo global por IP', () => {
    const GLOBAL = 5;

    beforeAll(async () => {
      await app!.close();
      await boot({
        ...DEFAULT_RATE_LIMITS,
        globalIp: bucket(GLOBAL),
        policies: { ...DEFAULT_RATE_LIMITS.policies, tableStatus: REDUCED.policies.tableStatus },
      });
    });

    it('cualquier ruta alcanza 429 al superar el techo, aunque su propio límite sea mayor', async () => {
      const ip = nextIp();
      // GET /products allows 120/min on its own; the 300→5 global ceiling trips first.
      for (let i = 0; i < GLOBAL; i += 1) await menu(ip).expect(200);
      const res = await menu(ip).expect(429);
      expect(res.body.errorCode).toBe('RATE_LIMITED');
      // …and it is shared across routes.
      await http().get('/categories').query({ businessSlug: 'rate-limit-e2e' }).set(asIp(ip)).expect(429);
    });

    it('table status queda fuera del techo global (usa su propio techo por IP)', async () => {
      const ip = nextIp();
      for (let i = 0; i < GLOBAL + 2; i += 1) {
        await poll(`global-skip-${i}`, ip).expect(200);
      }
    });

    it('un ADMIN sigue sujeto al techo por IP además de su bucket de usuario', async () => {
      const ip = nextIp();
      for (let i = 0; i < GLOBAL; i += 1) await me(adminOne, ip).expect(200);
      await me(adminOne, ip).expect(429);
      // A different admin from the same IP is blocked by the shared IP ceiling.
      await me(adminTwo, ip).expect(429);
    });
  });
});
