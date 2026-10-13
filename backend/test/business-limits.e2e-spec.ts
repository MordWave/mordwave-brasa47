import bcrypt from 'bcrypt';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { Business } from '../src/business/business.entity.js';
import { Category } from '../src/category/category.entity.js';
import { Product } from '../src/product/product.entity.js';
import { RestaurantTable } from '../src/table/table.entity.js';
import { User } from '../src/user/user.entity.js';
import { UserRole } from '../src/user/user-role.enum.js';
import { runAllMigrations } from './support/run-all-migrations.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

const TEST_BCRYPT_COST = 4;

const LIMIT_PRODUCTS = 3;
const LIMIT_CATEGORIES = 2;
const LIMIT_TABLES = 2;

// Real-database proof of the per-Business technical ceilings and the
// defensive list caps — same isolation approach as audit.e2e-spec.ts and
// products-admin.e2e-spec.ts (ephemeral local PGlite, never Supabase).
// The ceilings are lowered through the real BUSINESS_MAX_* environment
// variables (the same mechanism an operator would use), so the production
// defaults (500/50/200) never need to be filled in a test.
//
// Known limit of this harness: PGlite's socket only tolerates ONE
// connection (see test/support/test-database.ts), so concurrent requests are
// serialized by the single pooled connection itself. The "burst" test below
// still proves the ceiling holds under a concurrent burst, but it cannot, on
// its own, prove that the FOR UPDATE lock is what holds it — that part is
// covered by BusinessLimitsService's unit tests (lock happens before the
// count) and by a live check against a multi-connection Postgres.
describe('Business limits (e2e, real local Postgres — never Supabase)', () => {
  let testDb: TestDatabase;
  let app: INestApplication<App>;
  let dataSource: DataSource;

  let businessA: Business;
  let businessB: Business;
  let businessC: Business;
  const password = 'Sup3rSecret!';
  let tokenA: string;
  let tokenB: string;
  let tokenC: string;
  let tokenSuper: string;

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
    process.env.BUSINESS_MAX_PRODUCTS = String(LIMIT_PRODUCTS);
    process.env.BUSINESS_MAX_CATEGORIES = String(LIMIT_CATEGORIES);
    process.env.BUSINESS_MAX_TABLES = String(LIMIT_TABLES);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    dataSource = moduleFixture.get(DataSource);

    await runAllMigrations(dataSource);

    const businessRepo = dataSource.getRepository(Business);
    const userRepo = dataSource.getRepository(User);

    businessA = await businessRepo.save(businessRepo.create({ name: 'A', slug: 'a-limits-e2e' }));
    businessB = await businessRepo.save(businessRepo.create({ name: 'B', slug: 'b-limits-e2e' }));
    businessC = await businessRepo.save(businessRepo.create({ name: 'C', slug: 'c-limits-e2e' }));

    const hash = await bcrypt.hash(password, TEST_BCRYPT_COST);
    const seedUser = (email: string, role: UserRole, businessId: string | null) =>
      userRepo.save(userRepo.create({ email, passwordHash: hash, role, businessId }));
    await seedUser('a@limits-e2e.test', UserRole.ADMIN, businessA.id);
    await seedUser('b@limits-e2e.test', UserRole.ADMIN, businessB.id);
    await seedUser('c@limits-e2e.test', UserRole.ADMIN, businessC.id);
    await seedUser('super@limits-e2e.test', UserRole.SUPER_ADMIN, null);

    const login = async (email: string): Promise<string> => {
      const res = await request(app.getHttpServer()).post('/auth/login').send({ email, password }).expect(200);
      return res.body.accessToken;
    };
    tokenA = await login('a@limits-e2e.test');
    tokenB = await login('b@limits-e2e.test');
    tokenC = await login('c@limits-e2e.test');
    tokenSuper = await login('super@limits-e2e.test');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await testDb?.stop();
  });

  const post = (path: string, token: string, body: object) =>
    request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`).send(body);
  const patch = (path: string, token: string, body: object) =>
    request(app.getHttpServer()).patch(path).set('Authorization', `Bearer ${token}`).send(body);
  const del = (path: string, token: string) =>
    request(app.getHttpServer()).delete(path).set('Authorization', `Bearer ${token}`);
  const get = (path: string, token: string) =>
    request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`);

  const createCategory = (token: string, businessId: string, slug: string) =>
    post('/categories', token, { name: `Cat ${slug}`, slug, businessId });
  const createProduct = (token: string, businessId: string, categoryId: string, name: string) =>
    post('/products', token, { name, price: 1000, categoryId, businessId });
  const createTable = (token: string, businessId: string, name: string, extra: object = {}) =>
    post('/tables', token, { name, businessId, ...extra });

  const limitBody = (errorCode: string, limit: number) => ({
    message: expect.any(String),
    errorCode,
    limit,
  });

  describe('categories', () => {
    const ids: string[] = [];

    it('permite hasta el límite y el siguiente devuelve 409 { errorCode, limit, message } sin información interna', async () => {
      for (let i = 1; i <= LIMIT_CATEGORIES; i += 1) {
        const res = await createCategory(tokenA, businessA.id, `a-cat-${i}`).expect(201);
        ids.push(res.body.id);
      }

      const blocked = await createCategory(tokenA, businessA.id, 'a-cat-over').expect(409);

      expect(blocked.body).toEqual(limitBody('BUSINESS_CATEGORY_LIMIT_REACHED', LIMIT_CATEGORIES));
      const raw = JSON.stringify(blocked.body);
      expect(raw).not.toContain(businessA.id);
      expect(raw).not.toMatch(/stack|select\s|insert\s|relation|"categories"|"businesses"|at \w+\./i);
    });

    it('las categorías inactivas siguen consumiendo cupo', async () => {
      await patch(`/categories/${ids[0]}`, tokenA, { active: false }).expect(200);

      await createCategory(tokenA, businessA.id, 'a-cat-over').expect(409);
    });

    it('aislamiento multi-tenant: otro Business no se ve afectado por el cupo lleno de A', async () => {
      await createCategory(tokenB, businessB.id, 'b-cat-1').expect(201);
    });

    it('SUPER_ADMIN también respeta el límite del Business objetivo', async () => {
      const blocked = await createCategory(tokenSuper, businessA.id, 'a-cat-super').expect(409);
      expect(blocked.body.errorCode).toBe('BUSINESS_CATEGORY_LIMIT_REACHED');

      await createCategory(tokenSuper, businessB.id, 'b-cat-super').expect(201);
    });

    it('un borrado (soft delete) libera cupo', async () => {
      await del(`/categories/${ids[0]}`, tokenA).expect(204);

      await createCategory(tokenA, businessA.id, 'a-cat-after-delete').expect(201);
      await createCategory(tokenA, businessA.id, 'a-cat-over-again').expect(409);
    });
  });

  describe('products', () => {
    let categoryB1: string;
    const productIds: string[] = [];

    it('permite hasta el límite y el siguiente devuelve 409', async () => {
      // Business B already holds 2 categories from the section above (limit 2): reuse one.
      const cats = await get('/categories/admin', tokenB).expect(200);
      categoryB1 = cats.body[0].id;

      for (let i = 1; i <= LIMIT_PRODUCTS; i += 1) {
        const res = await createProduct(tokenB, businessB.id, categoryB1, `B prod ${i}`).expect(201);
        productIds.push(res.body.id);
      }

      const blocked = await createProduct(tokenB, businessB.id, categoryB1, 'B prod over').expect(409);
      expect(blocked.body).toEqual(limitBody('BUSINESS_PRODUCT_LIMIT_REACHED', LIMIT_PRODUCTS));
    });

    it('activos e inactivos (y no disponibles) consumen cupo', async () => {
      await patch(`/products/${productIds[0]}`, tokenB, { active: false }).expect(200);
      await patch(`/products/${productIds[1]}`, tokenB, { available: false }).expect(200);

      await createProduct(tokenB, businessB.id, categoryB1, 'B prod over').expect(409);
    });

    it('aislamiento multi-tenant: A crea productos aunque B esté lleno', async () => {
      const cats = await get('/categories/admin', tokenA).expect(200);
      await createProduct(tokenA, businessA.id, cats.body[0].id, 'A prod 1').expect(201);
    });

    it('SUPER_ADMIN también respeta el límite', async () => {
      const blocked = await createProduct(tokenSuper, businessB.id, categoryB1, 'B prod super').expect(409);
      expect(blocked.body.errorCode).toBe('BUSINESS_PRODUCT_LIMIT_REACHED');
    });

    it('mover un producto a otro Business valida el cupo del DESTINO y no lo mueve si está lleno', async () => {
      const catsA = await get('/categories/admin', tokenA).expect(200);
      const aProduct = (await get('/products/admin', tokenA).expect(200)).body.items[0];
      const catsB = await get('/categories/admin', tokenB).expect(200);

      // B is full: SUPER_ADMIN moving A's product into B must be rejected…
      const blocked = await patch(`/products/${aProduct.id}`, tokenSuper, {
        businessId: businessB.id,
        categoryId: catsB.body[0].id,
      }).expect(409);
      expect(blocked.body.errorCode).toBe('BUSINESS_PRODUCT_LIMIT_REACHED');

      // …and the product is untouched, still in A.
      const still = await get('/products/admin', tokenA).expect(200);
      expect(still.body.items.map((p: Product) => p.id)).toContain(aProduct.id);

      // Free one slot in B, and now the move goes through.
      await del(`/products/${productIds[2]}`, tokenB).expect(204);
      await patch(`/products/${aProduct.id}`, tokenSuper, {
        businessId: businessB.id,
        categoryId: catsB.body[0].id,
      }).expect(200);
      const moved = await get('/products/admin', tokenB).expect(200);
      expect(moved.body.items.map((p: Product) => p.id)).toContain(aProduct.id);
      expect(catsA.body.length).toBeGreaterThan(0);
    });

    it('un borrado (soft delete) libera cupo', async () => {
      // B is full again after the move (3 live products): delete one, create one.
      await createProduct(tokenB, businessB.id, categoryB1, 'B prod over').expect(409);
      await del(`/products/${productIds[1]}`, tokenB).expect(204);

      await createProduct(tokenB, businessB.id, categoryB1, 'B prod after delete').expect(201);
    });
  });

  describe('tables', () => {
    const ids: string[] = [];

    it('permite hasta el límite (también mesas creadas inactivas) y el siguiente devuelve 409', async () => {
      ids.push((await createTable(tokenA, businessA.id, 'Mesa 1').expect(201)).body.id);
      ids.push((await createTable(tokenA, businessA.id, 'Mesa 2', { active: false }).expect(201)).body.id);

      const blocked = await createTable(tokenA, businessA.id, 'Mesa 3').expect(409);

      expect(blocked.body).toEqual(limitBody('BUSINESS_TABLE_LIMIT_REACHED', LIMIT_TABLES));
    });

    it('aislamiento multi-tenant y SUPER_ADMIN', async () => {
      await createTable(tokenB, businessB.id, 'Mesa B1').expect(201);

      const blocked = await createTable(tokenSuper, businessA.id, 'Mesa super').expect(409);
      expect(blocked.body.errorCode).toBe('BUSINESS_TABLE_LIMIT_REACHED');
      await createTable(tokenSuper, businessB.id, 'Mesa B2').expect(201);
    });

    it('un borrado (soft delete) libera cupo', async () => {
      await del(`/tables/${ids[0]}`, tokenA).expect(204);

      await createTable(tokenA, businessA.id, 'Mesa 3').expect(201);
      await createTable(tokenA, businessA.id, 'Mesa 4').expect(409);
    });
  });

  describe('ráfaga concurrente', () => {
    it('nunca supera el límite: con 1 cupo libre, exactamente 1 de varias creaciones simultáneas entra', async () => {
      // Business C starts empty; fill all but one category slot.
      await createCategory(tokenC, businessC.id, 'c-burst-0').expect(201);

      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) => createCategory(tokenC, businessC.id, `c-burst-${i + 1}`)),
      );

      expect(results.filter((r) => r.status === 201)).toHaveLength(LIMIT_CATEGORIES - 1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(4);
      const live = await dataSource.getRepository(Category).count({ where: { businessId: businessC.id } });
      expect(live).toBe(LIMIT_CATEGORIES);
    });
  });

  // Rows inserted directly through the repositories (bypassing the API on
  // purpose) to simulate a tenant that is OVER the ceiling — e.g. data from
  // before the ceilings existed — and prove the defensive caps and the
  // deterministic order. Uses Business D so the sections above are unaffected.
  describe('topes defensivos y orden determinístico', () => {
    let businessD: Business;
    let tokenD: string;
    let categoryIds: string[];
    let productIdsD: string[];
    let tableIds: string[];

    beforeAll(async () => {
      const businessRepo = dataSource.getRepository(Business);
      const categoryRepo = dataSource.getRepository(Category);
      const productRepo = dataSource.getRepository(Product);
      const tableRepo = dataSource.getRepository(RestaurantTable);
      const userRepo = dataSource.getRepository(User);

      businessD = await businessRepo.save(businessRepo.create({ name: 'D', slug: 'd-limits-e2e' }));
      await userRepo.save(
        userRepo.create({
          email: 'd@limits-e2e.test',
          passwordHash: await bcrypt.hash(password, TEST_BCRYPT_COST),
          role: UserRole.ADMIN,
          businessId: businessD.id,
        }),
      );
      tokenD = (
        await request(app.getHttpServer())
          .post('/auth/login')
          .send({ email: 'd@limits-e2e.test', password })
          .expect(200)
      ).body.accessToken;

      // 4 categories (cap 2) and 6 products (cap 3), 4 tables (cap 2) — all
      // sharing the same sortOrder AND the same createdAt, so only `id` can
      // break the ties.
      const cats = await categoryRepo.save(
        Array.from({ length: 4 }, (_, i) =>
          categoryRepo.create({ name: `D cat ${i}`, slug: `d-cat-${i}`, businessId: businessD.id, sortOrder: 0 }),
        ),
      );
      categoryIds = cats.map((c) => c.id).sort();

      const firstCategory = categoryIds[0];
      const prods = await productRepo.save(
        Array.from({ length: 6 }, (_, i) =>
          productRepo.create({
            name: `D prod ${i}`,
            price: 1000,
            businessId: businessD.id,
            categoryId: firstCategory,
            sortOrder: 0,
          }),
        ),
      );
      productIdsD = prods.map((p) => p.id).sort();

      const tbls = await tableRepo.save(
        Array.from({ length: 4 }, (_, i) =>
          tableRepo.create({ name: `D mesa ${i}`, businessId: businessD.id, qrToken: `d-qr-${i}-${Date.now()}` }),
        ),
      );
      tableIds = tbls.map((t) => t.id).sort();

      for (const table of ['categories', 'products', 'restaurant_tables']) {
        await dataSource.query(`UPDATE ${table} SET created_at = '2026-01-01T00:00:00Z' WHERE business_id = $1`, [
          businessD.id,
        ]);
      }
    });

    it('menú público: categorías limitadas al máximo permitido, desempate por id', async () => {
      const res = await request(app.getHttpServer()).get('/categories?businessSlug=d-limits-e2e').expect(200);

      expect(res.body.map((c: Category) => c.id)).toEqual(categoryIds.slice(0, LIMIT_CATEGORIES));
    });

    it('menú público: productos limitados al máximo permitido, desempate por id', async () => {
      const res = await request(app.getHttpServer()).get('/products?businessSlug=d-limits-e2e').expect(200);

      expect(res.body.map((p: Product) => p.id)).toEqual(productIdsD.slice(0, LIMIT_PRODUCTS));
    });

    it('el orden es estable entre llamadas repetidas', async () => {
      const first = await request(app.getHttpServer()).get('/products?businessSlug=d-limits-e2e').expect(200);
      const second = await request(app.getHttpServer()).get('/products?businessSlug=d-limits-e2e').expect(200);

      expect(second.body.map((p: Product) => p.id)).toEqual(first.body.map((p: Product) => p.id));
    });

    it('listados Admin de categorías y mesas con el mismo tope y orden determinístico', async () => {
      const cats = await get('/categories/admin', tokenD).expect(200);
      expect(cats.body.map((c: Category) => c.id)).toEqual(categoryIds.slice(0, LIMIT_CATEGORIES));

      const tables = await get('/tables/admin', tokenD).expect(200);
      expect(tables.body).toHaveLength(LIMIT_TABLES);
      expect(tables.body.map((t: { id: string }) => t.id)).toEqual(tableIds.slice(0, LIMIT_TABLES));
    });

    // Truncation is detected by asking for ONE row more than the cap — not by
    // "returned === cap". Business D holds MORE rows than allowed (data from
    // before the ceilings), Business E holds EXACTLY the allowed amount.
    describe('detección real de truncamiento (limit + 1, sin COUNT)', () => {
      let businessE: Business;
      let warn: ReturnType<typeof vi.spyOn>;

      const cappedWarnings = () =>
        warn.mock.calls.map((call) => String(call[0])).filter((message) => message.startsWith('business_list_capped'));

      beforeAll(async () => {
        const businessRepo = dataSource.getRepository(Business);
        const categoryRepo = dataSource.getRepository(Category);
        const productRepo = dataSource.getRepository(Product);
        const tableRepo = dataSource.getRepository(RestaurantTable);

        businessE = await businessRepo.save(businessRepo.create({ name: 'E', slug: 'e-limits-e2e' }));
        // No admin user (and no extra login — /auth/login is rate limited to
        // 5/min per IP and this file already uses them): the Admin listings
        // of E are read as SUPER_ADMIN scoped with ?businessId=.

        // Exactly at every ceiling: 2 categories, 3 products, 2 tables.
        const cats = await categoryRepo.save(
          Array.from({ length: LIMIT_CATEGORIES }, (_, i) =>
            categoryRepo.create({ name: `E cat ${i}`, slug: `e-cat-${i}`, businessId: businessE.id, sortOrder: i }),
          ),
        );
        await productRepo.save(
          Array.from({ length: LIMIT_PRODUCTS }, (_, i) =>
            productRepo.create({
              name: `E prod ${i}`,
              price: 1000,
              businessId: businessE.id,
              categoryId: cats[0].id,
              sortOrder: i,
            }),
          ),
        );
        await tableRepo.save(
          Array.from({ length: LIMIT_TABLES }, (_, i) =>
            tableRepo.create({ name: `E mesa ${i}`, businessId: businessE.id, qrToken: `e-qr-${i}-${Date.now()}` }),
          ),
        );
      });

      const spyOnWarnings = () => {
        warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      };
      afterEach(() => warn?.mockRestore());

      it('exactamente en el límite: devuelve todo y NO registra truncamiento (categorías públicas y Admin)', async () => {
        spyOnWarnings();

        const publicRes = await request(app.getHttpServer()).get('/categories?businessSlug=e-limits-e2e').expect(200);
        const adminRes = await get(`/categories/admin?businessId=${businessE.id}`, tokenSuper).expect(200);

        expect(publicRes.body).toHaveLength(LIMIT_CATEGORIES);
        expect(adminRes.body).toHaveLength(LIMIT_CATEGORIES);
        expect(cappedWarnings()).toEqual([]);
      });

      it('exactamente en el límite: productos públicos y mesas Admin completos, sin registrar truncamiento', async () => {
        spyOnWarnings();

        const products = await request(app.getHttpServer()).get('/products?businessSlug=e-limits-e2e').expect(200);
        const tables = await get(`/tables/admin?businessId=${businessE.id}`, tokenSuper).expect(200);

        expect(products.body).toHaveLength(LIMIT_PRODUCTS);
        expect(tables.body).toHaveLength(LIMIT_TABLES);
        expect(cappedWarnings()).toEqual([]);
      });

      it('por encima del límite: categorías públicas y Admin se recortan al límite y se registra el warning', async () => {
        spyOnWarnings();

        const publicRes = await request(app.getHttpServer()).get('/categories?businessSlug=d-limits-e2e').expect(200);
        expect(publicRes.body.map((c: Category) => c.id)).toEqual(categoryIds.slice(0, LIMIT_CATEGORIES));
        expect(cappedWarnings()).toEqual([
          `business_list_capped businessId=${businessD.id} resource=category cap=${LIMIT_CATEGORIES}`,
        ]);

        const adminRes = await get('/categories/admin', tokenD).expect(200);
        expect(adminRes.body).toHaveLength(LIMIT_CATEGORIES);
        expect(cappedWarnings()).toHaveLength(2);
      });

      it('por encima del límite: productos públicos y mesas Admin se recortan y se registra el warning de cada recurso', async () => {
        spyOnWarnings();

        const products = await request(app.getHttpServer()).get('/products?businessSlug=d-limits-e2e').expect(200);
        expect(products.body.map((p: Product) => p.id)).toEqual(productIdsD.slice(0, LIMIT_PRODUCTS));
        expect(cappedWarnings()).toContain(
          `business_list_capped businessId=${businessD.id} resource=product cap=${LIMIT_PRODUCTS}`,
        );

        const tables = await get('/tables/admin', tokenD).expect(200);
        expect(tables.body.map((t: { id: string }) => t.id)).toEqual(tableIds.slice(0, LIMIT_TABLES));
        expect(cappedWarnings()).toContain(
          `business_list_capped businessId=${businessD.id} resource=table cap=${LIMIT_TABLES}`,
        );
      });
    });

    it('un Business dentro del límite nunca se trunca (el tope es el mismo número que puede crear)', async () => {
      const res = await request(app.getHttpServer()).get('/categories?businessSlug=a-limits-e2e').expect(200);

      expect(res.body.length).toBeLessThanOrEqual(LIMIT_CATEGORIES);
      const live = await dataSource
        .getRepository(Category)
        .count({ where: { businessId: businessA.id, active: true } });
      expect(res.body).toHaveLength(live);
    });
  });
});
