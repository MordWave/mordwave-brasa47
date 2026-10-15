import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { countRows, startIsolatedApp, type IsolatedApp } from './support/isolated-e2e-app.js';

// Guard/validation-layer only, no seeded data relied upon — same approach
// as orders.e2e-spec.ts. A qrToken that can't possibly exist is enough to
// prove the "unavailable" path without depending on real fixtures. Runs
// against an isolated, ephemeral local Postgres (PGlite), never an external
// database.
describe('Public table sessions (e2e)', () => {
  let isolated: IsolatedApp;
  let app: INestApplication<App>;

  const UNKNOWN_QR_TOKEN = 'not-a-real-qr-token';

  beforeAll(async () => {
    // These tests exercise DTO-level validation (@MaxLength) — only
    // enforced through the global ValidationPipe main.ts installs in
    // production; startIsolatedApp({ validation: true }) installs the same one.
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

  it('POST /table-sessions/join with an unknown qrToken is rejected with 404 TABLE_SESSION_UNAVAILABLE', async () => {
    const res = await request(app.getHttpServer())
      .post('/table-sessions/join')
      .send({ qrToken: UNKNOWN_QR_TOKEN })
      .expect(404);
    expect(res.body.errorCode).toBe('TABLE_SESSION_UNAVAILABLE');
  });

  it('POST /table-sessions/status with an unknown sessionToken reports open:false (never errors)', async () => {
    const res = await request(app.getHttpServer())
      .post('/table-sessions/status')
      .send({ sessionToken: 'stale-or-fake-token' })
      .expect(200);
    expect(res.body).toEqual({ open: false });
  });

  it('POST /table-sessions/status without a sessionToken is rejected with 400', () => {
    return request(app.getHttpServer()).post('/table-sessions/status').send({}).expect(400);
  });
});
