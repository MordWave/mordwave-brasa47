import { randomBytes } from 'node:crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SafeUser } from '../src/auth/safe-user.js';
import { AuditLog } from '../src/audit/audit-log.entity.js';
import { Business } from '../src/business/business.entity.js';
import { BusinessLimitsService } from '../src/business/business-limits.service.js';
import { BusinessPresenter } from '../src/business/business.presenter.js';
import { Category } from '../src/category/category.entity.js';
import { MediaUrlService } from '../src/media/media-url.service.js';
import { OrderItem } from '../src/order/order-item.entity.js';
import { Order } from '../src/order/order.entity.js';
import { Product } from '../src/product/product.entity.js';
import { RestaurantTable } from '../src/table/table.entity.js';
import { TableService } from '../src/table/table.service.js';
import { TableSession } from '../src/table/table-session.entity.js';
import { TableSessionService } from '../src/table/table-session.service.js';
import { TableSessionStatus } from '../src/table/table-session-status.enum.js';
import { generateOpaqueToken } from '../src/table/token.util.js';
import { User } from '../src/user/user.entity.js';
import { UserRole } from '../src/user/user-role.enum.js';
import { UpdateTableDto } from '../src/table/dto/update-table.dto.js';
import { runAllMigrations } from './support/run-all-migrations.js';

// 9E.22 — the lost updates of TableService (rotateQr, update), reproduced against a REAL PostgreSQL server with INDEPENDENT connections
// (a pool), not PGlite (a single connection) and not mocks. OPT-IN: it runs only when REAL_PG_ADMIN_URL points at a LOCAL, disposable
// PostgreSQL (loopback only), e.g.
//
//   REAL_PG_ADMIN_URL=postgresql://user:pw@127.0.0.1:54351/postgres JWT_SECRET=... npm run test:e2e -- table-concurrency
//
// Without the variable the whole file is skipped. With it, the file creates its OWN throw-away database (e2e_table_<random>), runs every
// real migration in it, uses fictitious data and DROPs the database afterwards. It never touches any other database.
//
// How the interleaving is forced: a repository's `findOne` is wrapped so that, after it returned its row, the request pauses until
// released (the window between "read" and "write"). `legacyRotateQr` is the implementation of main 01aaf0e (findOne -> assign ->
// save()), kept here so that the same harness shows the defect on the old code and its absence on the new one. It exists only here.
const ADMIN_URL = process.env.REAL_PG_ADMIN_URL;

function assertLoopback(raw: string): URL {
  const url = new URL(raw);
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) {
    throw new Error('REAL_PG_ADMIN_URL must point at a local PostgreSQL (127.0.0.1 / localhost); refusing to continue');
  }
  return url;
}

const gate = () => {
  let release!: () => void;
  let reach!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  const reached = new Promise<void>((resolve) => (reach = resolve));
  return { wait, release, reached, reach, used: false };
};
type Gate = ReturnType<typeof gate>;

