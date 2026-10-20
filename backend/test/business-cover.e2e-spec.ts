import bcrypt from 'bcrypt';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { isBusinessCoverKey, businessCoverKey, businessLogoKey } from '../src/media/media-key.util.js';
import { AddBusinessCoverStorageKey1790600000000 } from '../src/migrations/1790600000000-AddBusinessCoverStorageKey.js';
import { RestaurantTable } from '../src/table/table.entity.js';
import { TableSession } from '../src/table/table-session.entity.js';
import { TableSessionStatus } from '../src/table/table-session-status.enum.js';
import { User } from '../src/user/user.entity.js';
import { UserRole } from '../src/user/user-role.enum.js';
import { COVER_KEY_CASES } from './support/media-key-cases.js';
import { runMigrationsBefore } from './support/run-all-migrations.js';
import { seedBusinessAtSchemaState } from './support/seed-business-at-schema-state.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

const TEST_BCRYPT_COST = 4;
const BASE = 'https://api.example.test';
const OBJ = 'cccccccc-3333-4abc-8def-333333333abc';
const PASSWORD = 'Sup3rSecret!C';

// Phase B, step 1 — the cover's schema and read path, proven against a real (ephemeral, local) PostgreSQL:
//  - the migration is applied to a database that ALREADY holds businesses, users, tables and open sessions (the
//    production situation), and nothing about them changes;
//  - the new column is optional, no existing row gets a cover, the CHECK matches the application's key rule;
//  - the API keeps working for those existing rows and serves `coverUrl: null` (businesses and QR sessions);
//  - once a business has a cover, only THAT business's responses carry it, and the storage key never leaves the API;
//  - down() / up() round-trips.
// Nothing here uploads, replaces or removes a cover: no endpoint does that yet.
describe('Business cover (migration + read path, e2e, real local Postgres)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  let dataSource: DataSource;

  let bizA: { id: string; slug: string };
  let bizB: { id: string; slug: string };
  const tokens = { adminA: '', adminB: '', superAdmin: '' };
  const qr = { a: 'qr-cover-a', b: 'qr-cover-b' };
  const logoKeyA = () => businessLogoKey(bizA.id, OBJ);
  const coverKeyA = () => businessCoverKey(bizA.id, OBJ);
  const url = (key: string) => `${BASE}/media/${key}`;

  let rowsBefore: string;
  let usersBefore: string;

  const migration = new AddBusinessCoverStorageKey1790600000000();
  // The pool holds a single connection (DB_POOL_MAX=1): the query runner must be released before dataSource.query() runs again.
  async function run(direction: 'up' | 'down'): Promise<void> {
    const queryRunner = dataSource.createQueryRunner();
    try {
      await migration[direction](queryRunner);
    } finally {
      await queryRunner.release();
    }
  }

  async function columnInfo() {
    const rows = await dataSource.query(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'businesses' AND column_name = 'cover_storage_key'`,
    );
    return rows[0] as { data_type: string; is_nullable: string; column_default: string | null } | undefined;
  }
  const constraintCount = async (): Promise<number> =>
    Number((await dataSource.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'CHK_businesses_cover_storage_key'`))[0].n);

  // Everything about the existing rows EXCEPT the new column, as one digest.
  const businessesDigest = async (): Promise<string> =>
    (await dataSource.query(`SELECT md5(coalesce(string_agg((to_jsonb(b) - 'cover_storage_key')::text, '|' ORDER BY id), '')) AS h FROM businesses b`))[0].h;
  const usersDigest = async (): Promise<string> =>
    (await dataSource.query(`SELECT md5(coalesce(string_agg(u::text, '|' ORDER BY id), '')) AS h FROM users u`))[0].h;

  // Evaluates the constraint exactly as Postgres stored it against a candidate value without writing anything (a real
  // violating write would desynchronise the single shared pglite-socket connection; see media-storage-keys.e2e-spec.ts).
  async function coverKeyAccepted(value: string | null): Promise<boolean> {
    const [row]: { def: string }[] = await dataSource.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'CHK_businesses_cover_storage_key'`,
    );
    expect(row, 'the constraint exists').toBeDefined();
    const expression = row.def.replace(/^CHECK\s*/, '');
    const [result]: { ok: boolean | null }[] = await dataSource.query(
      `WITH t(cover_storage_key) AS (VALUES ($1::text)) SELECT ${expression} AS ok FROM t`,
      [value],
    );
    return result.ok !== false;
  }

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

    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = moduleFixture.get(DataSource);

    // The production situation: the schema is exactly what is deployed today (every migration BEFORE this one) and it
    // already holds data.
    await runMigrationsBefore(dataSource, AddBusinessCoverStorageKey1790600000000);

    bizA = await seedBusinessAtSchemaState(dataSource, 'Cover Co A', 'cover-co-a');
    bizB = await seedBusinessAtSchemaState(dataSource, 'Cover Co B', 'cover-co-b');
    await dataSource.query(`UPDATE businesses SET logo_storage_key = $1, primary_color = '#112233' WHERE id = $2`, [logoKeyA(), bizA.id]);

    const userRepo = dataSource.getRepository(User);
    const passwordHash = await bcrypt.hash(PASSWORD, TEST_BCRYPT_COST);
    await userRepo.save([
      userRepo.create({ email: 'admin-a@cover-e2e.test', passwordHash, role: UserRole.ADMIN, businessId: bizA.id }),
      userRepo.create({ email: 'admin-b@cover-e2e.test', passwordHash, role: UserRole.ADMIN, businessId: bizB.id }),
      userRepo.create({ email: 'super@cover-e2e.test', passwordHash, role: UserRole.SUPER_ADMIN, businessId: null }),
    ]);

    const tableRepo = dataSource.getRepository(RestaurantTable);
    const sessionRepo = dataSource.getRepository(TableSession);
    for (const [biz, qrToken, sessionToken] of [
      [bizA, qr.a, 'session-cover-a'],
      [bizB, qr.b, 'session-cover-b'],
    ] as const) {
      const table = await tableRepo.save(tableRepo.create({ businessId: biz.id, name: 'Mesa 1', qrToken }));
      await sessionRepo.save(sessionRepo.create({ tableId: table.id, businessId: biz.id, sessionToken, status: TableSessionStatus.OPEN }));
    }

    rowsBefore = await businessesDigest();
    usersBefore = await usersDigest();
  }, 60_000);

  afterAll(async () => {
    delete process.env.MEDIA_PUBLIC_BASE_URL;
    await app?.close();
    await testDb?.stop();
  });

  const login = async (email: string): Promise<string> =>
    (await request(app.getHttpServer()).post('/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken;
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const join = (qrToken: string) => request(app.getHttpServer()).post('/table-sessions/join').send({ qrToken });

  describe('before the migration (the schema that is deployed today)', () => {
    it('has no cover column and the existing data is in place', async () => {
      expect(await columnInfo()).toBeUndefined();
      expect(await constraintCount()).toBe(0);
      expect(Number((await dataSource.query(`SELECT count(*)::int AS n FROM businesses`))[0].n)).toBe(2);
    });
  });

  describe('migration up() on a database that already holds data', () => {
    it('adds ONE nullable text column with no default, and the named CHECK', async () => {
      await run('up');
      expect(await columnInfo()).toEqual({ data_type: 'text', is_nullable: 'YES', column_default: null });
      expect(await constraintCount()).toBe(1);
    });

    it('gives every existing business NULL (no cover) and changes nothing else about businesses or users', async () => {
      const rows: { id: string; cover_storage_key: string | null }[] = await dataSource.query(`SELECT id, cover_storage_key FROM businesses`);
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row.cover_storage_key).toBeNull();
      expect(await businessesDigest()).toBe(rowsBefore);
      expect(await usersDigest()).toBe(usersBefore);
    });

    it('adds nothing else to the schema (no other column or constraint appears)', async () => {
      const cols = (await dataSource.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'businesses' ORDER BY 1`)) as { column_name: string }[];
      expect(cols.map((c) => c.column_name)).toEqual(
        ['accent_color', 'active', 'address', 'cover_storage_key', 'created_at', 'hours', 'id', 'logo_storage_key', 'name', 'phone', 'primary_color', 'slug', 'updated_at'],
      );
    });
  });

  describe('CHECK constraint (the same case table as the unit spec, evaluated by the database)', () => {
    it.each(COVER_KEY_CASES)('businesses.cover_storage_key — %s', async (_label, key, valid) => {
      expect(await coverKeyAccepted(key)).toBe(valid);
      // The database and the util regex must always agree.
      expect(isBusinessCoverKey(key)).toBe(valid);
    });

    it('accepts NULL (no cover)', async () => {
      expect(await coverKeyAccepted(null)).toBe(true);
    });

    it("is about shape only: a key under another business prefix passes (tenancy is the application's job, as for the logo)", async () => {
      expect(await coverKeyAccepted(`businesses/dddddddd-4444-4abc-8def-444444444abc/cover/${OBJ}.webp`)).toBe(true);
    });
  });

  describe('compatibility: what the API serves for the rows that already existed', () => {
    beforeAll(async () => {
      tokens.adminA = await login('admin-a@cover-e2e.test');
      tokens.adminB = await login('admin-b@cover-e2e.test');
      tokens.superAdmin = await login('super@cover-e2e.test');
    });

    it('GET /businesses/me: coverUrl is null, the existing logo and colour are untouched, no storage key', async () => {
      const res = await request(app.getHttpServer()).get('/businesses/me').set(as(tokens.adminA)).expect(200);
      expect(res.body).toMatchObject({ id: bizA.id, slug: 'cover-co-a', logoUrl: url(logoKeyA()), primaryColor: '#112233', coverUrl: null });
      expect(JSON.stringify(res.body)).not.toMatch(/storage_?key/i);
      expect(Object.keys(res.body).sort()).toEqual(
        ['accentColor', 'active', 'address', 'coverUrl', 'createdAt', 'hours', 'id', 'logoUrl', 'name', 'phone', 'primaryColor', 'slug', 'updatedAt'],
      );
    });

    it('POST /table-sessions/join on an already-open session: same session, coverUrl null, existing branding intact, nothing written', async () => {
      const sessionsBefore = Number((await dataSource.query(`SELECT count(*)::int AS n FROM table_sessions`))[0].n);
      const res = await join(qr.a).expect(200);
      expect(res.body).toEqual({
        sessionToken: 'session-cover-a',
        tableName: 'Mesa 1',
        businessSlug: 'cover-co-a',
        businessName: 'Cover Co A',
        logoUrl: url(logoKeyA()),
        coverUrl: null,
        primaryColor: '#112233',
        accentColor: null,
      });
      expect(Number((await dataSource.query(`SELECT count(*)::int AS n FROM table_sessions`))[0].n)).toBe(sessionsBefore);
      const b = await join(qr.b).expect(200);
      expect(b.body).toMatchObject({ sessionToken: 'session-cover-b', businessSlug: 'cover-co-b', coverUrl: null, logoUrl: null });
    });

    it('SUPER_ADMIN reads: GET /businesses/:id has coverUrl null; the picker list keeps its small shape (no cover fields at all)', async () => {
      const one = await request(app.getHttpServer()).get(`/businesses/${bizA.id}`).set(as(tokens.superAdmin)).expect(200);
      expect(one.body.coverUrl).toBeNull();
      expect(one.body).not.toHaveProperty('coverStorageKey');
      const list = await request(app.getHttpServer()).get('/businesses').set(as(tokens.superAdmin)).expect(200);
      for (const item of list.body.items) expect(Object.keys(item).sort()).toEqual(['active', 'id', 'logoUrl', 'name', 'slug']);
    });
  });

  describe('multi-tenant isolation once a business has a cover', () => {
    beforeAll(async () => {
      // Test fixture: no endpoint can set a cover yet, so the row is written directly.
      await dataSource.query(`UPDATE businesses SET cover_storage_key = $1 WHERE id = $2`, [coverKeyA(), bizA.id]);
    });

    it("only A's responses carry A's cover: /me, join and the SUPER_ADMIN read", async () => {
      const meA = await request(app.getHttpServer()).get('/businesses/me').set(as(tokens.adminA)).expect(200);
      expect(meA.body.coverUrl).toBe(url(coverKeyA()));
      const joinA = await join(qr.a).expect(200);
      expect(joinA.body.coverUrl).toBe(url(coverKeyA()));
      const oneA = await request(app.getHttpServer()).get(`/businesses/${bizA.id}`).set(as(tokens.superAdmin)).expect(200);
      expect(oneA.body.coverUrl).toBe(url(coverKeyA()));
      // the cover is a /media URL under A's own prefix
      expect(joinA.body.coverUrl).toMatch(new RegExp(`^${BASE}/media/businesses/${bizA.id}/cover/[0-9a-f-]{36}\\.webp$`));
    });

    it("B never receives A's cover, by any route", async () => {
      const meB = await request(app.getHttpServer()).get('/businesses/me').set(as(tokens.adminB)).expect(200);
      expect(meB.body).toMatchObject({ id: bizB.id, coverUrl: null });
      const joinB = await join(qr.b).expect(200);
      expect(joinB.body.coverUrl).toBeNull();
      const oneB = await request(app.getHttpServer()).get(`/businesses/${bizB.id}`).set(as(tokens.superAdmin)).expect(200);
      expect(oneB.body.coverUrl).toBeNull();
      // B's admin asking for A (?businessId=) is either refused or answered with B's own business: never A's cover
      const sneaky = await request(app.getHttpServer()).get('/businesses/me').query({ businessId: bizA.id }).set(as(tokens.adminB));
      expect(JSON.stringify(sneaky.body)).not.toContain(coverKeyA());
      if (sneaky.status === 200) expect(sneaky.body).toMatchObject({ id: bizB.id, coverUrl: null });
    });

    it('the storage key never appears in any response (only inside the /media URL)', async () => {
      const bodies = [
        (await request(app.getHttpServer()).get('/businesses/me').set(as(tokens.adminA)).expect(200)).body,
        (await join(qr.a).expect(200)).body,
        (await request(app.getHttpServer()).get(`/businesses/${bizA.id}`).set(as(tokens.superAdmin)).expect(200)).body,
        (await request(app.getHttpServer()).get('/businesses').set(as(tokens.superAdmin)).expect(200)).body,
      ];
      for (const body of bodies) {
        const text = JSON.stringify(body);
        expect(text).not.toMatch(/storage_?key/i);
        expect(text.split(coverKeyA()).length - 1).toBe(text.includes(url(coverKeyA())) ? 1 : 0);
      }
    });

    it('the database refuses malformed values (a full URL, a traversal), so only a well-formed key can ever be stored', async () => {
      expect(await coverKeyAccepted(`../${coverKeyA()}`)).toBe(false);
      expect(await coverKeyAccepted(`${BASE}/media/${coverKeyA()}`)).toBe(false);
    });
  });

  describe('schema drift and reversibility', () => {
    it('the entity metadata and the migrated schema agree on the cover column and its CHECK (migration:generate would emit nothing)', async () => {
      const { upQueries } = await dataSource.driver.createSchemaBuilder().log();
      expect(upQueries.map((q) => q.query).filter((q) => /cover_storage_key|CHK_businesses_cover/.test(q))).toEqual([]);
    });

    it('down() removes the column and the CHECK and touches nothing else; up() restores them (the cover itself is gone, as designed)', async () => {
      const digestBeforeDown = await businessesDigest();
      await run('down');
      expect(await columnInfo()).toBeUndefined();
      expect(await constraintCount()).toBe(0);
      // Control for the drift test above: with the migration reverted the schema builder MUST want to re-add the column.
      const { upQueries } = await dataSource.driver.createSchemaBuilder().log();
      expect(upQueries.map((q) => q.query).some((q) => /ADD "cover_storage_key"/.test(q))).toBe(true);
      // every other column of every business is exactly as it was
      expect(await businessesDigest()).toBe(digestBeforeDown);
      expect(await usersDigest()).toBe(usersBefore);

      await run('up');
      expect(await columnInfo()).toEqual({ data_type: 'text', is_nullable: 'YES', column_default: null });
      expect(await constraintCount()).toBe(1);
      const rows: { cover_storage_key: string | null }[] = await dataSource.query(`SELECT cover_storage_key FROM businesses`);
      for (const row of rows) expect(row.cover_storage_key).toBeNull();
      // and the API is healthy again on the re-applied schema
      const res = await join(qr.a).expect(200);
      expect(res.body.coverUrl).toBeNull();
    });
  });
});
