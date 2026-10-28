import type { AddressInfo } from 'node:net';
import { brotliCompressSync, deflateSync, gzipSync, zstdCompressSync } from 'node:zlib';
import {
  Body,
  Controller,
  Get,
  Inject,
  Logger,
  Module,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { FileInterceptor } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { memoryStorage } from 'multer';
import request from 'supertest';
import { DataSource, QueryFailedError } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureHttpApp } from '../src/app.setup.js';
import { HttpProtectionModule } from '../src/common/http/http-protection.module.js';
import { UploadTimeout } from '../src/common/http/request-timeout.decorator.js';
import { REQUEST_TIMEOUTS } from '../src/common/http/request-timeout.interceptor.js';
import {
  DEFAULT_RATE_LIMITS,
  RATE_LIMIT_CONFIG,
  type RateLimitConfig,
} from '../src/rate-limit/rate-limit.config.js';
import { RateLimit } from '../src/rate-limit/rate-limit.decorator.js';
import { RateLimitModule } from '../src/rate-limit/rate-limit.module.js';
import { runAllMigrations } from './support/run-all-migrations.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const blob = (bytes: number) => 'x'.repeat(bytes);
const urlOf = (app: INestApplication) =>
  `http://127.0.0.1:${((app.getHttpServer() as { address(): AddressInfo }).address() as AddressInfo).port}`;

const PAYLOAD_TOO_LARGE = {
  statusCode: 413,
  errorCode: 'PAYLOAD_TOO_LARGE',
  message: 'Payload too large',
};

const UNSUPPORTED_CONTENT_ENCODING = {
  statusCode: 415,
  errorCode: 'UNSUPPORTED_CONTENT_ENCODING',
  message: 'Content encoding not supported',
};

// ---------------------------------------------------------------------------
// Part A — a minimal app (no database) wiring exactly the production
// building blocks: configureHttpApp (200kb JSON), HttpProtectionModule
// (deadline + error filter) and RateLimitModule, with test-only routes that
// are slow / fail the way the database driver fails. Deadlines are shortened
// through the REQUEST_TIMEOUTS provider so the suite doesn't wait 30s.
// ---------------------------------------------------------------------------
@Controller('t')
class ProbeController {
  @Get('fast')
  fast() {
    return { ok: true };
  }

  @Get('slow')
  async slow() {
    await sleep(400);
    return { ok: true };
  }

  @Post('json')
  json(@Body() body: Record<string, unknown>) {
    return { keys: Object.keys(body).length, size: JSON.stringify(body).length };
  }

  // Reads an application/x-www-form-urlencoded body (the other parser that Nest registers).
  @Post('form')
  form(@Body() body: Record<string, unknown>) {
    return { keys: Object.keys(body).length, body };
  }

  // Same Multer setup as the real image routes.
  @Post('upload')
  @UploadTimeout()
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  upload(@UploadedFile() file: Express.Multer.File) {
    return { received: file?.size ?? 0 };
  }

  @Post('upload-slow')
  @UploadTimeout()
  async uploadSlow() {
    await sleep(400); // longer than the default deadline, shorter than the upload one
    return { ok: true };
  }

  @Post('upload-hung')
  @UploadTimeout()
  async uploadHung() {
    await sleep(1_200); // longer than the upload deadline too
    return { ok: true };
  }

  @Get('menu')
  @RateLimit('publicMenu')
  menu() {
    return { ok: true };
  }