function gatedRepo<T extends object>(repository: T, g: Gate): T {
  return new Proxy(repository, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (prop === 'findOne') {
        return async (...args: unknown[]) => {
          const row = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          if (!g.used) {
            g.used = true;
            g.reach();
            await g.wait;
          }
          return row;
        };
      }
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

// Records the qr_token a request OBSERVED: the one its first findOne returned, which is the token its UPDATE is conditioned on.
function observingRepo<T extends object>(repository: T): { repo: T; seen: { token?: string } } {
  const seen: { token?: string } = {};
  const repo = new Proxy(repository, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (prop === 'findOne') {
        return async (...args: unknown[]) => {
          const row = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          if (seen.token === undefined && row) seen.token = (row as { qrToken?: string }).qrToken;
          return row;
        };
      }
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { repo, seen };
}

type Outcome<T = unknown> = { ok: true; value: T } | { ok: false; status: number; code?: string };
const settle = <T,>(p: Promise<T>): Promise<Outcome<T>> =>
  p.then(
    (value): Outcome<T> => ({ ok: true, value }),
    (e: unknown): Outcome<T> => {
      const body = (e as { getResponse?: () => unknown }).getResponse?.();
      return { ok: false, status: (e as { getStatus?: () => number }).getStatus?.() ?? 0, code: (body as { errorCode?: string } | undefined)?.errorCode };
    },
  );

describe.skipIf(!ADMIN_URL)('TableService under real concurrency (e2e, real local PostgreSQL, independent connections)', () => {
  let admin: DataSource;
  let ds: DataSource;
  let dbName: string;
  let bizA: Business;
  let bizB: Business;

  const adminA: SafeUser = { id: '00000000-0000-4000-8000-0000000000a1', email: 'a@real-pg.test', role: UserRole.ADMIN, businessId: '', active: true, mustChangePassword: false };
  const adminB: SafeUser = { id: '00000000-0000-4000-8000-0000000000b1', email: 'b@real-pg.test', role: UserRole.ADMIN, businessId: '', active: true, mustChangePassword: false };
  const superAdmin: SafeUser = { id: '00000000-0000-4000-8000-0000000000c1', email: 'super@real-pg.test', role: UserRole.SUPER_ADMIN, businessId: null, active: true, mustChangePassword: false };

  const tRepo = () => ds.getRepository(RestaurantTable);
  const limits = () => new BusinessLimitsService({ business: { product: 500, category: 50, table: 200, user: 20 } } as never);
  const service = (tableRepo = tRepo()) => new TableService(tableRepo, ds.getRepository(Business), ds.getRepository(TableSession), ds, limits());
  const sessions = () => new TableSessionService(tRepo(), ds.getRepository(TableSession), ds.getRepository(Business), ds, new BusinessPresenter(new MediaUrlService()));

  let seq = 0;
  const newTable = async (extra: Partial<RestaurantTable> = {}, businessId = bizA.id) => {
    seq += 1;
    return tRepo().save(tRepo().create({ businessId, name: `Mesa ${seq}`, qrToken: generateOpaqueToken(), ...extra }));
  };
  const row = async (id: string) =>
    (await ds.query(`SELECT name, active, qr_token AS qr, business_id AS biz, deleted_at AS del, updated_at AS upd FROM restaurant_tables WHERE id = $1`, [id]))[0] as {
      name: string; active: boolean; qr: string; biz: string; del: Date | null; upd: Date;
    };
  const softDelete = (id: string) => ds.query(`UPDATE restaurant_tables SET deleted_at = now() WHERE id = $1`, [id]);

  // ---- main 01aaf0e1 (the defect): read -> assign a new token -> save() of the whole stale entity ----
  async function legacyRotateQr(repo: ReturnType<typeof tRepo>, id: string): Promise<string> {
    const table = await repo.findOne({ where: { id } });
    if (!table) throw new NotFoundException();
    table.qrToken = generateOpaqueToken();
    const saved = await repo.save(table);
    return saved.qrToken;
  }

  beforeAll(async () => {
    const base = assertLoopback(ADMIN_URL as string);
    dbName = `e2e_table_${randomBytes(6).toString('hex')}`;
    admin = new DataSource({ type: 'postgres', url: base.toString(), entities: [] });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const own = new URL(base.toString());
    own.pathname = `/${dbName}`;
    ds = new DataSource({ type: 'postgres', url: own.toString(), entities: [Business, Category, Product, User, Order, OrderItem, RestaurantTable, TableSession, AuditLog], extra: { max: 30 } });
    await ds.initialize();
    const server = (await ds.query(`SHOW server_version`))[0].server_version as string;
    expect(Number(server.split('.')[0])).toBeGreaterThanOrEqual(18);
    await runAllMigrations(ds);

    const bRepo = ds.getRepository(Business);
    bizA = await bRepo.save(bRepo.create({ name: 'Real PG A', slug: 'real-pg-a' }));
    bizB = await bRepo.save(bRepo.create({ name: 'Real PG B', slug: 'real-pg-b' }));
    adminA.businessId = bizA.id;
    adminB.businessId = bizB.id;
  }, 120_000);

  afterAll(async () => {
    try {
      await ds?.destroy();
      if (admin?.isInitialized && dbName) await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    } finally {
      await admin?.destroy();
    }
  });

  describe('the defects, reproduced with the implementation of main 01aaf0e1 (findOne -> assign -> save)', () => {
    it('rotateQr vs a deactivation + rename committed in between: the table is reactivated and renamed back', async () => {
      const t = await newTable({ name: 'Mesa 1' });
      const g = gate();
      const slow = settle(legacyRotateQr(gatedRepo(tRepo(), g), t.id));
      await g.reached;
      await service().update(t.id, { active: false, name: 'Fuera de servicio' }, adminA);
      expect(await row(t.id)).toMatchObject({ active: false, name: 'Fuera de servicio' });
      g.release();
      expect((await slow).ok).toBe(true);
      expect(await row(t.id)).toMatchObject({ active: true, name: 'Mesa 1' }); // both silently reverted
    });

    it('rotateQr vs a deletion committed in between: the deleted table is resurrected (deleted_at back to NULL)', async () => {
      const t = await newTable();
      const g = gate();
      const slow = settle(legacyRotateQr(gatedRepo(tRepo(), g), t.id));
      await g.reached;
      await softDelete(t.id);
      g.release();
      expect((await slow).ok).toBe(true);
      expect((await row(t.id)).del).toBeNull();
    });
  });

  describe('rotateQr, corrected (UPDATE qr_token only ... WHERE id AND business_id AND deleted_at IS NULL AND qr_token = observed)', () => {
    it('1. a deactivation committed in between is NOT undone (the table stays inactive) and the token is rotated', async () => {
      const t = await newTable();
      const g = gate();
      const slow = settle(service(gatedRepo(tRepo(), g)).rotateQr(t.id, adminA));
      await g.reached;
      await service().update(t.id, { active: false }, adminA);
      g.release();
      const out = await slow;
      expect(out.ok).toBe(true);
      const after = await row(t.id);
      expect(after.active).toBe(false);
      expect(after.qr).toBe((out as { value: { qrToken: string } }).value.qrToken);
      expect(after.qr).not.toBe(t.qrToken);
    });

    it('2. a rename committed in between is NOT undone, and neither is a deactivation + rename together', async () => {
      const t = await newTable({ name: 'Mesa 1' });
      const g = gate();
      const slow = settle(service(gatedRepo(tRepo(), g)).rotateQr(t.id, adminA));
      await g.reached;
      await service().update(t.id, { name: 'Terraza', active: false }, adminA);
      g.release();
      expect((await slow).ok).toBe(true);
      expect(await row(t.id)).toMatchObject({ name: 'Terraza', active: false });
    });

    it('3. a table DELETED in between: 404, it stays deleted and its token is not changed', async () => {
      const t = await newTable();
      const g = gate();
      const slow = settle(service(gatedRepo(tRepo(), g)).rotateQr(t.id, adminA));
      await g.reached;
      await softDelete(t.id);
      const stamp = (await row(t.id)).upd.getTime();
      g.release();
      expect(await slow).toMatchObject({ ok: false, status: 404 });
      const after = await row(t.id);
      expect(after.del).not.toBeNull();
      expect(after.qr).toBe(t.qrToken);
      expect(after.upd.getTime()).toBe(stamp); // nothing written at all
    });

    it('4. TWO overlapping rotations: exactly one wins and the DB holds the winner\'s token; the other is a 409, never a "success" with a token already replaced', async () => {
      const t = await newTable();
      const gA = gate(), gB = gate();
      const a = settle(service(gatedRepo(tRepo(), gA)).rotateQr(t.id, adminA));
      const b = settle(service(gatedRepo(tRepo(), gB)).rotateQr(t.id, adminA));
      await Promise.all([gA.reached, gB.reached]);
      gA.release();
      const first = await a;
      gB.release();
      const second = await b;
      expect(first.ok).toBe(true);
      expect(second).toMatchObject({ ok: false, status: 409, code: 'TABLE_CONCURRENT_MODIFICATION' });
      expect((await row(t.id)).qr).toBe((first as { value: { qrToken: string } }).value.qrToken);
    });

    // The contract is about rotations that OBSERVED the same token (the UPDATE is conditioned on `qr_token = observed`): of those, exactly one
    // wins and the other is a 409. Two calls whose read-then-write windows do not overlap are just two rotations one after the other: BOTH
    // succeed, the second one having observed the first one's new token. Which of the two happens depends on scheduling (and on how warm the
    // connection pool is), so a round is judged by what each request actually observed, never by the order of the answers.
    type Rotation = Outcome<{ qrToken: string }>;
    const judgeRotationRound = (initial: string, a: Rotation, b: Rotation, seenA: string | undefined, seenB: string | undefined, stored: string): { kind: 'conflict' | 'sequential' | 'invalid'; problems: string[] } => {
      const isConflict = (o: Rotation) => !o.ok && o.status === 409 && o.code === 'TABLE_CONCURRENT_MODIFICATION';
      const answers: Array<[string, Rotation]> = [['a', a], ['b', b]];
      const unexpected = answers.flatMap(([who, o]) => (o.ok || isConflict(o) ? [] : [`${who} answered ${o.status}${o.code ? ` ${o.code}` : ''}: neither a rotation nor the 409 conflict`]));
      if (unexpected.length > 0) return { kind: 'invalid', problems: unexpected };
      if (seenA === undefined || seenB === undefined) return { kind: 'invalid', problems: ['a request did not read the table'] };
      if (!a.ok && !b.ok) return { kind: 'invalid', problems: ['both requests were answered 409: nobody rotated'] };
      if (stored === initial) return { kind: 'invalid', problems: ['the stored token is still the initial one'] };

      if (a.ok !== b.ok) {
        const winner = a.ok ? a : (b as { ok: true; value: { qrToken: string } });
        const winnerSeen = a.ok ? seenA : seenB;
        const loserSeen = a.ok ? seenB : seenA;
        const problems: string[] = [];
        if (winnerSeen !== initial) problems.push('the winner did not observe the initial token');
        if (loserSeen !== initial) problems.push('the 409 loser did not observe the initial token, so it had no reason to lose');
        if (winner.value.qrToken === initial || winner.value.qrToken !== stored) problems.push('the stored token is not the winner\'s new token');
        return { kind: 'conflict', problems };
      }

      // Both succeeded: that is only valid as a chain initial -> first's token -> second's token, the second having observed the first's.
      const tokenA = a.ok ? a.value.qrToken : '';
      const tokenB = b.ok ? b.value.qrToken : '';
      const aFirst = seenA === initial && seenB === tokenA;
      const bFirst = seenB === initial && seenA === tokenB;
      const problems: string[] = [];
      if (tokenA === tokenB || tokenA === initial || tokenB === initial) problems.push('the rotations did not produce two new, different tokens');
      if (!aFirst && !bFirst) problems.push('both succeeded but not as a chain: a lost update (each request should have observed either the initial token or the other one\'s new token, exactly one of each)');
      else if (stored !== (aFirst ? tokenB : tokenA)) problems.push('the stored token is not the one of the LAST rotation in the chain');
      return { kind: 'sequential', problems };
    };

    it('4b. natural concurrency, 40 rounds of two simultaneous rotations: overlapping ones give exactly one winner and a 409, sequential ones chain, and the stored token is always the last winner\'s', async () => {
      const failures: string[] = [];
      const counts = { conflict: 0, sequential: 0 };
      for (let i = 0; i < 40; i++) {
        const t = await newTable();
        const ra = observingRepo(tRepo());
        const rb = observingRepo(tRepo());
        const [a, b] = await Promise.all([settle(service(ra.repo).rotateQr(t.id, adminA)), settle(service(rb.repo).rotateQr(t.id, adminA))]);
        const stored = (await row(t.id)).qr;
        const verdict = judgeRotationRound(t.qrToken, a, b, ra.seen.token, rb.seen.token, stored);
        if (verdict.kind !== 'invalid') counts[verdict.kind] += 1;
        for (const problem of verdict.problems) failures.push(`round ${i + 1} (${verdict.kind}): ${problem}`);
      }
      console.info(`4b: ${counts.conflict} rounds overlapped (one winner + 409), ${counts.sequential} ran one after the other (chained), 40 in total`);
      expect(failures).toEqual([]);
    });

    it('4c. a rotation NEXT to a rename (no token conflict) never conflicts: both apply, in any order', async () => {
      for (const renameFirst of [true, false]) {
        const t = await newTable({ name: 'Mesa 1' });
        const g = gate();
        const slow = settle(service(gatedRepo(tRepo(), g)).rotateQr(t.id, adminA));
        await g.reached;
        if (renameFirst) await service().update(t.id, { name: 'Terraza' }, adminA);
        g.release();
        const out = await slow;
        if (!renameFirst) await service().update(t.id, { name: 'Terraza' }, adminA);
        expect(out.ok).toBe(true);
        const after = await row(t.id);
        expect(after.name).toBe('Terraza');
        expect(after.qr).not.toBe(t.qrToken);
      }
    });

    it('5. isolation: another business\' ADMIN is refused (403) and the token is unchanged; a SUPER_ADMIN may rotate any table; other tables are untouched', async () => {
      const mine = await newTable();
      const sibling = await newTable();
      const other = await newTable({}, bizB.id);
      const out = await settle(service().rotateQr(mine.id, adminB));
      expect(out).toMatchObject({ ok: false, status: 403 });
      expect((await row(mine.id)).qr).toBe(mine.qrToken);

      const rotated = await service().rotateQr(mine.id, superAdmin);
      expect((await row(mine.id)).qr).toBe(rotated.qrToken);
      expect((await row(sibling.id)).qr).toBe(sibling.qrToken);
      expect((await row(other.id)).qr).toBe(other.qrToken);
    });

    it('6. an unknown table is a 404', async () => {
      expect(await settle(service().rotateQr('00000000-0000-4000-8000-000000000000', adminA))).toMatchObject({ ok: false, status: 404 });
    });

    it('7. nothing but qr_token (and updated_at) changes', async () => {
      const t = await newTable({ name: 'Mesa 7', active: false });
      const before = await row(t.id);
      await service().rotateQr(t.id, adminA);
      const after = await row(t.id);
      expect({ ...after, qr: before.qr, upd: before.upd }).toEqual(before);
      expect(after.qr).not.toBe(before.qr);
    });
  });

  describe('QR sessions around a rotation (rules unchanged)', () => {
    it('10. an OPEN session keeps working after the QR is rotated; the OLD QR stops resolving; the NEW one joins the SAME session', async () => {
      const t = await newTable({ name: 'Mesa QR' });
      const opened = await sessions().open(t.id, adminA); // the admin-facing answer does not carry the session token
      const { sessionToken } = await ds.getRepository(TableSession).findOneByOrFail({ id: opened.id });
      expect(await sessions().join(t.qrToken)).toMatchObject({ sessionToken });

      const { qrToken } = await service().rotateQr(t.id, adminA);

      expect(await sessions().status(sessionToken)).toEqual({ open: true });
      expect(await settle(sessions().join(t.qrToken))).toMatchObject({ ok: false, status: 404, code: 'TABLE_SESSION_UNAVAILABLE' });
      expect(await sessions().join(qrToken)).toMatchObject({ sessionToken });
      const open = await ds.getRepository(TableSession).count({ where: { tableId: t.id, status: TableSessionStatus.OPEN } });
      expect(open).toBe(1); // no session was opened or closed by the rotation
    });

    it('10b. a rotation racing a session close or open neither revives the table nor loses the session state', async () => {
      const t = await newTable();
      const g = gate();
      const slow = settle(service(gatedRepo(tRepo(), g)).rotateQr(t.id, adminA));
      await g.reached;
      const session = await sessions().open(t.id, adminA);
      await sessions().close(t.id, adminA);
      await service().update(t.id, { active: false }, adminA);
      g.release();
      expect((await slow).ok).toBe(true);
      expect((await row(t.id)).active).toBe(false);
      const stored = await ds.getRepository(TableSession).findOneByOrFail({ id: session.id });
      expect(stored.status).toBe(TableSessionStatus.CLOSED);
    });
  });

  describe('update (PATCH), corrected', () => {
    it('8. the answer is COMPLETE after a partial PATCH, even with a DTO instance of the production build (own undefined properties)', async () => {
      const t = await newTable({ name: 'Mesa 1', active: true });
      const dto = Object.assign(new UpdateTableDto(), { name: 'Mesa renombrada' }); // `active` stays an own `undefined` property
      expect(Object.keys(dto)).toContain('active');
      const res = await service().update(t.id, dto, adminA);
      expect(res).toMatchObject({ id: t.id, businessId: bizA.id, name: 'Mesa renombrada', active: true });
      expect(res).not.toHaveProperty('qrToken');
      expect(res.createdAt).toBeInstanceOf(Date);
      expect(await row(t.id)).toMatchObject({ name: 'Mesa renombrada', active: true });
    });

    it('7b. a partial PATCH leaves the omitted column alone, and an explicit false / new name are written', async () => {
      const t = await newTable({ name: 'Mesa 1', active: true });
      await service().update(t.id, { active: false }, adminA);
      expect(await row(t.id)).toMatchObject({ name: 'Mesa 1', active: false });
      await service().update(t.id, { name: 'Terraza' }, adminA);
      expect(await row(t.id)).toMatchObject({ name: 'Terraza', active: false });
    });

    it('9. two PATCH of different columns, 60 natural rounds: never a lost column; and PATCH vs rotation never undoes either', async () => {
      const t = await newTable();
      let lost = 0;
      for (let i = 0; i < 60; i++) {
        const name = `Mesa ${i}`;
        const active = i % 2 === 0;
        const before = (await row(t.id)).qr;
        await Promise.all([service().update(t.id, { name }, adminA), service().update(t.id, { active }, adminA), service().rotateQr(t.id, adminA)]);
        const r = await row(t.id);
        if (r.name !== name || r.active !== active || r.qr === before) lost += 1;
      }
      expect(lost).toBe(0);
    });

    it('a PATCH on a table deleted meanwhile is a 404 and it stays deleted; an open session still blocks deactivation (409 TABLE_HAS_OPEN_SESSION)', async () => {
      const deleted = await newTable();
      const g = gate();
      const slow = settle(service(gatedRepo(tRepo(), g)).update(deleted.id, { name: 'x' }, adminA));
      await g.reached;
      await softDelete(deleted.id);
      g.release();
      expect(await slow).toMatchObject({ ok: false, status: 404 });
      expect((await row(deleted.id)).del).not.toBeNull();

      const busy = await newTable();
      await sessions().open(busy.id, adminA);
      expect(await settle(service().update(busy.id, { active: false }, adminA))).toMatchObject({ ok: false, status: 409, code: 'TABLE_HAS_OPEN_SESSION' });
      expect((await row(busy.id)).active).toBe(true);
    });

    it('PATCH isolation: another business\' ADMIN is refused (403), SUPER_ADMIN may edit any table', async () => {
      const t = await newTable({ name: 'Mesa 1' });
      expect(await settle(service().update(t.id, { name: 'x' }, adminB))).toMatchObject({ ok: false, status: 403 });
      expect((await row(t.id)).name).toBe('Mesa 1');
      await service().update(t.id, { name: 'Editada por SUPER' }, superAdmin);
      expect((await row(t.id)).name).toBe('Editada por SUPER');
    });

    it('errors are plain 4xx, never a 500', async () => {
      expect(ConflictException).toBeDefined();
      expect(await settle(service().update('00000000-0000-4000-8000-000000000000', { name: 'x' }, adminA))).toMatchObject({ ok: false, status: 404 });
    });
  });
});
