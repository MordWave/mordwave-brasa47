import bcrypt from 'bcrypt';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { Business } from '../src/business/business.entity.js';
import { User } from '../src/user/user.entity.js';
import { UserRole } from '../src/user/user-role.enum.js';
import { runAllMigrations } from './support/run-all-migrations.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

const TEST_BCRYPT_COST = 4;

// Real-database proof of the temporary GET /diagnostics/client-ip endpoint
// (ephemeral local PGlite, never Supabase). The endpoint's switch
// (ENABLE_IP_DIAGNOSTICS) and the IP header (CLIENT_IP_HEADER) are read from
// the environment when the app boots, so the "disabled" and "enabled"
// scenarios each boot their own app — one at a time, because PGlite's socket
// only tolerates a single connection. JWTs stay valid across both boots
// (same JWT secret), which also keeps us under the 5/min login throttle.
describe('GET /diagnostics/client-ip (e2e, real local Postgres — never Supabase)', () => {
  let testDb: TestDatabase;
  let app: INestApplication<App> | undefined;

  let tokenAdmin: string;
  let tokenSuper: string;
  const password = 'Sup3rSecret!';

  async function boot(env: Record<string, string>, trustProxy?: number) {
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const instance = moduleFixture.createNestApplication<INestApplication<App>>();
    instance.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    // main.ts does this in production; createNestApplication() doesn't.
    if (trustProxy !== undefined) {
      (instance as unknown as { set(k: string, v: unknown): void }).set('trust proxy', trustProxy);
    }
    await instance.init();
    app = instance;
    return moduleFixture.get(DataSource);
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
    delete process.env.ENABLE_IP_DIAGNOSTICS;
    delete process.env.CLIENT_IP_HEADER;

    // First boot = diagnostics OFF (the default).
    const dataSource = await boot({});
    await runAllMigrations(dataSource);

    const businessRepo = dataSource.getRepository(Business);
    const userRepo = dataSource.getRepository(User);
    const business = await businessRepo.save(
      businessRepo.create({ name: 'IP Diag', slug: 'ip-diag-e2e' }),
    );
    const hash = await bcrypt.hash(password, TEST_BCRYPT_COST);
    await userRepo.save(
      userRepo.create({
        email: 'admin@ip-diag-e2e.test',
        passwordHash: hash,
        role: UserRole.ADMIN,
        businessId: business.id,
      }),
    );
    await userRepo.save(
      userRepo.create({
        email: 'super@ip-diag-e2e.test',
        passwordHash: hash,
        role: UserRole.SUPER_ADMIN,
        businessId: null,
      }),
    );

    const login = async (email: string): Promise<string> => {
      const res = await request(app!.getHttpServer())
        .post('/auth/login')
        .send({ email, password })
        .expect(200);
      return res.body.accessToken;
    };
    tokenAdmin = await login('admin@ip-diag-e2e.test');
    tokenSuper = await login('super@ip-diag-e2e.test');
  }, 60_000);

  afterAll(async () => {
    delete process.env.ENABLE_IP_DIAGNOSTICS;
    delete process.env.CLIENT_IP_HEADER;
    await app?.close();
    await testDb?.stop();
  });

  const http = () => request(app!.getHttpServer());
  const getDiagnostics = (token?: string) => {
    const req = http().get('/diagnostics/client-ip');
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  describe('disabled (default)', () => {
    it('responde 404 sin token', async () => {
      await getDiagnostics().expect(404);
    });

    it('responde 404 aun con un ADMIN autenticado', async () => {
      await getDiagnostics(tokenAdmin).expect(404);
    });

    it('responde 404 aun con un SUPER_ADMIN autenticado', async () => {
      await getDiagnostics(tokenSuper).expect(404);
    });

    it('con ENABLE_IP_DIAGNOSTICS distinto de "true" sigue deshabilitado', async () => {
      await app!.close();
      await boot({ ENABLE_IP_DIAGNOSTICS: '1' });
      await getDiagnostics(tokenAdmin).expect(404);
    });
  });

  describe('enabled', () => {
    beforeAll(async () => {
      await app!.close();
      await boot({ ENABLE_IP_DIAGNOSTICS: 'true', CLIENT_IP_HEADER: 'x-real-ip' }, 1);
    });

    it('sin token → 401', async () => {
      await getDiagnostics().expect(401);
    });

    it('con token inválido → 401', async () => {
      await getDiagnostics('not.a.jwt').expect(401);
    });

    it('ADMIN autenticado → 200 con la forma esperada', async () => {
      const res = await getDiagnostics(tokenAdmin).expect(200);
      expect(Object.keys(res.body).sort()).toEqual(
        [
          'config',
          'forwarded',
          'reqIp',
          'reqIps',
          'resolvedIp',
          'socketIp',
          'xForwardedFor',
          'xRealIp',
        ].sort(),
      );
      expect(Array.isArray(res.body.reqIps)).toBe(true);
      expect(res.body.config).toEqual({ clientIpHeader: 'x-real-ip', trustProxy: 1 });
    });

    it('SUPER_ADMIN autenticado → 200', async () => {
      await getDiagnostics(tokenSuper).expect(200);
    });

    it('X-Real-IP válido (IPv4) → resolvedIp es ese header', async () => {
      const res = await getDiagnostics(tokenAdmin).set('X-Real-IP', '203.0.113.7').expect(200);
      expect(res.body.resolvedIp).toBe('203.0.113.7');
      expect(res.body.xRealIp).toBe('203.0.113.7');
      expect(res.body.reqIp).not.toBe('203.0.113.7');
    });

    it('X-Real-IP válido (IPv6) → resolvedIp es ese header', async () => {
      const res = await getDiagnostics(tokenAdmin).set('X-Real-IP', '2001:db8::1').expect(200);
      expect(res.body.resolvedIp).toBe('2001:db8::1');
    });

    it.each(['not-an-ip', '203.0.113.7, 10.0.0.2', '203.0.113.7:443', '999.1.1.1'])(
      'X-Real-IP inválido (%s) → fallback a req.ip',
      async (value) => {
        const res = await getDiagnostics(tokenAdmin).set('X-Real-IP', value).expect(200);
        expect(res.body.resolvedIp).toBe(res.body.reqIp);
        expect(res.body.resolvedIp).not.toBe(value);
        expect(res.body.xRealIp).toBe(value);
      },
    );

    it('sin X-Real-IP → fallback a req.ip', async () => {
      const res = await getDiagnostics(tokenAdmin).expect(200);
      expect(res.body.xRealIp).toBeNull();
      expect(res.body.resolvedIp).toBe(res.body.reqIp);
      expect(res.body.resolvedIp).toBeTruthy();
    });

    it('con TRUST_PROXY=1, req.ip sale de X-Forwarded-For y el fallback lo usa', async () => {
      const res = await getDiagnostics(tokenAdmin)
        .set('X-Forwarded-For', '198.51.100.9')
        .expect(200);
      expect(res.body.reqIp).toBe('198.51.100.9');
      expect(res.body.reqIps).toEqual(['198.51.100.9']);
      expect(res.body.xForwardedFor).toBe('198.51.100.9');
      expect(res.body.resolvedIp).toBe('198.51.100.9');
    });

    it('X-Real-IP válido gana sobre X-Forwarded-For', async () => {
      const res = await getDiagnostics(tokenAdmin)
        .set('X-Forwarded-For', '198.51.100.9')
        .set('X-Real-IP', '203.0.113.7')
        .expect(200);
      expect(res.body.resolvedIp).toBe('203.0.113.7');
      expect(res.body.reqIp).toBe('198.51.100.9');
    });

    it('refleja el header Forwarded y la IP del socket', async () => {
      const res = await getDiagnostics(tokenAdmin).set('Forwarded', 'for=192.0.2.60').expect(200);
      expect(res.body.forwarded).toBe('for=192.0.2.60');
      expect(res.body.socketIp).toBeTruthy();
    });

    it('nunca devuelve secretos ni el token', async () => {
      const res = await getDiagnostics(tokenAdmin).expect(200);
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(tokenAdmin);
      expect(serialized).not.toContain(process.env.JWT_SECRET ?? '__unset__');
      expect(serialized).not.toMatch(/authorization|password|secret/i);
    });
  });
});
