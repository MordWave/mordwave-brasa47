import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { countRows, startIsolatedApp, type IsolatedApp } from './support/isolated-e2e-app.js';

// Boots the real AppModule against an isolated, ephemeral local Postgres (PGlite): never an external database.
describe('AppController (e2e)', () => {
  let isolated: IsolatedApp;
  let app: INestApplication<App>;

  beforeAll(async () => {
    isolated = await startIsolatedApp();
    app = isolated.app;
  }, 60_000);

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  afterAll(async () => {
    try {
      // No test in this file writes anything, so the isolated database must still be exactly as migrated.
      if (isolated) expect(Object.values(await countRows(isolated.dataSource)).every((n) => n === 0)).toBe(true);
    } finally {
      await isolated?.stop();
    }
  });
});
