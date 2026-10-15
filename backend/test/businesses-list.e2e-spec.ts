import bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { Business } from '../src/business/business.entity.js';
import { businessLogoKey } from '../src/media/media-key.util.js';
import { User } from '../src/user/user.entity.js';
import { UserRole } from '../src/user/user-role.enum.js';
import { runAllMigrations } from './support/run-all-migrations.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

const TEST_BCRYPT_COST = 4;
const MEDIA_BASE = 'https://api.example.com';

// Real-database proof of GET /businesses, the SUPER_ADMIN-only listing that is deliberately NOT tenant-scoped:
// who may call it (401 / 403 / 200), that it really spans tenants and ignores the JWT's own businessId, that
// `?businessId=` is rejected instead of scoping, what a row may contain, pagination ceilings, deterministic order
// and the parts a mocked repository cannot prove (ILIKE wildcard escaping against real rows). Same isolation as the
// other e2e files: ephemeral local PGlite, never a real database.
describe('GET /businesses — SUPER_ADMIN global listing (e2e, real local Postgres)', () => {
  let testDb: TestDatabase;
  let app: INestApplication<App>;
  let dataSource: DataSource;

  const byName: Record<string, Business> = {};
  const logoKey = (id: string) => businessLogoKey(id, randomUUID());
  let brasa47LogoKey: string;

  const users = {
    superAdmin: { email: 'root@businesses-list.test', password: 'Sup3rSecret!Root' },
    superAdminWithBusiness: { email: 'root-bound@businesses-list.test', password: 'Sup3rSecret!Bound' },
    adminAlfa: { email: 'admin-alfa@businesses-list.test', password: 'Sup3rSecret!Alfa' },
    adminBrasa: { email: 'admin-brasa@businesses-list.test', password: 'Sup3rSecret!Brasa' },
  };
  const tokens: Record<keyof typeof users, string> = {} as never;

  const NAMES = ['Alfa Grill', 'Brasa 47', 'Brasa Norte', 'Café 100% Carne', 'Dos Mismos', 'Dos Mismos', 'Zeta Pizza'];
  const TOTAL = NAMES.length;

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
    process.env.MEDIA_PUBLIC_BASE_URL = MEDIA_BASE;

    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    // Same global pipe main.ts installs: forbidNonWhitelisted is what turns ?businessId= into a 400.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = moduleFixture.get(DataSource);
    await runAllMigrations(dataSource);

    const businessRepo = dataSource.getRepository(Business);
    const userRepo = dataSource.getRepository(User);

    const slugs = ['alfa-grill', 'brasa-47', 'brasa-norte', 'cafe-100-carne', 'dos-mismos-a', 'dos-mismos-b', 'zeta-pizza'];
    const created: Business[] = [];
    for (let i = 0; i < NAMES.length; i += 1) {
      created.push(
        await businessRepo.save(
          businessRepo.create({ name: NAMES[i]!, slug: slugs[i]!, active: slugs[i] !== 'brasa-norte', address: 'Calle Secreta 123', phone: '+56 0000', primaryColor: '#112233' }),
        ),
      );
    }
    for (const b of created) byName[b.slug] = b;
    // one business with a logo (valid key shape, as the DB CHECK demands)
    brasa47LogoKey = logoKey(byName['brasa-47']!.id);
    await businessRepo.update(byName['brasa-47']!.id, { logoStorageKey: brasa47LogoKey });

    const make = async (u: { email: string; password: string }, role: UserRole, businessId: string | null) =>
      userRepo.save(userRepo.create({ email: u.email, passwordHash: await bcrypt.hash(u.password, TEST_BCRYPT_COST), role, businessId }));
    await make(users.superAdmin, UserRole.SUPER_ADMIN, null);
    // a SUPER_ADMIN that happens to have a businessId on the user row: the listing must still be global
    await make(users.superAdminWithBusiness, UserRole.SUPER_ADMIN, byName['alfa-grill']!.id);
    await make(users.adminAlfa, UserRole.ADMIN, byName['alfa-grill']!.id);
    await make(users.adminBrasa, UserRole.ADMIN, byName['brasa-47']!.id);

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

  const list = (token: string | null, query = '') => {
    const req = request(app.getHttpServer()).get(`/businesses${query}`);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };
  const names = (body: { items: Array<{ name: string }> }) => body.items.map((i) => i.name);

  describe('authorization', () => {
    it('no JWT -> 401', async () => {
      await list(null).expect(401);
    });

    it('an invalid / tampered JWT -> 401', async () => {
      await list('not-a-jwt').expect(401);
      await list(`${tokens.superAdmin}x`).expect(401);
    });

    it('an ADMIN -> 403, whichever business they own, and never gets a row', async () => {
      for (const token of [tokens.adminAlfa, tokens.adminBrasa]) {
        const res = await list(token).expect(403);
        expect(res.body.items).toBeUndefined();
        expect(JSON.stringify(res.body)).not.toMatch(/Alfa Grill|Brasa|slug/);
      }
    });

    it('an ADMIN is refused even when they ask for their own tenant (guard first, no scoped fallback)', async () => {
      await list(tokens.adminAlfa, `?businessId=${byName['alfa-grill']!.id}`).expect(403);
    });

    it('a SUPER_ADMIN -> 200', async () => {
      await list(tokens.superAdmin).expect(200);
    });

    it('ADMIN access to its own business is unchanged (GET /businesses/me still works)', async () => {
      const res = await request(app.getHttpServer()).get('/businesses/me').set('Authorization', `Bearer ${tokens.adminAlfa}`).expect(200);
      expect(res.body.id).toBe(byName['alfa-grill']!.id);
    });
  });

  describe('global across tenants', () => {
    it('a SUPER_ADMIN sees the businesses of every tenant', async () => {
      const res = await list(tokens.superAdmin).expect(200);
      expect(res.body.total).toBe(TOTAL);
      expect(new Set(res.body.items.map((i: { id: string }) => i.id))).toEqual(new Set(Object.values(byName).map((b) => b.id)));
      expect(names(res.body)).toEqual(expect.arrayContaining(['Alfa Grill', 'Brasa 47', 'Zeta Pizza']));
    });

    it("it does not depend on the JWT's businessId: a SUPER_ADMIN bound to one business gets the same global list", async () => {
      const unbound = await list(tokens.superAdmin).expect(200);
      const bound = await list(tokens.superAdminWithBusiness).expect(200);
      expect(bound.body).toEqual(unbound.body);
      expect(bound.body.total).toBe(TOTAL);
    });

    it('`?businessId=` is rejected (400), never turned into a tenant-scoped listing', async () => {
      for (const id of [byName['alfa-grill']!.id, randomUUID(), 'x']) {
        const res = await list(tokens.superAdmin, `?businessId=${id}`).expect(400);
        expect(JSON.stringify(res.body)).toMatch(/businessId should not exist/);
      }
    });
  });

  describe('response contract', () => {
    it('uses the project paginated format and each item has only id, name, slug, active, logoUrl', async () => {
      const res = await list(tokens.superAdmin).expect(200);
      expect(Object.keys(res.body).sort()).toEqual(['hasMore', 'items', 'limit', 'page', 'total', 'totalPages']);
      expect(res.body).toMatchObject({ page: 1, limit: 20, total: TOTAL, totalPages: 1, hasMore: false });
      for (const item of res.body.items) expect(Object.keys(item).sort()).toEqual(['active', 'id', 'logoUrl', 'name', 'slug']);
    });

    it('logoUrl is the stable /media URL for a business with a logo and null for the rest; the key never leaks', async () => {
      const res = await list(tokens.superAdmin).expect(200);
      const brasa = res.body.items.find((i: { slug: string }) => i.slug === 'brasa-47');
      expect(brasa.logoUrl).toBe(`${MEDIA_BASE}/media/${brasa47LogoKey}`);
      expect(res.body.items.filter((i: { logoUrl: string | null }) => i.logoUrl === null)).toHaveLength(TOTAL - 1);
      expect(JSON.stringify(res.body.items).replace(`${MEDIA_BASE}/media/${brasa47LogoKey}`, '')).not.toContain(brasa47LogoKey);
    });

    it('carries no sensitive or internal data (users, hashes, tokens, storage, contact details, colours)', async () => {
      const res = await list(tokens.superAdmin).expect(200);
      const text = JSON.stringify(res.body);
      for (const forbidden of [
        'password', 'hash', 'token', 'secret', '@', 'email', 'role', 'users', 'products', 'categories', 'tables', 'orders',
        'logoStorageKey', 'storageKey', 'bucket', 'Calle Secreta', '+56 0000', '#112233', 'primaryColor', 'address', 'phone', 'hours',
        'createdAt', 'updatedAt',
      ]) {
        expect(text, forbidden).not.toContain(forbidden);
      }
    });

    it('reports the real Business.active flag', async () => {
      const res = await list(tokens.superAdmin).expect(200);
      const bySlug = Object.fromEntries(res.body.items.map((i: { slug: string; active: boolean }) => [i.slug, i.active]));
      expect(bySlug['brasa-norte']).toBe(false);
      expect(bySlug['alfa-grill']).toBe(true);
    });
  });

  describe('pagination and order', () => {
    it('order is deterministic: name ASC with id as tiebreaker (matches the database order)', async () => {
      const res = await list(tokens.superAdmin).expect(200);
      const dbOrder = (await dataSource.query('SELECT id FROM businesses ORDER BY name ASC, id ASC')) as Array<{ id: string }>;
      expect(res.body.items.map((i: { id: string }) => i.id)).toEqual(dbOrder.map((r) => r.id));
      // the two businesses with the same name are adjacent and ordered by id
      const twins = res.body.items.filter((i: { name: string }) => i.name === 'Dos Mismos').map((i: { id: string }) => i.id);
      expect(twins).toHaveLength(2);
      expect(twins).toEqual([...twins].sort((a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)));
      const again = await list(tokens.superAdmin).expect(200);
      expect(again.body).toEqual(res.body);
    });

    it('paginates with a real total: pages concatenate to the full list with no gaps or repeats', async () => {
      const full = await list(tokens.superAdmin).expect(200);
      const seen: string[] = [];
      for (let page = 1; page <= 3; page += 1) {
        const res = await list(tokens.superAdmin, `?page=${page}&limit=3`).expect(200);
        expect(res.body).toMatchObject({ page, limit: 3, total: TOTAL, totalPages: 3, hasMore: page < 3 });
        expect(res.body.items.length).toBe(page < 3 ? 3 : 1);
        seen.push(...res.body.items.map((i: { id: string }) => i.id));
      }
      expect(seen).toEqual(full.body.items.map((i: { id: string }) => i.id));
      const beyond = await list(tokens.superAdmin, '?page=9&limit=3').expect(200);
      expect(beyond.body).toMatchObject({ items: [], total: TOTAL, hasMore: false });
    });

    it('respects the ceilings: limit <= 100 (101 is a 400), page and limit >= 1, numbers only', async () => {
      await list(tokens.superAdmin, '?limit=100').expect(200);
      for (const bad of ['?limit=101', '?limit=0', '?page=0', '?page=-1', '?limit=abc', '?page=1.5']) await list(tokens.superAdmin, bad).expect(400);
    });
  });

  describe('search and active filter', () => {
    it('search matches the name, case-insensitively', async () => {
      expect(names((await list(tokens.superAdmin, '?search=brasa').expect(200)).body)).toEqual(['Brasa 47', 'Brasa Norte']);
      expect(names((await list(tokens.superAdmin, '?search=BRASA').expect(200)).body)).toEqual(['Brasa 47', 'Brasa Norte']);
    });

    it('search also matches the slug', async () => {
      const res = await list(tokens.superAdmin, '?search=zeta-p').expect(200);
      expect(names(res.body)).toEqual(['Zeta Pizza']);
      expect(res.body.total).toBe(1);
    });

    it('LIKE wildcards in the search are literal: % and _ do not match everything', async () => {
      expect(names((await list(tokens.superAdmin, `?search=${encodeURIComponent('%')}`).expect(200)).body)).toEqual(['Café 100% Carne']);
      expect((await list(tokens.superAdmin, `?search=${encodeURIComponent('_')}`).expect(200)).body.total).toBe(0);
      expect((await list(tokens.superAdmin, `?search=${encodeURIComponent('Brasa _7')}`).expect(200)).body.total).toBe(0);
      expect((await list(tokens.superAdmin, `?search=${encodeURIComponent("'; DROP TABLE businesses; --")}`).expect(200)).body.total).toBe(0);
      expect((await list(tokens.superAdmin).expect(200)).body.total).toBe(TOTAL); // and nothing was dropped
    });

    it('search normalises spaces; an empty search is no filter; more than 80 characters is a 400', async () => {
      expect(names((await list(tokens.superAdmin, `?search=${encodeURIComponent('   brasa    norte  ')}`).expect(200)).body)).toEqual(['Brasa Norte']);
      expect((await list(tokens.superAdmin, '?search=').expect(200)).body.total).toBe(TOTAL);
      expect((await list(tokens.superAdmin, `?search=${'a'.repeat(80)}`).expect(200)).body.total).toBe(0);
      await list(tokens.superAdmin, `?search=${'a'.repeat(81)}`).expect(400);
    });

    it('active=false / active=true filter on Business.active, and combine with search; anything else is a 400', async () => {
      expect(names((await list(tokens.superAdmin, '?active=false').expect(200)).body)).toEqual(['Brasa Norte']);
      const active = await list(tokens.superAdmin, '?active=true').expect(200);
      expect(active.body.total).toBe(TOTAL - 1);
      expect(names(active.body)).not.toContain('Brasa Norte');
      expect(names((await list(tokens.superAdmin, '?active=false&search=brasa').expect(200)).body)).toEqual(['Brasa Norte']);
      expect((await list(tokens.superAdmin, '?active=true&search=norte').expect(200)).body.total).toBe(0);
      for (const bad of ['?active=maybe', '?active=1', '?active=']) await list(tokens.superAdmin, bad).expect(400);
    });
  });
});