  @Get('db-statement-timeout')
  dbStatementTimeout() {
    const driverError = Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
    });
    throw new QueryFailedError('SELECT secret_column FROM secret_table WHERE k = $1', ['s3cr3t'], driverError);
  }

  @Get('db-pool-exhausted')
  dbPoolExhausted() {
    throw new Error('timeout exceeded when trying to connect');
  }

  @Get('db-refused')
  dbRefused() {
    throw Object.assign(new Error('connect ECONNREFUSED db.internal.example:5432'), {
      code: 'ECONNREFUSED',
    });
  }

  @Get('plain-error')
  plainError() {
    throw new Error('something unrelated');
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

describe('HTTP protection — minimal app (e2e, no database)', () => {
  let app: NestExpressApplication;
  let base: string;

  const limits: RateLimitConfig = {
    ...DEFAULT_RATE_LIMITS,
    policies: { ...DEFAULT_RATE_LIMITS.policies, publicMenu: { ip: { limit: 2, ttlMs: 60_000 } } },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [HttpProtectionModule, RateLimitModule, ProbeModule],
    })
      .overrideProvider(REQUEST_TIMEOUTS)
      .useValue({ defaultMs: 150, uploadMs: 800 })
      .overrideProvider(RATE_LIMIT_CONFIG)
      .useValue(limits)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureHttpApp(app);
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    base = urlOf(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('JSON body limit (200 KB)', () => {
    it('un JSON pequeño funciona', async () => {
      const res = await request(base).post('/t/json').send({ a: 1, b: 'two' }).expect(201);
      expect(res.body).toEqual({ keys: 2, size: JSON.stringify({ a: 1, b: 'two' }).length });
    });

    it('un JSON de ~150 KB (por encima del default de 100 KB) sigue funcionando', async () => {
      await request(base).post('/t/json').send({ data: blob(150 * 1024) }).expect(201);
    });

    it('un JSON > 200 KB devuelve 413 + PAYLOAD_TOO_LARGE, sin detalles internos', async () => {
      const res = await request(base).post('/t/json').send({ data: blob(250 * 1024) }).expect(413);
      expect(res.body).toEqual(PAYLOAD_TOO_LARGE);
      expect(JSON.stringify(res.body)).not.toMatch(/limit|bytes|entity|body-parser/i);
    });

    it('multipart/form-data mayor a 200 KB NO lo bloquea el body parser JSON: llega a Multer', async () => {
      const res = await request(base)
        .post('/t/upload')
        .attach('file', Buffer.alloc(300 * 1024, 1), 'photo.bin')
        .expect(201);
      expect(res.body).toEqual({ received: 300 * 1024 });
    });

    it('el mismo tamaño enviado como JSON sí es rechazado (la diferencia es el tipo de contenido)', async () => {
      await request(base)
        .post('/t/json')
        .send({ data: blob(300 * 1024) })
        .expect(413);
    });
  });

  // `configureHttpApp` registers both body parsers with `inflate: false`: a request body that carries a Content-Encoding is
  // refused with 415 before any decompression stream exists. Nothing in MordWave sends compressed request bodies.
  describe('cuerpos de petición comprimidos (inflate: false)', () => {
    const COMPRESSORS: Array<[string, (data: Buffer) => Buffer]> = [
      ['gzip', gzipSync],
      ['deflate', deflateSync],
      ['br', brotliCompressSync],
      ['zstd', zstdCompressSync],
    ];
    const JSON_TYPE = 'application/json';
    const FORM_TYPE = 'application/x-www-form-urlencoded';
    const send = (path: string, contentType: string, body: Buffer | string, encoding?: string) => {
      const req = request(base).post(path).set('Content-Type', contentType);
      return (encoding ? req.set('Content-Encoding', encoding) : req).send(body);
    };
    const rejected415 = (res: { status: number; body: unknown }) => {
      expect(res.status).toBe(415);
      expect(res.body).toEqual(UNSUPPORTED_CONTENT_ENCODING);
      expect(JSON.stringify(res.body)).not.toMatch(/stack|node_modules|body-parser|zlib/i);
    };

    it('un JSON normal, sin comprimir, sigue funcionando', async () => {
      const res = await send('/t/json', JSON_TYPE, JSON.stringify({ a: 1, b: 'two' })).expect(201);
      expect(res.body).toEqual({ keys: 2, size: JSON.stringify({ a: 1, b: 'two' }).length });
    });

    it.each(COMPRESSORS)('un JSON comprimido con %s recibe 415', async (encoding, compress) => {
      rejected415(await send('/t/json', JSON_TYPE, compress(Buffer.from(JSON.stringify({ a: 1 }))), encoding));
    });

    it('un cuerpo comprimido rechazado no se registra como ERROR: no deja stack traces en los logs', async () => {
      const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        rejected415(await send('/t/json', JSON_TYPE, gzipSync(Buffer.from('{"a":1}')), 'gzip'));
        rejected415(await send('/t/form', FORM_TYPE, zstdCompressSync(Buffer.from('a=1')), 'zstd'));
        expect(logged).not.toHaveBeenCalled();
      } finally {
        logged.mockRestore();
      }
    });

    it('un JSON comprimido que descomprimiría a más de 200 KB también recibe 415: no se llega a descomprimir', async () => {
      const bomb = gzipSync(Buffer.from(JSON.stringify({ data: blob(250 * 1024) })));
      expect(bomb.length).toBeLessThan(2_000);
      rejected415(await send('/t/json', JSON_TYPE, bomb, 'gzip'));
    });

    it('un urlencoded normal sigue funcionando y conserva `extended` (a[b]=1 es un objeto anidado)', async () => {
      const res = await send('/t/form', FORM_TYPE, 'a=1&b=two&c[d]=3').expect(201);
      expect(res.body).toEqual({ keys: 3, body: { a: '1', b: 'two', c: { d: '3' } } });
    });

    it.each(COMPRESSORS)('un urlencoded comprimido con %s recibe 415', async (encoding, compress) => {
      rejected415(await send('/t/form', FORM_TYPE, compress(Buffer.from('a=1&b=two')), encoding));
    });

    it('un urlencoded sin comprimir mantiene su límite por defecto (100 KB): 413 PAYLOAD_TOO_LARGE', async () => {
      const res = await send('/t/form', FORM_TYPE, `data=${blob(150 * 1024)}`).expect(413);
      expect(res.body).toEqual(PAYLOAD_TOO_LARGE);
    });

    it('un JSON inválido sigue devolviendo 400', async () => {
      await send('/t/json', JSON_TYPE, '{no es json').expect(400);
    });

    it('hay exactamente un parser JSON y uno urlencoded registrados: ningún otro con `inflate` activo los precede', () => {
      const stack = (app.getHttpAdapter().getInstance() as { router: { stack: Array<{ name: string }> } }).router.stack;
      const parsers = stack.map((layer) => layer.name).filter((name) => name.endsWith('Parser'));
      expect(parsers.sort()).toEqual(['jsonParser', 'urlencodedParser']);
    });

    it('el servidor sigue funcionando tras los rechazos, y un multipart pequeño sigue llegando a Multer', async () => {
      expect((app.getHttpServer() as { listening: boolean }).listening).toBe(true);
      await request(base).get('/t/fast').expect(200);
      const res = await request(base).post('/t/upload').attach('file', Buffer.alloc(2_048, 1), 'photo.bin').expect(201);
      expect(res.body).toEqual({ received: 2_048 });
    });
  });

  describe('timeout lógico', () => {
    it('una request rápida responde normalmente', async () => {
      await request(base).get('/t/fast').expect(200);
    });

    it('una request normal que excede el deadline responde 504 REQUEST_TIMEOUT controlado', async () => {
      const res = await request(base).get('/t/slow').expect(504);
      expect(res.body).toEqual({
        statusCode: 504,
        errorCode: 'REQUEST_TIMEOUT',
        message: 'Request timed out',
      });
    });

    it('las rutas @UploadTimeout() tienen un deadline más largo', async () => {
      await request(base).post('/t/upload-slow').expect(201); // 400ms > 150ms default
    });

    it('…pero también tienen un límite', async () => {
      const res = await request(base).post('/t/upload-hung').expect(504);
      expect(res.body.errorCode).toBe('REQUEST_TIMEOUT');
    });
  });

  describe('errores de base de datos traducidos', () => {
    it('statement_timeout (57014) → 504 REQUEST_TIMEOUT sin SQL ni parámetros', async () => {
      const res = await request(base).get('/t/db-statement-timeout').expect(504);
      expect(res.body).toEqual({
        statusCode: 504,
        errorCode: 'REQUEST_TIMEOUT',
        message: 'Request timed out',
      });
      expect(JSON.stringify(res.body)).not.toMatch(/SELECT|secret|57014/i);
    });

    it('fallo al adquirir conexión → 503 TEMPORARILY_UNAVAILABLE', async () => {
      const res = await request(base).get('/t/db-pool-exhausted').expect(503);
      expect(res.body).toEqual({
        statusCode: 503,
        errorCode: 'TEMPORARILY_UNAVAILABLE',
        message: 'Service temporarily unavailable',
      });
    });

    it('conexión rechazada → 503 sin host ni puerto', async () => {
      const res = await request(base).get('/t/db-refused').expect(503);
      expect(res.body.errorCode).toBe('TEMPORARILY_UNAVAILABLE');
      expect(JSON.stringify(res.body)).not.toMatch(/internal|5432|ECONNREFUSED/);
    });

    it('un error no relacionado sigue siendo un 500 genérico', async () => {
      const res = await request(base).get('/t/plain-error').expect(500);
      expect(res.body).toEqual({ statusCode: 500, message: 'Internal server error' });
    });
  });

  describe('rate limiting convive con el timeout y el filtro', () => {
    it('sigue devolviendo 429 RATE_LIMITED con Retry-After', async () => {
      await request(base).get('/t/menu').expect(200);
      await request(base).get('/t/menu').expect(200);
      const res = await request(base).get('/t/menu').expect(429);
      expect(res.body).toEqual({
        statusCode: 429,
        errorCode: 'RATE_LIMITED',
        message: 'Too many requests',
      });
      expect(res.headers['retry-after']).toMatch(/^\d+$/);
    });
  });
});

