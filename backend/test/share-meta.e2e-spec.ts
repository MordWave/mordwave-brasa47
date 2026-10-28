import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { Business } from '../src/business/business.entity.js';
import { Category } from '../src/category/category.entity.js';
import { businessCoverKey, productImageKey } from '../src/media/media-key.util.js';
import { Product } from '../src/product/product.entity.js';
import { ImageStorageService } from '../src/storage/image-storage.service.js';
import { runAllMigrations } from './support/run-all-migrations.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

const BASE = 'https://api.example.test';
const WEB = 'https://web.example.test';
const OBJ = 'dddddddd-4444-4abc-8def-444444444abc';

// GET /public/share-meta: the <head> fragment link previews read from /menu/<slug>, against a real local PostgreSQL with TWO
// fictitious restaurants (one with a cover and a hostile name, one with neither logo nor cover) plus an inactive one.
describe('Share-preview meta tags (e2e, real local Postgres)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  let alpha: Business;

  const meta = (slug?: string, origin: string | undefined = WEB) =>
    request(app.getHttpServer()).get('/public/share-meta').query({ ...(slug !== undefined && { slug }), ...(origin !== undefined && { origin }) });

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
    process.env.FRONTEND_URL = `${WEB},http://localhost:5173`;

    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ImageStorageService)
      .useValue({ upload: async (key: string) => key })
      .compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    const dataSource = moduleFixture.get(DataSource);
    await runAllMigrations(dataSource);

    const businessRepo = dataSource.getRepository(Business);
    alpha = await businessRepo.save(businessRepo.create({ name: `Alpha "Burgers" <b>&</b>`, slug: 'alpha-burgers' }));
    await businessRepo.update(alpha.id, { coverStorageKey: businessCoverKey(alpha.id, OBJ) });
    await businessRepo.save(businessRepo.create({ name: 'Beta Pizza', slug: 'beta-pizza' }));
    await businessRepo.save(businessRepo.create({ name: 'Gamma Cerrado', slug: 'gamma-cerrado', active: false }));

    // A product with a photo: it must never become the preview image.
    const categoryRepo = dataSource.getRepository(Category);
    const productRepo = dataSource.getRepository(Product);
    const beta = await businessRepo.findOneByOrFail({ slug: 'beta-pizza' });
    const cat = await categoryRepo.save(categoryRepo.create({ name: 'Pizzas', slug: 'pizzas', businessId: beta.id, sortOrder: 1 }));
    const product = await productRepo.save(productRepo.create({ businessId: beta.id, categoryId: cat.id, name: 'Margarita', price: 9900, sortOrder: 1 }));
    await productRepo.update(product.id, { imageStorageKey: productImageKey(beta.id, product.id, OBJ) });
  });

  afterAll(async () => {
    for (const name of ['MEDIA_PUBLIC_BASE_URL', 'FRONTEND_URL']) delete process.env[name];
    await app?.close();
    await testDb?.stop();
  });

  it('answers with an HTML fragment for the restaurant, with no authentication, token or session', async () => {
    const res = await meta('beta-pizza').expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/html; charset=utf-8/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain('<title>Beta Pizza — Menú</title>');
    expect(res.text).toContain('<meta name="description" content="Explora la carta digital de Beta Pizza" />');
    expect(res.text).toContain(`<meta property="og:url" content="${WEB}/menu/beta-pizza" />`);
    expect(res.text).toContain(`<link rel="canonical" href="${WEB}/menu/beta-pizza" />`);
  });

  it('two restaurants give different tags and nothing of one shows in the other', async () => {
    const a = (await meta('alpha-burgers').expect(200)).text;
    const b = (await meta('beta-pizza').expect(200)).text;
    expect(a).not.toBe(b);
    expect(a).not.toMatch(/Beta|beta-pizza/);
    expect(b).not.toMatch(/Alpha|alpha-burgers/);
  });

  it('without a logo or cover there is no image tag, and a product photo is never used as the preview image', async () => {
    const text = (await meta('beta-pizza').expect(200)).text;
    expect(text).not.toMatch(/og:image|twitter:image|\/media\//);
    expect(text).toContain('<meta name="twitter:card" content="summary" />');
  });

  it('uses the cover of the restaurant as the preview image when it has one', async () => {
    const text = (await meta('alpha-burgers').expect(200)).text;
    expect(text).toContain(`<meta property="og:image" content="${BASE}/media/${businessCoverKey(alpha.id, OBJ)}" />`);
    expect(text).toContain('<meta name="twitter:card" content="summary_large_image" />');
  });

  it('escapes a hostile restaurant name: it cannot inject markup', async () => {
    const text = (await meta('alpha-burgers').expect(200)).text;
    expect(text).not.toMatch(/<b>|<\/b>/);
    expect(text).toContain('<title>Alpha &quot;Burgers&quot; &lt;b&gt;&amp;&lt;/b&gt; — Menú</title>');
    for (const line of text.split('\n')) expect(line).toMatch(/^<(title>[^<>]*<\/title>|(meta|link)( [a-z:]+="[^"<>]*")+ \/>)$/);
  });

  it('unknown, inactive and malformed slugs all give the same empty 200: nothing about a non-public restaurant is revealed', async () => {
    const hostile = ["demo' OR '1'='1", '../beta-pizza', 'Beta-Pizza', 'a', 'x'.repeat(61)];
    for (const slug of ['no-existe', 'gamma-cerrado', ...hostile]) {
      const res = await meta(slug).expect(200);
      expect(res.text, slug).toBe('');
    }
    expect((await meta(undefined).expect(200)).text).toBe('');
    expect((await request(app.getHttpServer()).get('/public/share-meta?slug=beta-pizza&slug=alpha-burgers').expect(200)).text).toBe('');
  });

  it('never trusts the Host header or an origin that is not an allowed frontend origin: no URL tags, no echo', async () => {
    const spoof = await request(app.getHttpServer()).get('/public/share-meta').set('Host', 'evil.example.test').set('X-Forwarded-Host', 'evil.example.test').query({ slug: 'beta-pizza' }).expect(200);
    expect(spoof.text).not.toMatch(/evil|canonical|og:url/);
    for (const origin of ['https://evil.example.test', 'javascript:alert(1)', `${WEB}.evil.test`, `${WEB}/path`, '']) {
      const res = await meta('beta-pizza', origin).expect(200);
      expect(res.text, origin).toContain('og:title');
      expect(res.text, origin).not.toMatch(/evil|canonical|og:url|javascript/);
    }
    // an allowed origin is accepted whatever its spelling
    expect((await meta('beta-pizza', `${WEB}/`).expect(200)).text).toContain(`${WEB}/menu/beta-pizza`);
    expect((await meta('beta-pizza', 'http://localhost:5173').expect(200)).text).toContain('http://localhost:5173/menu/beta-pizza');
  });

  it('does not expose ids, the menu or anything but name, slug and logo/cover', async () => {
    const res = await meta('alpha-burgers').expect(200);
    expect(res.text.replace(new RegExp(`${BASE}/media/businesses/[a-z0-9/-]+\\.webp`, 'g'), '')).not.toContain(alpha.id);
    expect(res.text).not.toMatch(/price|Margarita|categor/i);
  });

  it('leaves the existing public menu endpoint exactly as it was', async () => {
    const res = await request(app.getHttpServer()).get('/public/menu/beta-pizza').expect(200);
    expect(Object.keys(res.body).sort()).toEqual(['business', 'categories', 'products']);
    await request(app.getHttpServer()).get('/public/menu/no-existe').expect(404);
  });
});
