import bcrypt from 'bcrypt';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AuditLog } from '../src/audit/audit-log.entity.js';
import { Business } from '../src/business/business.entity.js';
import { User } from '../src/user/user.entity.js';
import { UserRole } from '../src/user/user-role.enum.js';
import { runAllMigrations } from './support/run-all-migrations.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

const TEST_BCRYPT_COST = 4;

// Real-database proof of POST /businesses (SUPER_ADMIN-only creation): who may call it, what is stored and
// returned, slug normalisation, and — the part a mocked repository cannot prove — that PostgreSQL's UNIQUE(slug)
// decides concurrent creations, that a rejected request leaves nothing behind, and that the audit trail is
// attributed to the creator. Same isolation as the other e2e files: ephemeral local PGlite, never a real database.
describe('POST /businesses — SUPER_ADMIN business creation (e2e, real local Postgres)', () => {
  let testDb: TestDatabase;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let existing: Business;

  const users = {
    superAdmin: { email: 'root@businesses-create.test', password: 'Sup3rSecret!Root' },
    admin: { email: 'admin@businesses-create.test', password: 'Sup3rSecret!Admin' },
  };
  const tokens: Record<keyof typeof users, string> = {} as never;

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
    await runAllMigrations(dataSource);

    const businessRepo = dataSource.getRepository(Business);
    const userRepo = dataSource.getRepository(User);
    existing = await businessRepo.save(
      businessRepo.create({ name: 'Brasa 47', slug: 'brasa-47', address: 'Calle Existente 1', primaryColor: '#112233' }),
    );
    const make = async (u: { email: string; password: string }, role: UserRole, businessId: string | null) =>
      userRepo.save(userRepo.create({ email: u.email, passwordHash: await bcrypt.hash(u.password, TEST_BCRYPT_COST), role, businessId }));
    await make(users.superAdmin, UserRole.SUPER_ADMIN, null);
    await make(users.admin, UserRole.ADMIN, existing.id);
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      const res = await request(app.getHttpServer()).post('/auth/login').send(users[key]).expect(200);
      tokens[key] = res.body.accessToken;
    }
  }, 60_000);

  afterAll(async () => {
    delete process.env.MEDIA_PUBLIC_BASE_URL;
    await app?.close();
    await testDb?.stop();
  });

  const create = (token: string | null, body: unknown) => {
    const req = request(app.getHttpServer()).post('/businesses').send(body as object);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };
  const count = () => dataSource.getRepository(Business).count();
  const auditFor = (action: string) => dataSource.getRepository(AuditLog).find({ where: { action }, order: { createdAt: 'ASC' } });

  describe('authorization', () => {
    it('no JWT -> 401 and nothing is created', async () => {
      const before = await count();
      await create(null, { name: 'Anon', slug: 'anon' }).expect(401);
      await create('not-a-jwt', { name: 'Anon', slug: 'anon' }).expect(401);
      expect(await count()).toBe(before);
    });

    it('an ADMIN -> 403 and nothing is created (even with a valid body)', async () => {
      const before = await count();
      const res = await create(tokens.admin, { name: 'Sneaky', slug: 'sneaky' }).expect(403);
      expect(res.body.id).toBeUndefined();
      expect(await count()).toBe(before);
      expect(await dataSource.getRepository(Business).findOne({ where: { slug: 'sneaky' } })).toBeNull();
    });
  });

  describe('successful creation', () => {
    let created: Record<string, unknown>;

    it('SUPER_ADMIN -> 201 with the business, created active, server-generated id and no sensitive fields', async () => {
      const res = await create(tokens.superAdmin, {
        name: '  Nuevo Grill  ',
        slug: ' Nuevo-Grill ',
        address: 'Av. Demo 123',
        phone: '+56 9 0000 0000',
        hours: 'Lun-Dom 12:00-23:00',
      }).expect(201);
      created = res.body;

      expect(created).toMatchObject({
        name: 'Nuevo Grill',
        slug: 'nuevo-grill',
        active: true,
        address: 'Av. Demo 123',
        phone: '+56 9 0000 0000',
        hours: 'Lun-Dom 12:00-23:00',
        logoUrl: null,
        primaryColor: null,
        accentColor: null,
      });
      expect(new Date(created.createdAt as string).getTime()).not.toBeNaN();
      expect(new Date(created.updatedAt as string).getTime()).not.toBeNaN();
      expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      // exactly the same shape GET /businesses/me returns: the entity minus the internal storage key
      expect(Object.keys(created).sort()).toEqual(
        ['accentColor', 'active', 'address', 'createdAt', 'hours', 'id', 'logoUrl', 'name', 'phone', 'primaryColor', 'slug', 'updatedAt'],
      );
      expect(JSON.stringify(created)).not.toMatch(/logoStorageKey|passwordHash|users|token/i);
    });

    it('persists exactly that row (trimmed name, lowercase slug, no logo key)', async () => {
      const row = await dataSource.getRepository(Business).findOneByOrFail({ id: created.id as string });
      expect(row).toMatchObject({ name: 'Nuevo Grill', slug: 'nuevo-grill', active: true, logoStorageKey: null });
    });

    it('is visible to the existing reads: picker listing, /me with ?businessId= and an (empty) public menu', async () => {
      const list = await request(app.getHttpServer()).get('/businesses?search=nuevo').set('Authorization', `Bearer ${tokens.superAdmin}`).expect(200);
      expect(list.body.items).toEqual([{ id: created.id, name: 'Nuevo Grill', slug: 'nuevo-grill', active: true, logoUrl: null }]);

      const me = await request(app.getHttpServer()).get(`/businesses/me?businessId=${created.id as string}`).set('Authorization', `Bearer ${tokens.superAdmin}`).expect(200);
      expect(me.body).toMatchObject({ id: created.id, active: true });

      const categories = await request(app.getHttpServer()).get('/categories?businessSlug=nuevo-grill').expect(200);
      expect(categories.body).toEqual([]);
    });

    it('optional fields are stored as null when omitted or blank', async () => {
      const res = await create(tokens.superAdmin, { name: 'Minimal', slug: 'minimal', address: '   ', phone: '' }).expect(201);
      expect(res.body).toMatchObject({ address: null, phone: null, hours: null });
    });

    it('does not touch any other business', async () => {
      const row = await dataSource.getRepository(Business).findOneByOrFail({ id: existing.id });
      expect(row).toMatchObject({ name: 'Brasa 47', slug: 'brasa-47', active: true, address: 'Calle Existente 1', primaryColor: '#112233' });
      expect(row.updatedAt.getTime()).toBe(existing.updatedAt.getTime());
    });
  });

  describe('audit', () => {
    it('records BUSINESS_CREATED against the NEW business, attributed to the creating SUPER_ADMIN, with only name and slug', async () => {
      const res = await create(tokens.superAdmin, { name: 'Audited Place', slug: 'audited-place' }).expect(201);
      const entries = (await auditFor('BUSINESS_CREATED')).filter((e) => e.entityId === res.body.id);

      expect(entries).toHaveLength(1);
      const [entry] = entries;
      const root = await dataSource.getRepository(User).findOneByOrFail({ email: users.superAdmin.email });
      expect(entry).toMatchObject({
        businessId: res.body.id,
        entityId: res.body.id,
        entityType: 'Business',
        userId: root.id,
        userEmail: users.superAdmin.email,
        metadata: { name: 'Audited Place', slug: 'audited-place' },
      });
      expect(entry!.createdAt).toBeInstanceOf(Date);
      expect(JSON.stringify(entry!.metadata)).not.toMatch(/password|token|hash/i);
    });

    it('rejected requests (400, 403, 409) leave no audit entry', async () => {
      const before = (await auditFor('BUSINESS_CREATED')).length;
      await create(tokens.superAdmin, { name: 'Bad', slug: 'Bad Slug' }).expect(400);
      await create(tokens.admin, { name: 'Nope', slug: 'nope-slug' }).expect(403);
      await create(tokens.superAdmin, { name: 'Dup', slug: 'brasa-47' }).expect(409);
      expect((await auditFor('BUSINESS_CREATED')).length).toBe(before);
    });
  });

  describe('validation (400) and atomicity', () => {
    it.each([
      ['no body', {}],
      ['no slug', { name: 'X Place' }],
      ['no name', { slug: 'x-place' }],
      ['blank name', { name: '   ', slug: 'x-place' }],
      ['slug with a space', { name: 'X', slug: 'x place' }],
      ['slug with an accent', { name: 'X', slug: 'café' }],
      ['slug with an underscore', { name: 'X', slug: 'x_place' }],
      ['slug with a leading hyphen', { name: 'X', slug: '-xplace' }],
      ['slug too short', { name: 'X', slug: 'xp' }],
      ['slug too long', { name: 'X', slug: 'x'.repeat(61) }],
      ['a client-supplied id', { name: 'X', slug: 'x-place', id: '11111111-1111-4111-8111-111111111111' }],
      ['a client-supplied active', { name: 'X', slug: 'x-place', active: false }],
      ['a client-supplied logoStorageKey', { name: 'X', slug: 'x-place', logoStorageKey: 'businesses/x/logo/y.webp' }],
      ['a client-supplied createdAt', { name: 'X', slug: 'x-place', createdAt: '2020-01-01T00:00:00Z' }],
      ['client-supplied colours', { name: 'X', slug: 'x-place', primaryColor: '#112233' }],
      ['a nested relation', { name: 'X', slug: 'x-place', users: [{ email: 'a@b.c' }] }],
    ])('%s -> 400, nothing is created', async (_label, body) => {
      const before = await count();
      await create(tokens.superAdmin, body).expect(400);
      expect(await count()).toBe(before);
    });

    it('a client-supplied id never becomes the business id', async () => {
      const forged = '11111111-1111-4111-8111-111111111111';
      await create(tokens.superAdmin, { name: 'X', slug: 'forged-id', id: forged }).expect(400);
      expect(await dataSource.getRepository(Business).findOne({ where: { id: forged } })).toBeNull();
    });
  });

  describe('slug uniqueness (409 BUSINESS_SLUG_TAKEN)', () => {
    it('an existing slug -> 409 with a domain error code, and the original is untouched', async () => {
      const before = await count();
      const res = await create(tokens.superAdmin, { name: 'Impostor', slug: 'brasa-47' }).expect(409);
      expect(res.body.errorCode).toBe('BUSINESS_SLUG_TAKEN');
      expect(await count()).toBe(before);
      expect(await dataSource.getRepository(Business).findOneByOrFail({ id: existing.id })).toMatchObject({ name: 'Brasa 47' });
    });

    it('the same slug differing only by case/whitespace is the same slug (normalised before the insert)', async () => {
      const res = await create(tokens.superAdmin, { name: 'Impostor', slug: '  BRASA-47 ' }).expect(409);
      expect(res.body.errorCode).toBe('BUSINESS_SLUG_TAKEN');
    });

    it('the second creation of the same new slug -> 409', async () => {
      await create(tokens.superAdmin, { name: 'Twice', slug: 'twice-slug' }).expect(201);
      const res = await create(tokens.superAdmin, { name: 'Twice again', slug: 'twice-slug' }).expect(409);
      expect(res.body.errorCode).toBe('BUSINESS_SLUG_TAKEN');
    });

    it('the loser of a duplicate leaves no second row and no second audit entry', async () => {
      // Concurrency itself is NOT exercised here on purpose: the PGlite harness is a single Postgres session behind
      // one socket, so truly concurrent statements are not representable (see the checkpoint notes and the race
      // test in business.service.spec.ts). What this proves is the part that decides a race in production: the
      // UNIQUE(slug) constraint rejects the second INSERT and the service maps it to 409 with nothing left behind.
      await create(tokens.superAdmin, { name: 'First', slug: 'dup-slug' }).expect(201);
      await create(tokens.superAdmin, { name: 'Second', slug: 'dup-slug' }).expect(409);
      expect(await dataSource.getRepository(Business).count({ where: { slug: 'dup-slug' } })).toBe(1);
      const audit = (await auditFor('BUSINESS_CREATED')).filter((e) => (e.metadata as { slug?: string } | null)?.slug === 'dup-slug');
      expect(audit).toHaveLength(1);
      expect(await dataSource.getRepository(Business).findOneByOrFail({ slug: 'dup-slug' })).toMatchObject({ name: 'First' });
    });

    it('many different slugs created one after another all succeed with distinct ids', async () => {
      const ids = new Set<string>();
      for (let i = 0; i < 5; i += 1) {
        const res = await create(tokens.superAdmin, { name: `Serial ${i}`, slug: `serial-${i}` }).expect(201);
        ids.add(res.body.id);
      }
      expect(ids.size).toBe(5);
    });
  });
});