// ---------------------------------------------------------------------------
// Part B — the real AppModule on an ephemeral local Postgres (PGlite, never
// Supabase) with a tiny pool and short DB timeouts set through the real
// DB_* env vars.
//
// What this DOES prove: the DB_* settings reach the pg pool; an exhausted
// pool becomes a 503; the client-side query_timeout becomes a 504; the 200kb
// rule holds on real routing; rate limiting still answers.
// What it CANNOT prove: anything about the server-side statement_timeout.
// PGlite is Postgres compiled to WASM with no signal/timer support: it
// never cancels a running statement, and its socket ignores the startup
// parameter pg sends (SHOW statement_timeout stays 0 even though the pool is
// configured with it). Delivery and enforcement of statement_timeout must be
// verified against a real Postgres / the real pooler (see the PR notes);
// here we only prove the pool is configured with it and that the 57014 → 504
// translation works (Part A). PGlite's socket also tolerates a single
// connection, so "pool" here means a pool of one.
// ---------------------------------------------------------------------------
@Controller('t')
class DbProbeController {
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  @Get('sleep')
  async sleep(@Query('s') seconds: string) {
    await this.dataSource.query('SELECT pg_sleep($1)', [Number(seconds)]);
    return { ok: true };
  }
}

describe('HTTP/DB protection — real app on local Postgres (e2e, never Supabase)', () => {
  let testDb: TestDatabase;
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let base: string;
  let ipCounter = 0;
  const nextIp = () => `198.51.100.${(ipCounter += 1)}`;

  const login = (ip: string, body: object = { email: 'nobody@http-e2e.test', password: 'whatever1' }) =>
    request(base).post('/auth/login').set('X-Real-IP', ip).send(body);

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
    process.env.DB_CONNECTION_TIMEOUT_MS = '300';
    process.env.DB_IDLE_TIMEOUT_MS = '45000';
    process.env.DB_STATEMENT_TIMEOUT_MS = '400';
    process.env.DB_QUERY_TIMEOUT_MS = '700';
    process.env.CLIENT_IP_HEADER = 'x-real-ip';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [DbProbeController],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureHttpApp(app);
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    base = urlOf(app);
    dataSource = moduleRef.get(DataSource);
    await runAllMigrations(dataSource);
  }, 60_000);

  afterAll(async () => {
    for (const name of [
      'DB_CONNECTION_TIMEOUT_MS',
      'DB_IDLE_TIMEOUT_MS',
      'DB_STATEMENT_TIMEOUT_MS',
      'DB_QUERY_TIMEOUT_MS',
      'CLIENT_IP_HEADER',
    ]) {
      delete process.env[name];
    }
    await app?.close();
    await testDb?.stop();
  });

  it('JSON pequeño funciona y JSON > 200 KB devuelve 413 PAYLOAD_TOO_LARGE en una ruta real', async () => {
    await login(nextIp()).expect(401); // normal path: wrong credentials, not a body problem
    const res = await login(nextIp(), { email: 'a@b.test', password: blob(250 * 1024) }).expect(413);
    expect(res.body).toEqual(PAYLOAD_TOO_LARGE);
  });

  it('un JSON comprimido recibe 415 en una ruta real, antes de llegar al login, y el mismo cuerpo sin comprimir sí llega', async () => {
    const payload = JSON.stringify({ email: 'nobody@http-e2e.test', password: 'whatever1' });
    const res = await request(base)
      .post('/auth/login')
      .set('X-Real-IP', nextIp())
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .send(gzipSync(Buffer.from(payload)))
      .expect(415);
    expect(res.body).toEqual(UNSUPPORTED_CONTENT_ENCODING);
    await login(nextIp()).expect(401); // the same body without compression is handled by the login (wrong credentials)
  });

  it('las opciones DB_* llegan al pool de pg', () => {
    const pgPool = (dataSource.driver as unknown as { master: { options: Record<string, unknown> } }).master;
    expect(pgPool.options).toMatchObject({
      max: 1,
      connectionTimeoutMillis: 300,
      idleTimeoutMillis: 45_000,
      statement_timeout: 400,
      query_timeout: 700,
    });
  });

  it('el rate limiting sigue funcionando: el 6º login desde la misma IP → 429', async () => {
    const ip = nextIp();
    for (let i = 0; i < 5; i += 1) await login(ip).expect(401);
    const res = await login(ip).expect(429);
    expect(res.body.errorCode).toBe('RATE_LIMITED');
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('pool agotado → 503 TEMPORARILY_UNAVAILABLE, y se recupera al liberar la conexión', async () => {
    const holder = dataSource.createQueryRunner();
    await holder.connect(); // takes the only connection in the pool
    try {
      const res = await request(base)
        .get('/categories')
        .query({ businessSlug: 'whatever' })
        .set('X-Real-IP', nextIp())
        .expect(503);
      expect(res.body).toEqual({
        statusCode: 503,
        errorCode: 'TEMPORARILY_UNAVAILABLE',
        message: 'Service temporarily unavailable',
      });
      expect(JSON.stringify(res.body)).not.toMatch(/127\.0\.0\.1|postgres|pool/i);
    } finally {
      await holder.release();
    }

    // Same request now succeeds in reaching the handler (unknown slug → 404).
    const recovered = await request(base)
      .get('/categories')
      .query({ businessSlug: 'whatever' })
      .set('X-Real-IP', nextIp())
      .expect(404);
    expect(recovered.body.errorCode).toBe('BUSINESS_NOT_FOUND');
  });

  // Last on purpose: pg_sleep keeps the single PGlite connection busy for
  // the full second even though the client gave up at 700ms.
  it('query_timeout del cliente (700 ms) sobre una consulta lenta real → 504 REQUEST_TIMEOUT', async () => {
    const res = await request(base).get('/t/sleep').query({ s: 1 }).set('X-Real-IP', nextIp()).expect(504);
    expect(res.body).toEqual({
      statusCode: 504,
      errorCode: 'REQUEST_TIMEOUT',
      message: 'Request timed out',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/pg_sleep|Query read timeout/);
    await sleep(600); // let the busy connection drain before teardown
  });
});
