import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module.js';

// These only ever hit the guard layer (no valid token is ever sent), so no
// data is read or written against the connected database.
describe('Auth guards (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('POST /products without a token is rejected with 401', () => {
    return request(app.getHttpServer())
      .post('/products')
      .send({ name: 'x', price: 100, businessId: 'x', categoryId: 'x' })
      .expect(401);
  });

  it('PATCH /products/:id without a token is rejected with 401', () => {
    return request(app.getHttpServer())
      .patch('/products/00000000-0000-0000-0000-000000000000')
      .send({ name: 'x' })
      .expect(401);
  });

  it('POST /categories without a token is rejected with 401', () => {
    return request(app.getHttpServer())
      .post('/categories')
      .send({ name: 'x', slug: 'x', businessId: 'x' })
      .expect(401);
  });
});
