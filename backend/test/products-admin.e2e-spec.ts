import bcrypt from 'bcrypt';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { Business } from '../src/business/business.entity.js';
import { Category } from '../src/category/category.entity.js';
import { Product } from '../src/product/product.entity.js';
import { User } from '../src/user/user.entity.js';
import { UserRole } from '../src/user/user-role.enum.js';
import { runAllMigrations } from './support/run-all-migrations.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

const TEST_BCRYPT_COST = 4;

// Real-database proof of the paginated admin product listing and its
// whole-catalog summary — in particular the parts a mocked repository can't
// prove: that ILIKE wildcards are really escaped, that GROUP BY really
// excludes soft-deleted rows, and that two tenants never see each other.
// Same isolation approach as audit.e2e-spec.ts: ephemeral local PGlite,
// never Supabase (see that file for why each env override below is needed).
describe('Admin products pagination (e2e, real local Postgres — never Supabase)', () => {
  let testDb: TestDatabase;
  let app: INestApplication<App>;
  let dataSource: DataSource;

  let businessA: Business;
  let businessB: Business;
  let burgers: Category;
  let drinks: Category;
  const adminA = { email: 'admin-a@products-e2e.test', password: 'Sup3rSecret!A' };
  const adminB = { email: 'admin-b@products-e2e.test', password: 'Sup3rSecret!B' };
  let tokenA: string;
  let tokenB: string;

  const BURGER_COUNT = 25;

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

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // Same global pipe main.ts installs — without it DTO validation/coercion
    // (the whole point of several tests below) would never run.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    dataSource = moduleFixture.get(DataSource);

    await runAllMigrations(dataSource);

    const businessRepo = dataSource.getRepository(Business);
    const userRepo = dataSource.getRepository(User);
    const categoryRepo = dataSource.getRepository(Category);
    const productRepo = dataSource.getRepository(Product);

    businessA = await businessRepo.save(
      businessRepo.create({ name: 'Tenant A', slug: 'tenant-a-products-e2e' }),
    );
    businessB = await businessRepo.save(
      businessRepo.create({ name: 'Tenant B', slug: 'tenant-b-products-e2e' }),
    );

    for (const [admin, business] of [
      [adminA, businessA],
      [adminB, businessB],
    ] as const) {
      await userRepo.save(
        userRepo.create({
          email: admin.email,
          passwordHash: await bcrypt.hash(admin.password, TEST_BCRYPT_COST),
          role: UserRole.ADMIN,
          businessId: business.id,
        }),
      );
    }

    burgers = await categoryRepo.save(
      categoryRepo.create({ name: 'Hamburguesas', slug: 'hamburguesas', businessId: businessA.id, sortOrder: 1 }),
    );
    drinks = await categoryRepo.save(
      categoryRepo.create({ name: 'Bebidas', slug: 'bebidas', businessId: businessA.id, sortOrder: 2 }),
    );
    const categoryB = await categoryRepo.save(
      categoryRepo.create({ name: 'Hamburguesas', slug: 'hamburguesas', businessId: businessB.id, sortOrder: 1 }),
    );

    const make = (
      businessId: string,
      categoryId: string,
      name: string,
      extra: Partial<Product> = {},
    ) => productRepo.create({ businessId, categoryId, name, price: 5000, ...extra });

    // Business A — 25 plain burgers (sortOrder = index), 1 inactive, 1
    // unavailable, 1 soft-deleted (must never show up anywhere), and 3
    // drinks, two of them with LIKE wildcards literally in their name.
    const rowsA: Product[] = [];
    for (let i = 1; i <= BURGER_COUNT; i += 1) {
      rowsA.push(make(businessA.id, burgers.id, `Burger ${String(i).padStart(2, '0')}`, { sortOrder: i }));
    }
    rowsA.push(make(businessA.id, burgers.id, 'Burger Vieja', { sortOrder: 100, active: false }));
    rowsA.push(make(businessA.id, burgers.id, 'Burger Agotada', { sortOrder: 101, available: false }));
    rowsA.push(make(businessA.id, drinks.id, 'Limonada', { sortOrder: 1 }));
    rowsA.push(make(businessA.id, drinks.id, 'Jugo 50% natural', { sortOrder: 2 }));
    rowsA.push(make(businessA.id, drinks.id, 'Coca_Cola', { sortOrder: 3 }));
    await productRepo.save(rowsA);

    const deleted = await productRepo.save(
      make(businessA.id, burgers.id, 'Burger Borrada', { sortOrder: 200 }),
    );
    await productRepo.softDelete(deleted.id);

    await productRepo.save([
      make(businessB.id, categoryB.id, 'Burger B1'),
      make(businessB.id, categoryB.id, 'Burger B2'),
    ]);

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
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await testDb?.stop();
  });

  const listA = (query = '') =>
    request(app.getHttpServer())
      .get(`/products/admin${query}`)
      .set('Authorization', `Bearer ${tokenA}`);

  const summary = (token: string, query = '') =>
    request(app.getHttpServer())
      .get(`/products/admin/summary${query}`)
      .set('Authorization', `Bearer ${token}`);

  // 25 burgers + Vieja + Agotada + 3 drinks = 30 live rows (Borrada excluded).
  const LIVE_TOTAL = BURGER_COUNT + 2 + 3;

  it('exige autenticación en ambos endpoints', async () => {
    await request(app.getHttpServer()).get('/products/admin').expect(401);
    await request(app.getHttpServer()).get('/products/admin/summary').expect(401);
  });

  it('por defecto devuelve la página 1 con límite 20 y el sobre estándar', async () => {
    const res = await listA().expect(200);

    expect(res.body).toMatchObject({
      page: 1,
      limit: 20,
      total: LIVE_TOTAL,
      totalPages: 2,
      hasMore: true,
    });
    expect(res.body.items).toHaveLength(20);
  });

  it('la página 2 trae el resto, hasMore=false, sin solapar ni repetir filas y sin la fila soft-deleted', async () => {
    const page1 = await listA('?page=1&limit=20').expect(200);
    const page2 = await listA('?page=2&limit=20').expect(200);

    expect(page2.body).toMatchObject({ page: 2, total: LIVE_TOTAL, totalPages: 2, hasMore: false });
    expect(page2.body.items).toHaveLength(LIVE_TOTAL - 20);

    const ids = [...page1.body.items, ...page2.body.items].map((p: Product) => p.id);
    expect(new Set(ids).size).toBe(LIVE_TOTAL);
    const names = [...page1.body.items, ...page2.body.items].map((p: Product) => p.name);
    expect(names).not.toContain('Burger Borrada');
  });

  it('una página más allá de la última devuelve items vacíos pero conserva total/totalPages reales', async () => {
    const res = await listA('?page=9').expect(200);

    expect(res.body).toMatchObject({ items: [], page: 9, total: LIVE_TOTAL, totalPages: 2, hasMore: false });
  });

  it('respeta limit pero nunca más de 100 (101 → 400)', async () => {
    const ok = await listA('?limit=100').expect(200);
    expect(ok.body.items).toHaveLength(LIVE_TOTAL);
    expect(ok.body.totalPages).toBe(1);

    await listA('?limit=101').expect(400);
    await listA('?page=0').expect(400);
  });

  it('filtra por categoryId', async () => {
    const res = await listA(`?categoryId=${drinks.id}`).expect(200);

    expect(res.body.total).toBe(3);
    expect(res.body.items.every((p: Product) => p.categoryId === drinks.id)).toBe(true);
  });

  it('search es case-insensitive y parcial sobre el nombre', async () => {
    const res = await listA('?search=BURGER&limit=100').expect(200);

    expect(res.body.total).toBe(BURGER_COUNT + 2);
    expect(res.body.items.every((p: Product) => /burger/i.test(p.name))).toBe(true);

    const partial = await listA('?search=imon').expect(200);
    expect(partial.body.items.map((p: Product) => p.name)).toEqual(['Limonada']);
  });

  it('search trata % y _ literalmente (no como comodines)', async () => {
    const percent = await listA(`?search=${encodeURIComponent('%')}`).expect(200);
    expect(percent.body.items.map((p: Product) => p.name)).toEqual(['Jugo 50% natural']);

    const underscore = await listA(`?search=${encodeURIComponent('_')}`).expect(200);
    expect(underscore.body.items.map((p: Product) => p.name)).toEqual(['Coca_Cola']);
  });

  it('un search sin coincidencias devuelve el sobre vacío', async () => {
    const res = await listA('?search=zzz-no-existe').expect(200);

    expect(res.body).toEqual({ items: [], page: 1, limit: 20, total: 0, totalPages: 0, hasMore: false });
  });

  it('filtra por active y available (incluido false) y combina filtros', async () => {
    const inactive = await listA('?active=false').expect(200);
    expect(inactive.body.items.map((p: Product) => p.name)).toEqual(['Burger Vieja']);

    const unavailable = await listA('?available=false').expect(200);
    expect(unavailable.body.items.map((p: Product) => p.name)).toEqual(['Burger Agotada']);

    const active = await listA('?active=true&limit=100').expect(200);
    expect(active.body.total).toBe(LIVE_TOTAL - 1);

    const combined = await listA(`?categoryId=${burgers.id}&search=agotada&available=false`).expect(200);
    expect(combined.body.total).toBe(1);
  });

  it('rechaza booleanos inválidos con 400 en lugar de ignorarlos', async () => {
    await listA('?active=yes').expect(400);
    await listA('?available=1').expect(400);
  });

  it('orden estable: sortOrder ascendente', async () => {
    const res = await listA(`?categoryId=${burgers.id}&limit=5`).expect(200);

    expect(res.body.items.map((p: Product) => p.name)).toEqual([
      'Burger 01',
      'Burger 02',
      'Burger 03',
      'Burger 04',
      'Burger 05',
    ]);
  });

  it('aislamiento multi-tenant: cada ADMIN solo ve su negocio, aunque pida businessId ajeno', async () => {
    const own = await listA('?limit=100').expect(200);
    expect(own.body.items.every((p: Product) => p.businessId === businessA.id)).toBe(true);

    const spoofed = await listA(`?businessId=${businessB.id}&limit=100`).expect(200);
    expect(spoofed.body.total).toBe(LIVE_TOTAL);
    expect(spoofed.body.items.every((p: Product) => p.businessId === businessA.id)).toBe(true);

    const other = await request(app.getHttpServer())
      .get('/products/admin?limit=100')
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(200);
    expect(other.body.total).toBe(2);
    expect(other.body.items.every((p: Product) => p.businessId === businessB.id)).toBe(true);
  });

  describe('GET /products/admin/summary', () => {
    it('devuelve los conteos reales del catálogo completo por categoría, excluyendo soft-deleted', async () => {
      const res = await summary(tokenA).expect(200);

      expect(res.body).toEqual({
        total: LIVE_TOTAL,
        byCategory: {
          [burgers.id]: BURGER_COUNT + 2,
          [drinks.id]: 3,
        },
      });
    });

    it('es independiente de la página del listado (siempre cuenta el conjunto completo filtrado)', async () => {
      const page = await listA(`?categoryId=${drinks.id}&page=1&limit=1`).expect(200);
      expect(page.body.items).toHaveLength(1);

      const res = await summary(tokenA).expect(200);
      expect(res.body.total).toBe(LIVE_TOTAL);
    });

    it('search se aplica y desglosa por TODAS las categorías (case-insensitive, parcial)', async () => {
      const burger = await summary(tokenA, '?search=BURGER').expect(200);
      expect(burger.body).toEqual({ total: BURGER_COUNT + 2, byCategory: { [burgers.id]: BURGER_COUNT + 2 } });
      // Una categoría sin coincidencias simplemente no aparece (el frontend la muestra como 0).
      expect(burger.body.byCategory).not.toHaveProperty(drinks.id);

      const lemon = await summary(tokenA, '?search=limon').expect(200);
      expect(lemon.body).toEqual({ total: 1, byCategory: { [drinks.id]: 1 } });
    });

    it('search trata % y _ literalmente también en el resumen', async () => {
      const percent = await summary(tokenA, `?search=${encodeURIComponent('%')}`).expect(200);
      expect(percent.body).toEqual({ total: 1, byCategory: { [drinks.id]: 1 } });

      const underscore = await summary(tokenA, `?search=${encodeURIComponent('_')}`).expect(200);
      expect(underscore.body).toEqual({ total: 1, byCategory: { [drinks.id]: 1 } });
    });

    it('active y available (incluido false) filtran el resumen', async () => {
      const inactive = await summary(tokenA, '?active=false').expect(200);
      expect(inactive.body).toEqual({ total: 1, byCategory: { [burgers.id]: 1 } });

      const unavailable = await summary(tokenA, '?available=false').expect(200);
      expect(unavailable.body).toEqual({ total: 1, byCategory: { [burgers.id]: 1 } });

      const active = await summary(tokenA, '?active=true').expect(200);
      expect(active.body.total).toBe(LIVE_TOTAL - 1);

      const combined = await summary(tokenA, '?search=burger&active=true&available=true').expect(200);
      expect(combined.body.total).toBe(BURGER_COUNT);
    });

    it('el resumen con filtros coincide con el total del listado con esos mismos filtros', async () => {
      const filters = '?search=burger&available=true';
      const list = await listA(`${filters}&limit=100`).expect(200);
      const sum = await summary(tokenA, filters).expect(200);

      expect(sum.body.total).toBe(list.body.total);
    });

    it('rechaza categoryId, paginación y booleanos inválidos con 400', async () => {
      await summary(tokenA, `?categoryId=${burgers.id}`).expect(400);
      await summary(tokenA, '?page=1').expect(400);
      await summary(tokenA, '?limit=20').expect(400);
      await summary(tokenA, '?active=yes').expect(400);
    });

    it('aislamiento multi-tenant: ignora un businessId ajeno y nunca mezcla negocios', async () => {
      const spoofed = await summary(tokenA, `?businessId=${businessB.id}`).expect(200);
      expect(spoofed.body.total).toBe(LIVE_TOTAL);

      const other = await summary(tokenB).expect(200);
      expect(other.body.total).toBe(2);
      expect(Object.keys(other.body.byCategory)).not.toContain(burgers.id);
    });

    it('un negocio sin productos devuelve un resumen vacío', async () => {
      const empty = await dataSource.getRepository(Business).save(
        dataSource.getRepository(Business).create({ name: 'Vacío', slug: 'vacio-products-e2e' }),
      );
      await dataSource.getRepository(User).save(
        dataSource.getRepository(User).create({
          email: 'admin-empty@products-e2e.test',
          passwordHash: await bcrypt.hash('Sup3rSecret!E', TEST_BCRYPT_COST),
          role: UserRole.ADMIN,
          businessId: empty.id,
        }),
      );
      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'admin-empty@products-e2e.test', password: 'Sup3rSecret!E' })
        .expect(200);

      const res = await summary(login.body.accessToken).expect(200);
      expect(res.body).toEqual({ total: 0, byCategory: {} });
    });
  });
});
