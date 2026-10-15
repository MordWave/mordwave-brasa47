import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { countRows, startIsolatedApp, type IsolatedApp } from './support/isolated-e2e-app.js';

// Public (unauthenticated) menu reads must always be scoped to exactly one
// business. These only exercise the validation/resolution layer with
// identifiers that can't legitimately match anything real — no fixture data
// is seeded or relied upon, matching auth.e2e-spec.ts's approach. Runs against
// an isolated, ephemeral local Postgres (PGlite), never an external database:
// the "unknown business" cases are answered by a real (empty) businesses table.
describe('Public menu tenant scoping (e2e)', () => {
  let isolated: IsolatedApp;
  let app: INestApplication<App>;

  const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';
  const UNKNOWN_SLUG = 'not-a-real-business-slug';

  beforeAll(async () => {
    isolated = await startIsolatedApp();
    app = isolated.app;
  }, 60_000);

  afterAll(async () => {
    try {
      // No test in this file writes anything, so the isolated database must still be exactly as migrated.
      if (isolated) expect(Object.values(await countRows(isolated.dataSource)).every((n) => n === 0)).toBe(true);
    } finally {
      await isolated?.stop();
    }
  });

  it('GET /products with neither businessId nor businessSlug is rejected with 400', () => {
    return request(app.getHttpServer()).get('/products').expect(400);
  });

  it('GET /products with both businessId and businessSlug is rejected with 400', () => {
    return request(app.getHttpServer())
      .get('/products')
      .query({ businessId: UNKNOWN_UUID, businessSlug: UNKNOWN_SLUG })
      .expect(400);
  });

  it('GET /products with an unknown businessSlug is rejected with 404 BUSINESS_NOT_FOUND', async () => {
    const res = await request(app.getHttpServer())
      .get('/products')
      .query({ businessSlug: UNKNOWN_SLUG })
      .expect(404);
    expect(res.body.errorCode).toBe('BUSINESS_NOT_FOUND');
  });

  it('GET /products with an unknown businessId is rejected with 404 BUSINESS_NOT_FOUND', async () => {
    const res = await request(app.getHttpServer())
      .get('/products')
      .query({ businessId: UNKNOWN_UUID })
      .expect(404);
    expect(res.body.errorCode).toBe('BUSINESS_NOT_FOUND');
  });

  it('GET /products/:id with no business identifier is rejected with 400', () => {
    return request(app.getHttpServer()).get(`/products/${UNKNOWN_UUID}`).expect(400);
  });

  it('GET /categories with neither businessId nor businessSlug is rejected with 400', () => {
    return request(app.getHttpServer()).get('/categories').expect(400);
  });

  it('GET /categories with both businessId and businessSlug is rejected with 400', () => {
    return request(app.getHttpServer())
      .get('/categories')
      .query({ businessId: UNKNOWN_UUID, businessSlug: UNKNOWN_SLUG })
      .expect(400);
  });

  it('GET /categories with an unknown businessSlug is rejected with 404 BUSINESS_NOT_FOUND', async () => {
    const res = await request(app.getHttpServer())
      .get('/categories')
      .query({ businessSlug: UNKNOWN_SLUG })
      .expect(404);
    expect(res.body.errorCode).toBe('BUSINESS_NOT_FOUND');
  });

  it('GET /categories with an unknown businessId is rejected with 404 BUSINESS_NOT_FOUND', async () => {
    const res = await request(app.getHttpServer())
      .get('/categories')
      .query({ businessId: UNKNOWN_UUID })
      .expect(404);
    expect(res.body.errorCode).toBe('BUSINESS_NOT_FOUND');
  });
});
