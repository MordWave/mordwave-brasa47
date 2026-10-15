import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { countRows, startIsolatedApp, type IsolatedApp } from './support/isolated-e2e-app.js';

// Guard/validation-layer only, no seeded data relied upon — same approach
// as auth.e2e-spec.ts and public-menu.e2e-spec.ts. Runs against an isolated,
// ephemeral local Postgres (PGlite), never an external database.
describe('Orders (e2e)', () => {
  let isolated: IsolatedApp;
  let app: INestApplication<App>;

  const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

  beforeAll(async () => {
    // These tests exercise DTO-level validation (@MaxLength, @Max, etc.),
    // which only runs through the global ValidationPipe main.ts installs in
    // production — startIsolatedApp({ validation: true }) installs the same one.
    isolated = await startIsolatedApp({ validation: true });
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

  it('GET /orders/admin without a token is rejected with 401', () => {
    return request(app.getHttpServer()).get('/orders/admin').expect(401);
  });

  it('GET /orders/admin/history without a token is rejected with 401', () => {
    return request(app.getHttpServer()).get('/orders/admin/history').expect(401);
  });

  it('PATCH /orders/:id/status without a token is rejected with 401', () => {
    return request(app.getHttpServer())
      .patch(`/orders/${UNKNOWN_UUID}/status`)
      .send({ status: 'DELIVERED' })
      .expect(401);
  });

  it('POST /orders with businessId/businessSlug/table/hostToken is rejected with 400 (fields no longer accepted)', () => {
    return request(app.getHttpServer())
      .post('/orders')
      .send({
        businessId: UNKNOWN_UUID,
        businessSlug: 'brasa-47',
        table: '7',
        hostToken: 'not-a-real-host-token',
        clientRequestId: '951eff0b-f8c6-48da-9d86-4af602164a48',
        items: [{ productId: UNKNOWN_UUID, quantity: 1 }],
      })
      .expect(400);
  });

  it('POST /orders without a sessionToken is rejected with 400', () => {
    return request(app.getHttpServer())
      .post('/orders')
      .send({
        clientRequestId: '951eff0b-f8c6-48da-9d86-4af602164a48',
        items: [{ productId: UNKNOWN_UUID, quantity: 1 }],
      })
      .expect(400);
  });

  it('POST /orders without a clientRequestId is rejected with 400', () => {
    return request(app.getHttpServer())
      .post('/orders')
      .send({
        sessionToken: 'not-a-real-session-token',
        items: [{ productId: UNKNOWN_UUID, quantity: 1 }],
      })
      .expect(400);
  });

  it('POST /orders with an empty items array is rejected with 400', () => {
    return request(app.getHttpServer())
      .post('/orders')
      .send({
        sessionToken: 'not-a-real-session-token',
        clientRequestId: '951eff0b-f8c6-48da-9d86-4af602164a48',
        items: [],
      })
      .expect(400);
  });

  it('POST /orders with a quantity over the per-item limit is rejected with 400', () => {
    return request(app.getHttpServer())
      .post('/orders')
      .send({
        sessionToken: 'not-a-real-session-token',
        clientRequestId: '951eff0b-f8c6-48da-9d86-4af602164a48',
        items: [{ productId: UNKNOWN_UUID, quantity: 51 }],
      })
      .expect(400);
  });

  it('POST /orders with an unknown sessionToken is rejected with 404 TABLE_SESSION_UNAVAILABLE', async () => {
    const res = await request(app.getHttpServer())
      .post('/orders')
      .send({
        sessionToken: 'not-a-real-session-token',
        clientRequestId: '951eff0b-f8c6-48da-9d86-4af602164a48',
        items: [{ productId: UNKNOWN_UUID, quantity: 1 }],
      })
      .expect(404);
    expect(res.body.errorCode).toBe('TABLE_SESSION_UNAVAILABLE');
  });
});
