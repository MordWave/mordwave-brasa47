import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module.js';

// Guard/validation-layer only, no seeded data relied upon — same approach
// as orders.e2e-spec.ts. A qrToken that can't possibly exist is enough to
// prove the "unavailable" path without depending on real fixtures.
describe('Public table sessions (e2e)', () => {
  let app: INestApplication<App>;

  const UNKNOWN_QR_TOKEN = 'not-a-real-qr-token';

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // These tests exercise DTO-level validation (@MaxLength) — only
    // enforced through the global ValidationPipe main.ts installs in
    // production, not enabled by default on a bare test app.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
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
