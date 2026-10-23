import { randomBytes } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SafeUser } from '../src/auth/safe-user.js';
import { AuditLog } from '../src/audit/audit-log.entity.js';
import { Business } from '../src/business/business.entity.js';
import { Category } from '../src/category/category.entity.js';
import { OrderItem } from '../src/order/order-item.entity.js';
import { Order } from '../src/order/order.entity.js';
import { OrderService } from '../src/order/order.service.js';
import { OrderStatus } from '../src/order/order-status.enum.js';
import { Product } from '../src/product/product.entity.js';
import { RestaurantTable } from '../src/table/table.entity.js';
import { TableSession } from '../src/table/table-session.entity.js';
import { TableSessionStatus } from '../src/table/table-session-status.enum.js';
import { User } from '../src/user/user.entity.js';
import { UserRole } from '../src/user/user-role.enum.js';
import { runAllMigrations } from './support/run-all-migrations.js';

// 9E.20 — the race in OrderService.updateStatus, reproduced against a REAL PostgreSQL server with INDEPENDENT connections (a pool),
// not PGlite (a single connection) and not mocks. OPT-IN: it runs only when REAL_PG_ADMIN_URL points at a LOCAL, disposable
// PostgreSQL (loopback only), e.g.
//
//   REAL_PG_ADMIN_URL=postgresql://user:pw@127.0.0.1:54351/postgres JWT_SECRET=... npm run test:e2e -- order-status-concurrency
//
// Without the variable the whole file is skipped. With it, the file creates its OWN throw-away database (e2e_order_status_<random>),
// runs every real migration in it, uses fictitious data and DROPs the database afterwards. It never touches any other database.
//
// How the interleaving is forced: the repository's `findOne` is wrapped so that, after it returned its row, the request pauses
// until released. Two requests are therefore both holding "NEW" when either one writes — the exact window of the defect.
// `legacyUpdateStatus` below is the implementation of main 01aaf0e (findOne -> assign -> save()), kept here so that the same
// harness shows the defect on the old code and its absence on the new one.
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

// A repository whose findOne pauses (once) AFTER returning its result, until the gate is released.
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

