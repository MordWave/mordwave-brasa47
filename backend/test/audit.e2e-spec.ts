import bcrypt from 'bcrypt';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AuditLog } from '../src/audit/audit-log.entity.js';
import { AuditService } from '../src/audit/audit.service.js';
import { Business } from '../src/business/business.entity.js';
import { User } from '../src/user/user.entity.js';
import { UserRole } from '../src/user/user-role.enum.js';
import { runAllMigrations } from './support/run-all-migrations.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';
import { waitFor } from './support/wait-for.js';

// Low on purpose — this only ever protects fixture passwords inside an
// ephemeral, local, throwaway test database; a real deployment's
// BCRYPT_COST (see seed.ts) stays unaffected.
const TEST_BCRYPT_COST = 4;

// Unlike every other *.e2e-spec.ts in this project (deliberately
// guard/validation-only, no fixtures, against the real shared Supabase
// database), this file exercises the full real flow — real seeded tenants,
// a real login, a real mutation, and a real read of the audit_logs table —
// because that's the only way to actually prove the audit pipeline end to
// end. It never touches Supabase: startTestDatabase() spins up a genuine,
// ephemeral, local-only Postgres (PGlite — real Postgres compiled to WASM,
// not an emulator) and runs the real migration files against it, then this
// file points the app's own DB connection at that instance instead of
// backend/.env's DATABASE_URL for its own duration only (see the isolation
// note in beforeAll).
describe('Audit log (e2e, real local Postgres — never Supabase)', () => {
  let testDb: TestDatabase;
  let app: INestApplication<App>;
  let dataSource: DataSource;

  let businessA: Business;
  let businessB: Business;
  const adminA = { email: 'admin-a@audit-e2e.test', password: 'Sup3rSecret!A' };
  const adminB = { email: 'admin-b@audit-e2e.test', password: 'Sup3rSecret!B' };
  let tokenA: string;
  let tokenB: string;

  beforeAll(async () => {
    testDb = await startTestDatabase();

    // Points THIS process's app bootstrap at the local test database
    // instead of Supabase. DATABASE_URL is set to '' (not deleted) so
    // @nestjs/config's own dotenv load — which only fills in variables
    // that are entirely unset — never re-populates it from backend/.env.
    // Vitest isolates each e2e spec *file* into its own environment by
    // default, so none of this leaks into the other, Supabase-backed e2e
    // spec files.
    //
    // Deliberately takes typeorm.config.ts's "local" branch (DB_HOST/etc),
    // not the DATABASE_URL branch — that branch forces
    // `ssl: { rejectUnauthorized: false }` unconditionally, and
    // pglite-socket doesn't speak TLS at all ("The server does not support
    // SSL connections", confirmed empirically). NODE_ENV is forced to
    // 'production' purely so that same "local" branch's
    // `synchronize: process.env.NODE_ENV !== 'production'` evaluates to
    // false — this is the only place in the whole codebase that reads
    // NODE_ENV, so this has no other effect. Schema is instead built by
    // running the real migration files below, exactly once, through the
    // one single connection this app is about to open (see
    // run-all-migrations.ts for why: PGLiteSocketServer only tolerates one
    // connection across its entire lifetime — a second one, even opened
    // after the first was cleanly closed, reliably fails).
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = '';
    process.env.DB_HOST = testDb.host;
    process.env.DB_PORT = String(testDb.port);
    process.env.DB_USERNAME = 'postgres';
    process.env.DB_PASSWORD = 'postgres';
    process.env.DB_NAME = 'postgres';
    // The app's real connection is normally a pool of up to 10 — under
    // concurrent requests that would open more than one socket, which
    // pglite-socket cannot handle (see test-database.ts). Forces the pool
    // down to exactly one connection for this test only.
    process.env.DB_POOL_MAX = '1';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    dataSource = moduleFixture.get(DataSource);

    await runAllMigrations(dataSource);

    // Two real, independent tenants, seeded directly via repositories —
    // same technique seed.ts already uses for the dev admin user. No
    // create-business/create-user endpoint exists in this app, so this is
    // the only way to get real fixtures in.
    const businessRepo = dataSource.getRepository(Business);
    const userRepo = dataSource.getRepository(User);

    businessA = await businessRepo.save(
      businessRepo.create({ name: 'Tenant A', slug: 'tenant-a-audit-e2e' }),
    );
    businessB = await businessRepo.save(
      businessRepo.create({ name: 'Tenant B', slug: 'tenant-b-audit-e2e' }),
    );

    await userRepo.save(
      userRepo.create({
        email: adminA.email,
        passwordHash: await bcrypt.hash(adminA.password, TEST_BCRYPT_COST),
        role: UserRole.ADMIN,
        businessId: businessA.id,
      }),
    );
    await userRepo.save(
      userRepo.create({
        email: adminB.email,
        passwordHash: await bcrypt.hash(adminB.password, TEST_BCRYPT_COST),
        role: UserRole.ADMIN,
        businessId: businessB.id,
      }),
    );

    const loginA = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: adminA.email, password: adminA.password })
      .expect(200);
    tokenA = loginA.body.accessToken;

    const loginB = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: adminB.email, password: adminB.password })
      .expect(200);
    tokenB = loginB.body.accessToken;
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await testDb?.stop();
  });

  it('flujo completo: ADMIN crea una categoría, la fila de auditoría se persiste realmente y GET /audit-logs la devuelve con los campos esperados', async () => {
    const longUserAgent = `AuditE2EBrowser/1.0 ${'x'.repeat(3000)}`;

    // 1 + 2: acción auditada simple, la operación original responde bien.
    const createRes = await request(app.getHttpServer())
      .post('/categories')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('User-Agent', longUserAgent)
      .send({ name: 'Bebidas E2E', slug: 'bebidas-e2e', businessId: businessA.id })
      .expect(201);

    const categoryId: string = createRes.body.id;
    expect(createRes.body.businessId).toBe(businessA.id);

    // 3: se persiste efectivamente una fila real en audit_logs — leída
    // directo de la tabla, no a través de la API. record() es best-effort
    // (nunca bloquea la respuesta HTTP), así que se espera con polling en
    // vez de asumir que ya está ahí apenas vuelve el POST.
    const auditRepo = dataSource.getRepository(AuditLog);
    let row: AuditLog | null = null;
    await waitFor(async () => {
      row = await auditRepo.findOne({ where: { entityId: categoryId } });
      return row !== null;
    });

    // 5: businessId, userId/userEmail, action, entityType, entityId,
    // metadata.
    expect(row).toBeTruthy();
    expect(row!.businessId).toBe(businessA.id);
    expect(row!.userEmail).toBe(adminA.email);
    expect(row!.action).toBe('CATEGORY_CREATED');
    expect(row!.entityType).toBe('Category');
    expect(row!.entityId).toBe(categoryId);
    expect(row!.metadata).toEqual(
      expect.objectContaining({ name: 'Bebidas E2E', slug: 'bebidas-e2e', businessId: businessA.id }),
    );
    // userAgent capped at 2000 chars even though the real header sent was
    // much longer.
    expect(row!.userAgent).toHaveLength(2000);
    expect(row!.userAgent).toBe(longUserAgent.slice(0, 2000));

    // 4: GET /audit-logs como ese mismo ADMIN devuelve la entrada.
    const listRes = await request(app.getHttpServer())
      .get('/audit-logs')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);

    const entry = listRes.body.items.find(
      (item: { entityId: string }) => item.entityId === categoryId,
    );
    expect(entry).toBeTruthy();
    expect(entry.businessId).toBe(businessA.id);
    expect(entry.userEmail).toBe(adminA.email);
    expect(entry.action).toBe('CATEGORY_CREATED');
    expect(entry.entityType).toBe('Category');
  });

  // No hay ningún DTO real en esta app con un nombre de campo sensible
  // (password/token/secret/jwt/...) que pueda sobrevivir el
  // whitelist+forbidNonWhitelisted global del ValidationPipe — cualquier
  // intento de mandarlo por HTTP sería rechazado con 400 antes de llegar
  // siquiera al interceptor. Esta prueba ejercita entonces el AuditService
  // real (resuelto del módulo compilado, contra la misma base de datos
  // real) directamente, que es la vía honesta para demostrar el
  // saneamiento cuando el propio contrato HTTP ya bloquea la otra.
  it('elimina metadata sensible antes de persistir, incluso anidada', async () => {
    const auditService = app.get(AuditService);

    await auditService.record({
      businessId: businessA.id,
      userId: null,
      userEmail: 'system@audit-e2e.test',
      action: 'AUDIT_E2E_SENSITIVE_METADATA_CHECK',
      entityType: 'Test',
      metadata: {
        note: 'ok-to-keep',
        password: 'hunter2',
        accessToken: 'abc.def.ghi',
        nested: { secret: 'also-strip-me', keep: 'this-stays' },
      },
    });

    const auditRepo = dataSource.getRepository(AuditLog);
    let row: AuditLog | null = null;
    await waitFor(async () => {
      row = await auditRepo.findOne({
        where: { action: 'AUDIT_E2E_SENSITIVE_METADATA_CHECK' },
        order: { createdAt: 'DESC' },
      });
      return row !== null;
    });

    expect(row!.metadata).toEqual({ note: 'ok-to-keep', nested: { keep: 'this-stays' } });
    const serialized = JSON.stringify(row!.metadata);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('abc.def.ghi');
  });

  it('nunca persiste la contraseña real ni el JWT usado durante todo este flujo, en ninguna fila de audit_logs', async () => {
    const auditRepo = dataSource.getRepository(AuditLog);
    const allRows = await auditRepo.find();
    const serialized = JSON.stringify(allRows);

    expect(serialized).not.toContain(adminA.password);
    expect(serialized).not.toContain(adminB.password);
    expect(serialized).not.toContain(tokenA);
    expect(serialized).not.toContain(tokenB);
  });

  it('aislamiento multi-tenant: un ADMIN de Business A no puede obtener logs de Business B aunque pida businessId=B explícitamente', async () => {
    // Le da a Business B algo real que "filtrarse" si el aislamiento
    // estuviera roto.
    const createResB = await request(app.getHttpServer())
      .post('/categories')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'Postres B', slug: 'postres-b-e2e', businessId: businessB.id })
      .expect(201);
    const categoryBId: string = createResB.body.id;

    const auditRepo = dataSource.getRepository(AuditLog);
    await waitFor(async () => (await auditRepo.findOne({ where: { entityId: categoryBId } })) !== null);

    // Control: ADMIN B sí ve su propia entrada.
    const listB = await request(app.getHttpServer())
      .get('/audit-logs')
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(200);
    expect(
      listB.body.items.some((item: { entityId: string }) => item.entityId === categoryBId),
    ).toBe(true);

    // ADMIN A pide explícitamente el log de Business B.
    const listAasB = await request(app.getHttpServer())
      .get('/audit-logs')
      .query({ businessId: businessB.id })
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);

    expect(
      listAasB.body.items.some((item: { entityId: string }) => item.entityId === categoryBId),
    ).toBe(false);
    expect(
      listAasB.body.items.every((item: { businessId: string }) => item.businessId === businessA.id),
    ).toBe(true);
  });
});
