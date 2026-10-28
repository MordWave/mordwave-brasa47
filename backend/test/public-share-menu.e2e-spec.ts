import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { Business } from '../src/business/business.entity.js';
import { Category } from '../src/category/category.entity.js';
import { businessCoverKey, businessLogoKey, productImageKey } from '../src/media/media-key.util.js';
import { Product } from '../src/product/product.entity.js';
import { ImageStorageService } from '../src/storage/image-storage.service.js';
import { runAllMigrations } from './support/run-all-migrations.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

const BASE = 'https://api.example.test';
const OBJ = 'dddddddd-4444-4abc-8def-444444444abc';

// The shareable, read-only menu (GET /public/menu/:slug) against a real local PostgreSQL with TWO fictitious restaurants plus an
// inactive one: what the visitor sees is exactly the public data of the restaurant named by the slug, with the same visibility
// rules as the existing public reads, and nothing of another restaurant can be reached by manipulating the request.
describe('Public shareable menu (e2e, real local Postgres)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  let dataSource: DataSource;
  let alpha: Business;
  let beta: Business;
  let alphaProductImageKey: string;

  const get = (path: string) => request(app.getHttpServer()).get(path);

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
    process.env.MEDIA_PUBLIC_BASE_URL = BASE;

    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ImageStorageService)
      .useValue({ upload: async (key: string) => key })
      .compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = moduleFixture.get(DataSource);
    await runAllMigrations(dataSource);

    const businessRepo = dataSource.getRepository(Business);
    const categoryRepo = dataSource.getRepository(Category);
    const productRepo = dataSource.getRepository(Product);

    alpha = await businessRepo.save(
      businessRepo.create({ name: 'Alpha Burgers', slug: 'alpha-burgers', primaryColor: '#AA3300', accentColor: '#112233' }),
    );
    await businessRepo.update(alpha.id, {
      logoStorageKey: businessLogoKey(alpha.id, OBJ),
      coverStorageKey: businessCoverKey(alpha.id, OBJ),
    });
    beta = await businessRepo.save(businessRepo.create({ name: 'Beta Pizza', slug: 'beta-pizza' }));
    await businessRepo.save(businessRepo.create({ name: 'Gamma Cerrado', slug: 'gamma-cerrado', active: false }));

    // Alpha: 2 visible categories (given out of order), 1 inactive; products: visible, unavailable-but-visible, inactive,
    // soft-deleted, and one inside the inactive category.
    const aBurgers = await categoryRepo.save(categoryRepo.create({ name: 'Burgers', slug: 'burgers', businessId: alpha.id, sortOrder: 2 }));
    const aDrinks = await categoryRepo.save(categoryRepo.create({ name: 'Bebidas', slug: 'bebidas', businessId: alpha.id, sortOrder: 1 }));
    const aHidden = await categoryRepo.save(categoryRepo.create({ name: 'Oculta', slug: 'oculta', businessId: alpha.id, active: false, sortOrder: 3 }));
    const visible = await productRepo.save(
      productRepo.create({ businessId: alpha.id, categoryId: aBurgers.id, name: 'Clásica', description: 'Con queso', price: 6900, sortOrder: 1, tag: 'Más pedido' }),
    );
    alphaProductImageKey = productImageKey(alpha.id, visible.id, OBJ);
    await productRepo.update(visible.id, { imageStorageKey: alphaProductImageKey });
    await productRepo.save(productRepo.create({ businessId: alpha.id, categoryId: aBurgers.id, name: 'Agotada', price: 7500, sortOrder: 2, available: false }));
    await productRepo.save(productRepo.create({ businessId: alpha.id, categoryId: aBurgers.id, name: 'Desactivada', price: 100, sortOrder: 3, active: false }));
    const gone = await productRepo.save(productRepo.create({ businessId: alpha.id, categoryId: aBurgers.id, name: 'Eliminada', price: 200, sortOrder: 4 }));
    await productRepo.softDelete(gone.id);
    await productRepo.save(productRepo.create({ businessId: alpha.id, categoryId: aHidden.id, name: 'En categoria oculta', price: 300, sortOrder: 1 }));
    await productRepo.save(productRepo.create({ businessId: alpha.id, categoryId: aDrinks.id, name: 'Limonada', price: 2500, sortOrder: 1 }));

    // Beta: its own menu, with a product named like one of Alpha's to prove nothing is matched by name.
    const bPizzas = await categoryRepo.save(categoryRepo.create({ name: 'Pizzas', slug: 'pizzas', businessId: beta.id, sortOrder: 1 }));
    await productRepo.save(productRepo.create({ businessId: beta.id, categoryId: bPizzas.id, name: 'Margarita', price: 9900, sortOrder: 1 }));
    await productRepo.save(productRepo.create({ businessId: beta.id, categoryId: bPizzas.id, name: 'Clásica', price: 1, sortOrder: 2 }));
  });

  afterAll(async () => {
    delete process.env.MEDIA_PUBLIC_BASE_URL;
    await app?.close();
    await testDb?.stop();
  });

  it('serves the public menu of a restaurant by its slug, with no authentication, token or session', async () => {
    const res = await get('/public/menu/alpha-burgers').expect(200);
    expect(res.body.business).toEqual({
      name: 'Alpha Burgers',
      slug: 'alpha-burgers',
      logoUrl: `${BASE}/media/${businessLogoKey(alpha.id, OBJ)}`,
      coverUrl: `${BASE}/media/${businessCoverKey(alpha.id, OBJ)}`,
      primaryColor: '#AA3300',
      accentColor: '#112233',
    });
    expect(res.body.categories.map((c: { name: string }) => c.name)).toEqual(['Bebidas', 'Burgers']); // inactive one excluded, ordered
    expect(res.body.products.map((p: { name: string }) => p.name).sort()).toEqual(['Agotada', 'Clásica', 'Limonada']);
    const classic = res.body.products.find((p: { name: string }) => p.name === 'Clásica');
    expect(classic).toEqual({
      id: expect.any(String),
      categoryId: expect.any(String),
      name: 'Clásica',
      description: 'Con queso',
      price: 6900,
      imageUrl: `${BASE}/media/${alphaProductImageKey}`,
      tag: 'Más pedido',
      available: true,
      sortOrder: 1,
    });
    // A product that is not available today is still listed (the same as the table menu) and says so.
    expect(res.body.products.find((p: { name: string }) => p.name === 'Agotada').available).toBe(false);
  });

  it('respects the existing visibility rules: inactive, soft-deleted and products of inactive categories are not shown', async () => {
    const res = await get('/public/menu/alpha-burgers').expect(200);
    const names = res.body.products.map((p: { name: string }) => p.name);
    for (const hidden of ['Desactivada', 'Eliminada', 'En categoria oculta']) expect(names).not.toContain(hidden);
    expect(res.body.categories.map((c: { name: string }) => c.name)).not.toContain('Oculta');
  });

  it('isolates restaurants: the menu of A never shows products or categories of B, and vice versa', async () => {
    const a = (await get('/public/menu/alpha-burgers').expect(200)).body;
    const b = (await get('/public/menu/beta-pizza').expect(200)).body;
    expect(b.business.name).toBe('Beta Pizza');
    expect(b.categories.map((c: { name: string }) => c.name)).toEqual(['Pizzas']);
    expect(b.products.map((p: { name: string }) => p.name).sort()).toEqual(['Clásica', 'Margarita']);
    expect(JSON.stringify(a)).not.toMatch(/Margarita|Pizzas|Beta Pizza|beta-pizza/);
    expect(JSON.stringify(b)).not.toMatch(/Limonada|Bebidas|Burgers|Alpha/);
    // Same product name in both restaurants, different prices: each menu keeps its own.
    expect(a.products.find((p: { name: string }) => p.name === 'Clásica').price).toBe(6900);
    expect(b.products.find((p: { name: string }) => p.name === 'Clásica').price).toBe(1);
    const aIds = new Set([...a.categories, ...a.products].map((x: { id: string }) => x.id));
    expect([...b.categories, ...b.products].some((x: { id: string }) => aIds.has(x.id))).toBe(false);
  });

  it('a manipulated request cannot reach another restaurant: query parameters and odd slugs are ignored or answered 404', async () => {
    // Extra parameters (a business id, another slug, a category of B) change nothing: the slug in the path decides.
    const res = await get(`/public/menu/alpha-burgers?businessId=${beta.id}&businessSlug=beta-pizza&categoryId=${beta.id}`).expect(200);
    expect(res.body.business.slug).toBe('alpha-burgers');
    expect(JSON.stringify(res.body)).not.toMatch(/Margarita|Pizzas/);
    for (const slug of ['ALPHA-BURGERS', 'alpha-burgers%20', 'alpha-burger', 'alpha_burgers', '%2e%2e%2fbeta-pizza', "alpha-burgers'%20OR%20'1'='1", 'a', 'x'.repeat(61), beta.id]) {
      const r = await get(`/public/menu/${slug}`);
      expect(r.status, slug).toBe(404);
      expect(r.body.errorCode).toBe('BUSINESS_NOT_FOUND');
      expect(JSON.stringify(r.body)).not.toMatch(/Alpha|Beta|Margarita|Limonada/);
    }
  });

  it('an unknown or inactive restaurant is the same 404 and reveals nothing', async () => {
    const unknown = await get('/public/menu/no-such-restaurant').expect(404);
    const inactive = await get('/public/menu/gamma-cerrado').expect(404);
    expect(inactive.body).toEqual(unknown.body);
    expect(unknown.body).toEqual({ message: 'Business not found', errorCode: 'BUSINESS_NOT_FOUND' }); // same shape as the existing public reads
  });

  it('returns only the public minimum: no ids of the business, storage keys, users, timestamps or ordering internals', async () => {
    const res = await get('/public/menu/alpha-burgers').expect(200);
    const text = JSON.stringify(res.body);
    expect(Object.keys(res.body).sort()).toEqual(['business', 'categories', 'products']);
    expect(Object.keys(res.body.business).sort()).toEqual(['accentColor', 'coverUrl', 'logoUrl', 'name', 'primaryColor', 'slug']);
    expect(Object.keys(res.body.categories[0]).sort()).toEqual(['id', 'name', 'slug', 'sortOrder']);
    expect(Object.keys(res.body.products[0]).sort()).toEqual(['available', 'categoryId', 'description', 'id', 'imageUrl', 'name', 'price', 'sortOrder', 'tag']);
    expect(text).not.toMatch(/storage_?key|businessId|business_id|createdAt|updatedAt|deletedAt|password|email|qrToken|"active"|ingredients|addOns/i);
    // The id of the business only appears inside the opaque /media URLs of its own images (they are built from the key), never as a field.
    expect(text.replace(new RegExp(`${BASE}/media/businesses/[a-z0-9/-]+\\.webp`, 'g'), '')).not.toContain(alpha.id);
    expect(text).not.toContain(beta.id);
  });

  it('the existing public endpoints keep answering exactly as before (they stay compatible)', async () => {
    const cats = await get('/categories?businessSlug=alpha-burgers').expect(200);
    const prods = await get('/products?businessSlug=alpha-burgers').expect(200);
    expect(cats.body.map((c: { name: string }) => c.name)).toEqual(['Bebidas', 'Burgers']);
    expect(prods.body.map((p: { name: string }) => p.name).sort()).toEqual(['Agotada', 'Clásica', 'Limonada']);
    await get('/products').expect(400); // still needs a business identifier
  });

  it('administrative endpoints keep their authentication: the shareable menu opens nothing else', async () => {
    for (const path of ['/products/admin', '/categories/admin', '/businesses/me', '/orders/admin', '/tables/admin']) {
      await get(path).expect(401);
    }
    await get('/public/menu').expect(404); // no restaurant, no menu
  });
});
