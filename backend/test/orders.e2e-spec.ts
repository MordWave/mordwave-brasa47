import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module.js';

// Guard/validation-layer only, no seeded data relied upon — same approach
// as auth.e2e-spec.ts and public-menu.e2e-spec.ts.
describe('Orders (e2e)', () => {
  let app: INestApplication<App>;

  const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // These tests exercise DTO-level validation (@MaxLength, @Max, etc.),
    // which only runs through the global ValidationPipe main.ts installs in
    // production — not enabled by default on a bare test app.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /orders/admin without a token is rejected with 401', () => {
    return request(app.getHttpServer()).get('/orders/admin').expect(401);
  });

  it('PATCH /orders/:id/status without a token is rejected with 401', () => {
    return request(app.getHttpServer())
      .patch(`/orders/${UNKNOWN_UUID}/status`)
      .send({ status: 'DELIVERED' })
      .expect(401);
  });

  it('POST /orders with neither businessId nor businessSlug is rejected with 400', () => {
    return request(app.getHttpServer())
      .post('/orders')
      .send({
        clientRequestId: '951eff0b-f8c6-48da-9d86-4af602164a48',
        table: '7',
        items: [{ productId: UNKNOWN_UUID, quantity: 1 }],
      })
      .expect(400);
  });

  it('POST /orders without a clientRequestId is rejected with 400', () => {
    return request(app.getHttpServer())
      .post('/orders')
      .send({
        businessSlug: 'brasa-47',
        table: '7',
        items: [{ productId: UNKNOWN_UUID, quantity: 1 }],
      })
      .expect(400);
  });

  it('POST /orders with an empty items array is rejected with 400', () => {
    return request(app.getHttpServer())
      .post('/orders')
      .send({
        businessSlug: 'brasa-47',
        clientRequestId: '951eff0b-f8c6-48da-9d86-4af602164a48',
        table: '7',
        items: [],
      })
      .expect(400);
  });

  it('POST /orders with a table over the length limit is rejected with 400', () => {
    return request(app.getHttpServer())
      .post('/orders')
      .send({
        businessSlug: 'brasa-47',
        clientRequestId: '951eff0b-f8c6-48da-9d86-4af602164a48',
        table: 'a'.repeat(21),
        items: [{ productId: UNKNOWN_UUID, quantity: 1 }],
      })
      .expect(400);
  });

  it('POST /orders with a quantity over the per-item limit is rejected with 400', () => {
    return request(app.getHttpServer())
      .post('/orders')
      .send({
        businessSlug: 'brasa-47',
        clientRequestId: '951eff0b-f8c6-48da-9d86-4af602164a48',
        table: '7',
        items: [{ productId: UNKNOWN_UUID, quantity: 51 }],
      })
      .expect(400);
  });

  it('POST /orders with an unknown businessSlug is rejected with 404 BUSINESS_NOT_FOUND', async () => {
    const res = await request(app.getHttpServer())
      .post('/orders')
      .send({
        businessSlug: 'not-a-real-business-slug',
        clientRequestId: '951eff0b-f8c6-48da-9d86-4af602164a48',
        table: '7',
        items: [{ productId: UNKNOWN_UUID, quantity: 1 }],
      })
      .expect(404);
    expect(res.body.errorCode).toBe('BUSINESS_NOT_FOUND');
  });
});