describe.skipIf(!ADMIN_URL)('OrderService.updateStatus under real concurrency (e2e, real local PostgreSQL, independent connections)', () => {
  let admin: DataSource;
  let ds: DataSource;
  let dbName: string;

  let bizA: Business;
  let bizB: Business;
  let tableA: RestaurantTable;
  let sessionA: TableSession;
  let sessionB: TableSession;

  const adminA: SafeUser = { id: '00000000-0000-4000-8000-0000000000a1', email: 'a@real-pg.test', role: UserRole.ADMIN, businessId: '', active: true, mustChangePassword: false };
  const adminB: SafeUser = { id: '00000000-0000-4000-8000-0000000000b1', email: 'b@real-pg.test', role: UserRole.ADMIN, businessId: '', active: true, mustChangePassword: false };
  const superAdmin: SafeUser = { id: '00000000-0000-4000-8000-0000000000c1', email: 'super@real-pg.test', role: UserRole.SUPER_ADMIN, businessId: null, active: true, mustChangePassword: false };

  const orderRepo = () => ds.getRepository(Order);
  const service = (repo = orderRepo()) => new OrderService(repo, ds.getRepository(TableSession), ds);
  let seq = 0;
  const newOrder = async (businessId: string, sessionId: string, extra: Partial<Order> = {}) => {
    seq += 1;
    return orderRepo().save(orderRepo().create({ businessId, clientRequestId: `req-${seq}-${Date.now()}`, table: 'Mesa 1', tableSessionId: sessionId, total: 1000, note: 'sin cebolla', status: OrderStatus.NEW, ...extra }));
  };
  const row = async (id: string) =>
    (await ds.query(`SELECT status, note, total, "table", business_id AS biz, table_session_id AS sess, client_request_id AS crid, order_number AS num, updated_at AS upd FROM orders WHERE id = $1`, [id]))[0] as {
      status: string; note: string | null; total: number; table: string; biz: string; sess: string; crid: string; num: number; upd: Date;
    };
  type Outcome = { ok: true; status: string } | { ok: false; status: number; code?: string; message: string };
  const settle = (p: Promise<Order>): Promise<Outcome> =>
    p.then(
      (o): Outcome => ({ ok: true, status: o.status }),
      (e: unknown): Outcome => {
        const body = e instanceof ConflictException ? (e.getResponse() as { errorCode?: string; message?: string }) : {};
        return { ok: false, status: (e as { getStatus?: () => number }).getStatus?.() ?? 0, code: body.errorCode, message: (e as Error).message };
      },
    );

  // main 01aaf0e: findOne (with items) -> check NEW -> assign -> save() of the whole stale entity
  async function legacyUpdateStatus(repo: ReturnType<typeof orderRepo>, id: string, status: OrderStatus.DELIVERED | OrderStatus.CANCELLED): Promise<Order> {
    const order = await repo.findOne({ where: { id }, relations: { items: true } });
    if (!order) throw new Error('not found');
    if (order.status !== OrderStatus.NEW) throw new ConflictException({ errorCode: 'INVALID_ORDER_TRANSITION' });
    order.status = status;
    return repo.save(order);
  }

  beforeAll(async () => {
    const base = assertLoopback(ADMIN_URL as string);
    dbName = `e2e_order_status_${randomBytes(6).toString('hex')}`;
    admin = new DataSource({ type: 'postgres', url: base.toString(), entities: [] });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const own = new URL(base.toString());
    own.pathname = `/${dbName}`;
    ds = new DataSource({ type: 'postgres', url: own.toString(), entities: [Business, Category, Product, User, Order, OrderItem, RestaurantTable, TableSession, AuditLog], extra: { max: 20 } });
    await ds.initialize();
    const server = (await ds.query(`SHOW server_version`))[0].server_version as string;
    expect(Number(server.split('.')[0])).toBeGreaterThanOrEqual(18);
    await runAllMigrations(ds);

    const bRepo = ds.getRepository(Business);
    bizA = await bRepo.save(bRepo.create({ name: 'Real PG A', slug: 'real-pg-a' }));
    bizB = await bRepo.save(bRepo.create({ name: 'Real PG B', slug: 'real-pg-b' }));
    adminA.businessId = bizA.id;
    adminB.businessId = bizB.id;
    const tRepo = ds.getRepository(RestaurantTable);
    tableA = await tRepo.save(tRepo.create({ businessId: bizA.id, name: 'Mesa 1', qrToken: 'qr-real-pg-a' }));
    const tableB = await tRepo.save(tRepo.create({ businessId: bizB.id, name: 'Mesa 1', qrToken: 'qr-real-pg-b' }));
    const sRepo = ds.getRepository(TableSession);
    sessionA = await sRepo.save(sRepo.create({ tableId: tableA.id, businessId: bizA.id, sessionToken: 'sess-real-pg-a', status: TableSessionStatus.OPEN }));
    sessionB = await sRepo.save(sRepo.create({ tableId: tableB.id, businessId: bizB.id, sessionToken: 'sess-real-pg-b', status: TableSessionStatus.OPEN }));
  }, 120_000);

  afterAll(async () => {
    try {
      await ds?.destroy();
      if (admin?.isInitialized && dbName) await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    } finally {
      await admin?.destroy();
    }
  });

  const target = (who: 'A' | 'B') => (who === 'A' ? OrderStatus.DELIVERED : OrderStatus.CANCELLED) as OrderStatus.DELIVERED | OrderStatus.CANCELLED;

  // Two requests that both read NEW before either writes; `firstToWrite` is released first. A asks DELIVERED, B asks CANCELLED
  // (or both ask DELIVERED when `sameTarget`). `run` is the implementation under test.
  async function race(
    run: (repo: ReturnType<typeof orderRepo>, id: string, status: OrderStatus.DELIVERED | OrderStatus.CANCELLED, who: 'A' | 'B') => Promise<Order>,
    firstToWrite: 'A' | 'B',
    sameTarget = false,
    extra: Partial<Order> = {},
    betweenReadAndWrite?: (id: string) => Promise<void>,
  ) {
    const order = await newOrder(bizA.id, sessionA.id, extra);
    const gA = gate(), gB = gate();
    const status = (who: 'A' | 'B') => (sameTarget ? OrderStatus.DELIVERED : target(who));
    const a = settle(run(gatedRepo(orderRepo(), gA), order.id, status('A'), 'A'));
    const b = settle(run(gatedRepo(orderRepo(), gB), order.id, status('B'), 'B'));
    await Promise.all([gA.reached, gB.reached]);
    if (betweenReadAndWrite) await betweenReadAndWrite(order.id);
    const gates = { A: gA, B: gB } as const;
    const second = firstToWrite === 'A' ? 'B' : 'A';
    gates[firstToWrite].release();
    const first = await (firstToWrite === 'A' ? a : b);
    const afterFirst = await row(order.id);
    gates[second].release();
    const late = await (second === 'A' ? a : b);
    return { id: order.id, first, late, afterFirst: afterFirst.status, final: await row(order.id) };
  }

  const legacy = (repo: ReturnType<typeof orderRepo>, id: string, status: OrderStatus.DELIVERED | OrderStatus.CANCELLED) => legacyUpdateStatus(repo, id, status);
  const fixed = (repo: ReturnType<typeof orderRepo>, id: string, status: OrderStatus.DELIVERED | OrderStatus.CANCELLED) => service(repo).updateStatus(id, { status }, adminA);

  describe('the defect, reproduced with the implementation of main 01aaf0e1 (findOne -> assign -> save)', () => {
    it('DELIVERED and CANCELLED at once: both are told "ok" and the terminal state of the first is overwritten', async () => {
      const r = await race(legacy, 'A');
      expect(r.first).toEqual({ ok: true, status: 'DELIVERED' });
      expect(r.afterFirst).toBe('DELIVERED');
      expect(r.late).toEqual({ ok: true, status: 'CANCELLED' }); // false success
      expect(r.final.status).toBe('CANCELLED'); // a delivered order is now cancelled
    });

    it('a column changed by someone else between the read and the write is restored to its old value', async () => {
      const r = await race(legacy, 'A', false, { note: 'sin cebolla' }, async (id) => {
        await ds.query(`UPDATE orders SET note = 'con alergia a los frutos secos' WHERE id = $1`, [id]);
      });
      expect(r.final.note).toBe('sin cebolla'); // the allergy note was silently reverted
    });
  });

  describe('the corrected implementation (one conditional UPDATE ... WHERE status = NEW)', () => {
    it('DELIVERED wins when it writes first: CANCELLED gets 409 INVALID_ORDER_TRANSITION and the order stays DELIVERED', async () => {
      const r = await race(fixed, 'A');
      expect(r.first).toEqual({ ok: true, status: 'DELIVERED' });
      expect(r.late).toMatchObject({ ok: false, status: 409, code: 'INVALID_ORDER_TRANSITION' });
      expect((r.late as { message: string }).message).toContain('cannot move from DELIVERED to CANCELLED');
      expect(r.final.status).toBe('DELIVERED');
    });

    it('same scenario, order of execution reversed: CANCELLED wins, DELIVERED gets 409, the order stays CANCELLED', async () => {
      const r = await race(fixed, 'B');
      expect(r.first).toEqual({ ok: true, status: 'CANCELLED' });
      expect(r.late).toMatchObject({ ok: false, status: 409, code: 'INVALID_ORDER_TRANSITION' });
      expect((r.late as { message: string }).message).toContain('cannot move from CANCELLED to DELIVERED');
      expect(r.final.status).toBe('CANCELLED');
    });

    it('two requests for the SAME transition: exactly one confirms, the other is a 409 (no double confirmation)', async () => {
      const r = await race(fixed, 'A', true);
      expect(r.first).toEqual({ ok: true, status: 'DELIVERED' });
      expect(r.late).toMatchObject({ ok: false, status: 409, code: 'INVALID_ORDER_TRANSITION' });
      expect(r.final.status).toBe('DELIVERED');
    });

    it('natural concurrency (no pausing), 60 rounds of DELIVERED vs CANCELLED: always exactly one winner, and the order ends in the winner\'s state', async () => {
      let bad = 0;
      for (let i = 0; i < 60; i++) {
        const order = await newOrder(bizA.id, sessionA.id);
        const [a, b] = await Promise.all([settle(fixed(orderRepo(), order.id, OrderStatus.DELIVERED)), settle(fixed(orderRepo(), order.id, OrderStatus.CANCELLED))]);
        const winners = [a, b].filter((x) => x.ok);
        const losers = [a, b].filter((x) => !x.ok);
        const final = (await row(order.id)).status;
        if (winners.length !== 1 || losers.length !== 1 || (winners[0] as { status: string }).status !== final || (losers[0] as { status: number }).status !== 409) bad += 1;
      }
      expect(bad).toBe(0);
    });

    it('a column changed by someone else between the read and the write is NOT touched (only status is written)', async () => {
      const r = await race(fixed, 'A', false, { note: 'sin cebolla' }, async (id) => {
        await ds.query(`UPDATE orders SET note = 'con alergia a los frutos secos' WHERE id = $1`, [id]);
      });
      expect(r.first).toEqual({ ok: true, status: 'DELIVERED' });
      expect(r.final.note).toBe('con alergia a los frutos secos');
    });

    it('nothing but status (and updated_at) changes: total, table, note, session, client request id and order number are exactly as they were', async () => {
      const order = await newOrder(bizA.id, sessionA.id);
      const before = await row(order.id);
      const done = await service().updateStatus(order.id, { status: OrderStatus.DELIVERED }, adminA);
      const after = await row(order.id);
      expect({ ...after, status: before.status, upd: before.upd }).toEqual(before);
      expect(after.status).toBe('DELIVERED');
      expect(after.upd.getTime()).toBeGreaterThanOrEqual(before.upd.getTime());
      expect(done).toMatchObject({ id: order.id, status: 'DELIVERED', businessId: bizA.id, total: 1000 });
      expect(Array.isArray(done.items)).toBe(true); // the answer keeps its shape, items included
    });

    it('a valid transition without concurrency works for both targets; a terminal order refuses every further transition with 409', async () => {
      const delivered = await newOrder(bizA.id, sessionA.id);
      const cancelled = await newOrder(bizA.id, sessionA.id);
      expect(await settle(fixed(orderRepo(), delivered.id, OrderStatus.DELIVERED))).toEqual({ ok: true, status: 'DELIVERED' });
      expect(await settle(fixed(orderRepo(), cancelled.id, OrderStatus.CANCELLED))).toEqual({ ok: true, status: 'CANCELLED' });
      for (const [id, from, to] of [
        [delivered.id, 'DELIVERED', OrderStatus.CANCELLED],
        [delivered.id, 'DELIVERED', OrderStatus.DELIVERED],
        [cancelled.id, 'CANCELLED', OrderStatus.DELIVERED],
        [cancelled.id, 'CANCELLED', OrderStatus.CANCELLED],
      ] as const) {
        const out = await settle(fixed(orderRepo(), id, to));
        expect(out).toMatchObject({ ok: false, status: 409, code: 'INVALID_ORDER_TRANSITION' });
        expect((out as { message: string }).message).toContain(`cannot move from ${from} to ${to}`);
        expect((await row(id)).status).toBe(from);
      }
    });

    it('isolation: an ADMIN of another restaurant gets 403 and nothing changes; an unknown order is a 404; other orders are untouched', async () => {
      const mine = await newOrder(bizA.id, sessionA.id);
      const sibling = await newOrder(bizA.id, sessionA.id);
      const other = await newOrder(bizB.id, sessionB.id);

      const foreign = await settle(service().updateStatus(mine.id, { status: OrderStatus.CANCELLED }, adminB));
      expect(foreign).toMatchObject({ ok: false, status: 403 });
      expect((await row(mine.id)).status).toBe('NEW');

      const unknown = await settle(service().updateStatus('00000000-0000-4000-8000-000000000000', { status: OrderStatus.CANCELLED }, adminA));
      expect(unknown).toMatchObject({ ok: false, status: 404 });

      expect(await settle(service().updateStatus(mine.id, { status: OrderStatus.DELIVERED }, adminA))).toEqual({ ok: true, status: 'DELIVERED' });
      expect((await row(sibling.id)).status).toBe('NEW');
      expect((await row(other.id)).status).toBe('NEW');

      // a SUPER_ADMIN may act on any restaurant, and still only on that order
      expect(await settle(service().updateStatus(other.id, { status: OrderStatus.CANCELLED }, superAdmin))).toEqual({ ok: true, status: 'CANCELLED' });
      expect((await row(sibling.id)).status).toBe('NEW');
    });

    it('a request that lost the race writes nothing at all: the row\'s updated_at is the winner\'s', async () => {
      const r = await race(fixed, 'A');
      const stamp = (await row(r.id)).upd.getTime();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect((await row(r.id)).upd.getTime()).toBe(stamp);
    });
  });
});
