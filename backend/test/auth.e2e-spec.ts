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

  it('GET /products/admin without a token is rejected with 401', () => {
    return request(app.getHttpServer()).get('/products/admin').expect(401);
  });

  it('GET /categories/admin without a token is rejected with 401', () => {
    return request(app.getHttpServer()).get('/categories/admin').expect(401);
  });

  it('PATCH /categories/:id without a token is rejected with 401', () => {
    return request(app.getHttpServer())
      .patch('/categories/00000000-0000-0000-0000-000000000000')
      .send({ active: false })
      .expect(401);
  });

  it('DELETE /products/:id without a token is rejected with 401', () => {
    return request(app.getHttpServer())
      .delete('/products/00000000-0000-0000-0000-000000000000')
      .expect(401);
  });

  it('DELETE /categories/:id without a token is rejected with 401', () => {
    return request(app.getHttpServer())
      .delete('/categories/00000000-0000-0000-0000-000000000000')
      .expect(401);
  });

  it('POST /products/:id/image without a token is rejected with 401', () => {
    return request(app.getHttpServer())
      .post('/products/00000000-0000-0000-0000-000000000000/image')
      .expect(401);
  });

  it('DELETE /products/:id/image without a token is rejected with 401', () => {
    return request(app.getHttpServer())
      .delete('/products/00000000-0000-0000-0000-000000000000/image')
      .expect(401);
  });

  it('POST /tables without a token is rejected with 401', () => {
    return request(app.getHttpServer())
      .post('/tables')
      .send({ name: 'Mesa 1', businessId: 'x' })
      .expect(401);
  });

  it('GET /tables/admin without a token is rejected with 401', () => {
    return request(app.getHttpServer()).get('/tables/admin').expect(401);
  });

  it('PATCH /tables/:id without a token is rejected with 401', () => {
    return request(app.getHttpServer())
      .patch('/tables/00000000-0000-0000-0000-000000000000')
      .send({ name: 'x' })
      .expect(401);
  });

  it('POST /tables/:id/sessions without a token is rejected with 401', () => {
    return request(app.getHttpServer())
      .post('/tables/00000000-0000-0000-0000-000000000000/sessions')
      .expect(401);
  });

  it('PATCH /tables/:id/sessions/current without a token is rejected with 401', () => {
    return request(app.getHttpServer())
      .patch('/tables/00000000-0000-0000-0000-000000000000/sessions/current')
      .expect(401);
  });

  it('GET /tables/:id/qr without a token is rejected with 401', () => {
    return request(app.getHttpServer())
      .get('/tables/00000000-0000-0000-0000-000000000000/qr')
      .expect(401);
  });

  it('POST /tables/:id/qr/rotate without a token is rejected with 401', () => {
    return request(app.getHttpServer())
      .post('/tables/00000000-0000-0000-0000-000000000000/qr/rotate')
      .expect(401);
  });

  it('DELETE /tables/:id without a token is rejected with 401', () => {
    return request(app.getHttpServer())
      .delete('/tables/00000000-0000-0000-0000-000000000000')
      .expect(401);
  });
});
