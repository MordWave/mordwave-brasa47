import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SafeUser } from '../src/auth/safe-user.js';
import { AuditLog } from '../src/audit/audit-log.entity.js';
import { Business } from '../src/business/business.entity.js';
import { BusinessLimitsService } from '../src/business/business-limits.service.js';
import { CategoryService } from '../src/category/category.service.js';
import { Category } from '../src/category/category.entity.js';
import { OrderItem } from '../src/order/order-item.entity.js';
import { Order } from '../src/order/order.entity.js';
import { ProductService } from '../src/product/product.service.js';
import { Product } from '../src/product/product.entity.js';
import { RestaurantTable } from '../src/table/table.entity.js';
import { TableSession } from '../src/table/table-session.entity.js';
import { User } from '../src/user/user.entity.js';
import { UserRole } from '../src/user/user-role.enum.js';
import { runAllMigrations } from './support/run-all-migrations.js';

// 9E.23 — categories and the products under them, against a REAL PostgreSQL server with INDEPENDENT connections (a pool), not PGlite
// (a single connection) and not mocks. OPT-IN: it runs only when REAL_PG_ADMIN_URL points at a LOCAL, disposable PostgreSQL
// (loopback only), e.g.
//
//   REAL_PG_ADMIN_URL=postgresql://user:pw@127.0.0.1:54351/postgres JWT_SECRET=... npm run test:e2e -- category-concurrency
//
// Without the variable the whole file is skipped. With it, the file creates its OWN throw-away database (e2e_category_<random>), runs
// every real migration in it, uses fictitious data and DROPs the database afterwards. It never touches any other database.
//
// How the interleaving is forced: a hook pauses a request right AFTER a given repository call returned (inside its transaction, so the
// locks it already holds stay held) until the test releases it, and `pending()` proves that the other request is really WAITING on a
// lock. The `legacy*` functions are the implementations before 9E.23 (check the state, then write, with no lock shared between the
// category and the product writers), kept here to show the defects on the old protocol. They exist only in this test file.
const ADMIN_URL = process.env.REAL_PG_ADMIN_URL;

function assertLoopback(raw: string): URL {
  const url = new URL(raw);
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) {
    throw new Error('REAL_PG_ADMIN_URL must point at a local PostgreSQL (127.0.0.1 / localhost); refusing to continue');
  }
  return url;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const gate = () => {
  let release!: () => void;
  let reach!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  const reached = new Promise<void>((resolve) => (reach = resolve));
  return { wait, release, reached, reach };
};
type Gate = ReturnType<typeof gate>;
// 'pending' if the promise has not settled after `ms`: it is waiting (for a lock)
const state = (p: Promise<unknown>, ms = 400) => Promise.race([p.then(() => 'settled', () => 'settled'), sleep(ms).then(() => 'pending')]);

type Outcome<T = unknown> = { ok: true; value: T } | { ok: false; status: number; code?: string };
const settle = <T,>(p: Promise<T>): Promise<Outcome<T>> =>
  p.then(
    (value): Outcome<T> => ({ ok: true, value }),
    (e: unknown): Outcome<T> => {
      const body = (e as { getResponse?: () => unknown }).getResponse?.();
      return { ok: false, status: (e as { getStatus?: () => number }).getStatus?.() ?? 0, code: (body as { errorCode?: string } | undefined)?.errorCode };
    },
  );

// A repository whose `method` pauses (once, at its `nth` call) AFTER returning its result, until the gate is released.
function gatedRepo<T extends object>(repository: T, method: string, g: Gate, nth = 1): T {
  let calls = 0;
  return new Proxy(repository, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (prop === method) {
        return async (...args: unknown[]) => {
          const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          calls += 1;
          if (calls === nth) {
            g.reach();
            await g.wait;
          }
          return result;
        };
      }
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

describe.skipIf(!ADMIN_URL)('Categories and the products under them under real concurrency (e2e, real local PostgreSQL, independent connections)', () => {
  let admin: DataSource;
  let ds: DataSource;
  let dbName: string;
  let bizA: Business;
  let bizB: Business;

  const adminA: SafeUser = { id: '00000000-0000-4000-8000-0000000000a1', email: 'a@real-pg.test', role: UserRole.ADMIN, businessId: '', active: true, mustChangePassword: false };
  const adminB: SafeUser = { id: '00000000-0000-4000-8000-0000000000b1', email: 'b@real-pg.test', role: UserRole.ADMIN, businessId: '', active: true, mustChangePassword: false };
  const superAdmin: SafeUser = { id: '00000000-0000-4000-8000-0000000000c1', email: 'super@real-pg.test', role: UserRole.SUPER_ADMIN, businessId: null, active: true, mustChangePassword: false };

  const cRepo = () => ds.getRepository(Category);
  const pRepo = () => ds.getRepository(Product);
  const limits = () => new BusinessLimitsService({ business: { product: 5000, category: 500, table: 200, user: 20 } } as never);
  const resolver = { resolve: async () => { throw new Error('unused'); } };
  const images = { upload: async () => { throw new Error('unused'); } };

  // A DataSource whose transactions hand out a manager whose repositories pause after the chosen call (the locks taken so far stay held).
  // `before`: pause BEFORE the call runs (e.g. before the INSERT of a product, with the category lock already held)
  type Hook = { entity: unknown; method: string; gate: Gate; nth?: number; before?: boolean };
  function hookedDataSource(hooks: Hook[]): DataSource {
    const calls = new Map<Hook, number>();
    const wrapRepo = (repo: object, entity: unknown) =>
      new Proxy(repo, {
        get(target, prop) {
          const value = Reflect.get(target, prop) as unknown;
          const hook = hooks.find((h) => h.entity === entity && h.method === prop);
          if (hook && typeof value === 'function') {
            return async (...args: unknown[]) => {
              const n = (calls.get(hook) ?? 0) + 1;
              calls.set(hook, n);
              const pause = async () => {
                if (n === (hook.nth ?? 1)) {
                  hook.gate.reach();
                  await hook.gate.wait;
                }
              };
              if (hook.before) await pause();
              const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
              if (!hook.before) await pause();
              return result;
            };
          }
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
    const wrapManager = (manager: object) =>
      new Proxy(manager, {
        get(target, prop) {
          if (prop === 'getRepository') return (entity: unknown) => wrapRepo((target as DataSource['manager']).getRepository(entity as never), entity);
          const value = Reflect.get(target, prop) as unknown;
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
    return new Proxy(ds, {
      get(target, prop) {
        if (prop === 'transaction') return (cb: (m: unknown) => unknown) => target.transaction((manager) => cb(wrapManager(manager)) as Promise<unknown>);
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  }

  const products = (hooks: Hook[] = [], productRepo = pRepo()) => new ProductService(productRepo, cRepo(), ds.getRepository(Business), images as never, resolver as never, hookedDataSource(hooks), limits());
  const categories = (hooks: Hook[] = [], categoryRepo = cRepo()) => new CategoryService(categoryRepo, ds.getRepository(Business), pRepo(), resolver as never, hookedDataSource(hooks), limits());

  let seq = 0;
  const newCategory = async (extra: Partial<Category> = {}, businessId = bizA.id) => {
    seq += 1;
    return cRepo().save(cRepo().create({ name: `Cat ${seq}`, slug: `cat-${seq}-${randomBytes(3).toString('hex')}`, businessId, ...extra }));
  };
  const newProduct = async (categoryId: string, extra: Partial<Product> = {}, businessId = bizA.id) => {
    seq += 1;
    return pRepo().save(pRepo().create({ name: `Prod ${seq}`, price: 1000, businessId, categoryId, ...extra }));
  };
  const crow = async (id: string) => (await ds.query(`SELECT name, slug, active, sort_order AS "sortOrder", deleted_at AS del, updated_at AS upd FROM categories WHERE id = $1`, [id]))[0] as { name: string; slug: string; active: boolean; sortOrder: number; del: Date | null; upd: Date };
  const prow = async (id: string) => (await ds.query(`SELECT active, category_id AS cat, business_id AS biz, deleted_at AS del FROM products WHERE id = $1`, [id]))[0] as { active: boolean; cat: string; biz: string; del: Date | null };
  // the invariants: no live product is active under an inactive category, and none is alive under a deleted one
  const violations = async () =>
    (await ds.query(
      `SELECT p.id, p.active AS pactive, c.active AS cactive, c.deleted_at AS cdel FROM products p JOIN categories c ON c.id = p.category_id
        WHERE p.deleted_at IS NULL AND ((p.active AND NOT c.active) OR c.deleted_at IS NOT NULL)`,
    )) as Array<{ id: string }>;
  const dto = (categoryId: string, extra: Record<string, unknown> = {}) => ({ name: `Nuevo ${++seq}`, price: 900, categoryId, ...extra });

  // ---- before 9E.23: check the state, then write; the category writers and the product writers share NO lock ----
  async function legacyDeactivate(categoryRepo: ReturnType<typeof cRepo>, productRepo: ReturnType<typeof pRepo>, id: string): Promise<Category> {
    const category = await categoryRepo.findOne({ where: { id } });
    if (!category) throw new Error('not found');
    const n = await productRepo.count({ where: { categoryId: id, active: true } });
    if (n > 0) throw new Error('has active products');
    category.active = false;
    return categoryRepo.save(category);
  }
  async function legacyRemove(categoryRepo: ReturnType<typeof cRepo>, productRepo: ReturnType<typeof pRepo>, id: string): Promise<void> {
    const category = await categoryRepo.findOne({ where: { id } });
    if (!category) throw new Error('not found');
    const n = await productRepo.count({ where: { categoryId: id } });
    if (n > 0) throw new Error('has products');
    await categoryRepo.softDelete(id);
  }
  async function legacyRename(categoryRepo: ReturnType<typeof cRepo>, id: string, name: string): Promise<Category> {
    const category = await categoryRepo.findOne({ where: { id } });
    if (!category) throw new Error('not found');
    Object.assign(category, { name });
    return categoryRepo.save(category);
  }
  // the product writer before 9E.23: reads the category with NO lock, then inserts
  async function legacyCreateProduct(categoryId: string, businessId: string): Promise<Product> {
    const category = await cRepo().findOne({ where: { id: categoryId } });
    if (!category || !category.active) throw new Error('category unavailable');
    return pRepo().save(pRepo().create({ name: `Legacy ${++seq}`, price: 900, businessId, categoryId }));
  }

  beforeAll(async () => {
    const base = assertLoopback(ADMIN_URL as string);
    dbName = `e2e_category_${randomBytes(6).toString('hex')}`;
    admin = new DataSource({ type: 'postgres', url: base.toString(), entities: [] });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const own = new URL(base.toString());
    own.pathname = `/${dbName}`;
    ds = new DataSource({ type: 'postgres', url: own.toString(), entities: [Business, Category, Product, User, Order, OrderItem, RestaurantTable, TableSession, AuditLog], extra: { max: 40 } });
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

  describe('the defects, reproduced with the protocol before 9E.23', () => {
    it('A. a rename (read, assign, save) puts back the `active` another admin switched off', async () => {
      const c = await newCategory({ name: 'Burgers' });
      const g = gate();
      const slow = settle(legacyRename(gatedRepo(cRepo(), 'findOne', g), c.id, 'Hamburguesas'));
      await g.reached;
      await categories().update(c.id, { active: false }, adminA);
      expect((await crow(c.id)).active).toBe(false);
      g.release();
      expect((await slow).ok).toBe(true);
      expect(await crow(c.id)).toMatchObject({ name: 'Hamburguesas', active: true }); // the deactivation was undone
    });

    it('B1. product creation vs deactivation: the category is deactivated AFTER the product writer saw it active -> an active product under an inactive category', async () => {
      const c = await newCategory();
      const g = gate();
      const deactivate = settle(legacyDeactivate(cRepo(), gatedRepo(pRepo(), 'count', g), c.id)); // counted 0 products, not yet written
      await g.reached;
      expect((await settle(legacyCreateProduct(c.id, bizA.id))).ok).toBe(true); // sees the category active
      g.release();
      expect((await deactivate).ok).toBe(true);
      expect((await violations()).length).toBeGreaterThan(0);
      await ds.query(`UPDATE products SET deleted_at = now() WHERE category_id = $1`, [c.id]); // clean up for the next scenarios
    });

    it('B2. product creation vs deletion of the category: a live product under a deleted category', async () => {
      const c = await newCategory();
      const g = gate();
      const remove = settle(legacyRemove(cRepo(), gatedRepo(pRepo(), 'count', g), c.id));
      await g.reached;
      expect((await settle(legacyCreateProduct(c.id, bizA.id))).ok).toBe(true);
      g.release();
      expect((await remove).ok).toBe(true);
      expect((await violations()).length).toBeGreaterThan(0);
      await ds.query(`UPDATE products SET deleted_at = now() WHERE category_id = $1`, [c.id]);
    });
  });

  describe('PATCH of a category (column-scoped, under the category lock)', () => {
    it('1. a rename does not undo a concurrent deactivation, in either order', async () => {
      for (const renameFirst of [false, true]) {
        const c = await newCategory({ name: 'Burgers' });
        const g = gate();
        const rename = settle(categories([], gatedRepo(cRepo(), 'findOne', g)).update(c.id, { name: 'Hamburguesas' }, adminA));
        await g.reached; // read, nothing written
        if (renameFirst) {
          g.release();
          await rename;
          await categories().update(c.id, { active: false }, adminA);
        } else {
          await categories().update(c.id, { active: false }, adminA);
          g.release();
          expect((await rename).ok).toBe(true);
        }
        expect(await crow(c.id)).toMatchObject({ name: 'Hamburguesas', active: false });
      }
    });

    it('2. two PATCH of DIFFERENT columns keep both, with a pause and in 60 natural rounds; the same column is last-writer-wins', async () => {
      const c = await newCategory({ name: 'Burgers' });
      const g = gate();
      const slow = settle(categories([], gatedRepo(cRepo(), 'findOne', g)).update(c.id, { name: 'A' }, adminA));
      await g.reached;
      await categories().update(c.id, { sortOrder: 5, active: false }, adminA);
      g.release();
      await slow;
      expect(await crow(c.id)).toMatchObject({ name: 'A', sortOrder: 5, active: false });

      const n = await newCategory();
      let lost = 0;
      for (let i = 0; i < 60; i++) {
        const name = `N${i}`;
        const [a, b] = await Promise.all([settle(categories().update(n.id, { name }, adminA)), settle(categories().update(n.id, { sortOrder: i + 1 }, adminA))]);
        const r = await crow(n.id);
        if (!a.ok || !b.ok || r.name !== name || r.sortOrder !== i + 1) lost += 1;
      }
      expect(lost).toBe(0);

      const same = await newCategory({ sortOrder: 1 });
      const g2 = gate();
      const first = settle(categories([], gatedRepo(cRepo(), 'findOne', g2)).update(same.id, { sortOrder: 2, name: 'Z' }, adminA));
      await g2.reached;
      await categories().update(same.id, { sortOrder: 3 }, adminA); // commits first
      g2.release();
      await first; // commits last
      expect(await crow(same.id)).toMatchObject({ sortOrder: 2, name: 'Z' });
    });

    it('PATCH of a category deleted meanwhile: 404, it stays deleted and nothing is written', async () => {
      const c = await newCategory();
      const g = gate();
      const slow = settle(categories([], gatedRepo(cRepo(), 'findOne', g)).update(c.id, { name: 'x' }, adminA));
      await g.reached;
      await categories().remove(c.id, adminA);
      const stamp = (await crow(c.id)).upd.getTime();
      g.release();
      expect(await slow).toMatchObject({ ok: false, status: 404 });
      const after = await crow(c.id);
      expect(after.del).not.toBeNull();
      expect(after.name).toBe(c.name);
      expect(after.upd.getTime()).toBe(stamp);
    });
  });

  describe('deactivating / deleting a category vs the product writers (FOR UPDATE vs FOR SHARE)', () => {
    it('3. a product cannot be created in, reactivated into or moved into an INACTIVE category (409), nor into a DELETED one (404)', async () => {
      const inactive = await newCategory({ active: false });
      const deleted = await newCategory();
      await categories().remove(deleted.id, adminA);
      const other = await newCategory();
      const p = await newProduct(other.id, { active: false });
      const q = await newProduct(other.id);

      expect(await settle(products().create(dto(inactive.id), adminA))).toMatchObject({ ok: false, status: 409 });
      expect(await settle(products().create(dto(deleted.id), adminA))).toMatchObject({ ok: false, status: 404 });
      expect(await settle(products().update(q.id, { categoryId: inactive.id }, adminA))).toMatchObject({ ok: false, status: 409 });
      expect(await settle(products().update(q.id, { categoryId: deleted.id }, adminA))).toMatchObject({ ok: false, status: 404 });
      await ds.query(`UPDATE categories SET active = false WHERE id = $1`, [other.id]);
      await ds.query(`UPDATE products SET active = false WHERE category_id = $1`, [other.id]);
      expect(await settle(products().update(p.id, { active: true }, adminA))).toMatchObject({ ok: false, status: 409 });
      expect(await violations()).toHaveLength(0);
    });

    it('4a. CREATE vs DEACTIVATE, the category writer holds the lock: the product creation WAITS and is then refused (409); no inconsistent state', async () => {
      const c = await newCategory();
      const g = gate();
      const deactivate = settle(categories([{ entity: Product, method: 'count', gate: g }]).update(c.id, { active: false }, adminA)); // counted 0, holds FOR UPDATE
      await g.reached;
      const create = settle(products().create(dto(c.id), adminA));
      expect(await state(create)).toBe('pending'); // really waiting for the category lock
      g.release();
      expect((await deactivate).ok).toBe(true);
      expect(await create).toMatchObject({ ok: false, status: 409 });
      expect(await violations()).toHaveLength(0);
      expect((await crow(c.id)).active).toBe(false);
    });

    it('4b. CREATE vs DEACTIVATE, the product writer holds the lock: the deactivation WAITS, then counts the new product and is refused (409 CATEGORY_HAS_ACTIVE_PRODUCTS)', async () => {
      const c = await newCategory();
      const g = gate();
      const create = settle(products([{ entity: Product, method: 'save', gate: g, before: true }]).create(dto(c.id), adminA)); // holds FOR SHARE, not yet inserted
      await g.reached;
      const deactivate = settle(categories().update(c.id, { active: false }, adminA));
      expect(await state(deactivate)).toBe('pending');
      g.release();
      expect((await create).ok).toBe(true);
      expect(await deactivate).toMatchObject({ ok: false, status: 409, code: 'CATEGORY_HAS_ACTIVE_PRODUCTS' });
      expect(await violations()).toHaveLength(0);
      expect((await crow(c.id)).active).toBe(true);
    });

    it('5a. REACTIVATE a product vs DEACTIVATE its category: the category lock is held by the product writer, so the deactivation waits and is then refused', async () => {
      const c = await newCategory();
      const p = await newProduct(c.id, { active: false });
      const g = gate();
      const reactivate = settle(products([{ entity: Category, method: 'findOne', gate: g }]).update(p.id, { active: true }, adminA)); // locked the category FOR SHARE
      await g.reached;
      const deactivate = settle(categories().update(c.id, { active: false }, adminA));
      expect(await state(deactivate)).toBe('pending');
      g.release();
      expect((await reactivate).ok).toBe(true);
      expect(await deactivate).toMatchObject({ ok: false, status: 409, code: 'CATEGORY_HAS_ACTIVE_PRODUCTS' });
      expect(await violations()).toHaveLength(0);
    });

    it('5b. REACTIVATE a product vs DEACTIVATE its category, the category writer first: the reactivation waits and is then refused (409)', async () => {
      const c = await newCategory();
      const p = await newProduct(c.id, { active: false });
      const g = gate();
      const deactivate = settle(categories([{ entity: Product, method: 'count', gate: g }]).update(c.id, { active: false }, adminA)); // no active product yet
      await g.reached;
      const reactivate = settle(products().update(p.id, { active: true }, adminA));
      expect(await state(reactivate)).toBe('pending');
      g.release();
      expect((await deactivate).ok).toBe(true);
      expect(await reactivate).toMatchObject({ ok: false, status: 409 });
      expect((await prow(p.id)).active).toBe(false);
      expect(await violations()).toHaveLength(0);
    });

    it('6a. MOVE a product into a category that is being DELETED (category writer first): the move waits and is refused (404); the product stays where it was', async () => {
      const from = await newCategory();
      const target = await newCategory();
      const p = await newProduct(from.id);
      const g = gate();
      const remove = settle(categories([{ entity: Product, method: 'count', gate: g }]).remove(target.id, adminA));
      await g.reached;
      const move = settle(products().update(p.id, { categoryId: target.id }, adminA));
      expect(await state(move)).toBe('pending');
      g.release();
      expect((await remove).ok).toBe(true);
      expect(await move).toMatchObject({ ok: false, status: 404 });
      expect((await prow(p.id)).cat).toBe(from.id);
      expect(await violations()).toHaveLength(0);
    });

    it('6b. MOVE a product into a category that is being DELETED (move first): the deletion waits, counts the product and is refused (409 CATEGORY_HAS_PRODUCTS)', async () => {
      const from = await newCategory();
      const target = await newCategory();
      const p = await newProduct(from.id);
      const g = gate();
      const move = settle(products([{ entity: Category, method: 'findOne', gate: g }]).update(p.id, { categoryId: target.id }, adminA));
      await g.reached;
      const remove = settle(categories().remove(target.id, adminA));
      expect(await state(remove)).toBe('pending');
      g.release();
      expect((await move).ok).toBe(true);
      expect(await remove).toMatchObject({ ok: false, status: 409, code: 'CATEGORY_HAS_PRODUCTS' });
      expect((await prow(p.id)).cat).toBe(target.id);
      expect((await crow(target.id)).del).toBeNull();
      expect(await violations()).toHaveLength(0);
    });

    it('6c. a SUPER_ADMIN MOVE to ANOTHER business (destination category) vs the deletion of that category: serialized, no live product under a deleted category', async () => {
      const src = await newCategory();
      const dest = await newCategory({}, bizB.id);
      const p = await newProduct(src.id);
      const g = gate();
      const remove = settle(categories([{ entity: Product, method: 'count', gate: g }]).remove(dest.id, adminB));
      await g.reached;
      const move = settle(products().update(p.id, { businessId: bizB.id, categoryId: dest.id }, superAdmin));
      expect(await state(move)).toBe('pending');
      g.release();
      expect((await remove).ok).toBe(true);
      expect(await move).toMatchObject({ ok: false, status: 404 });
      expect((await prow(p.id)).biz).toBe(bizA.id);
      expect(await violations()).toHaveLength(0);

      // and when the move wins, the deletion is refused
      const dest2 = await newCategory({}, bizB.id);
      const q = await newProduct(src.id);
      const g2 = gate();
      const move2 = settle(products([{ entity: Category, method: 'findOne', gate: g2 }]).update(q.id, { businessId: bizB.id, categoryId: dest2.id }, superAdmin));
      await g2.reached;
      const remove2 = settle(categories().remove(dest2.id, adminB));
      expect(await state(remove2)).toBe('pending');
      g2.release();
      expect((await move2).ok).toBe(true);
      expect(await remove2).toMatchObject({ ok: false, status: 409, code: 'CATEGORY_HAS_PRODUCTS' });
      expect(await prow(q.id)).toMatchObject({ biz: bizB.id, cat: dest2.id });
      expect(await violations()).toHaveLength(0);
    });

    it('7a. DELETE a category vs CREATE a product (category writer first): the creation waits and is refused (404), nothing is created', async () => {
      const c = await newCategory();
      const g = gate();
      const remove = settle(categories([{ entity: Product, method: 'count', gate: g }]).remove(c.id, adminA));
      await g.reached;
      const create = settle(products().create(dto(c.id), adminA));
      expect(await state(create)).toBe('pending');
      g.release();
      expect((await remove).ok).toBe(true);
      expect(await create).toMatchObject({ ok: false, status: 404 });
      expect((await ds.query(`SELECT count(*)::int AS n FROM products WHERE category_id = $1`, [c.id]))[0].n).toBe(0);
      expect(await violations()).toHaveLength(0);
    });

    it('7b. DELETE a category vs CREATE a product (product writer first): the deletion waits, counts the product and is refused (409)', async () => {
      const c = await newCategory();
      const g = gate();
      const create = settle(products([{ entity: Product, method: 'save', gate: g, before: true }]).create(dto(c.id), adminA));
      await g.reached;
      const remove = settle(categories().remove(c.id, adminA));
      expect(await state(remove)).toBe('pending');
      g.release();
      expect((await create).ok).toBe(true);
      expect(await remove).toMatchObject({ ok: false, status: 409, code: 'CATEGORY_HAS_PRODUCTS' });
      expect((await crow(c.id)).del).toBeNull();
      expect(await violations()).toHaveLength(0);
    });

    it('two product writers on the SAME category do not wait for one another (FOR SHARE is compatible with FOR SHARE)', async () => {
      // (two CREATEs of one business do serialize, but on the Business row lock of the per-business quota, which pre-dates this protocol)
      const c = await newCategory();
      const first = await newProduct(c.id, { active: false });
      const second = await newProduct(c.id, { active: false });
      const g = gate();
      const held = settle(products([{ entity: Category, method: 'findOne', gate: g }]).update(first.id, { active: true }, adminA)); // holds FOR SHARE
      try {
        await g.reached;
        const other = settle(products().update(second.id, { active: true }, adminA));
        expect(await state(other)).toBe('settled'); // a second sharer is not blocked by the first
        expect((await other).ok).toBe(true);
      } finally {
        g.release();
      }
      expect((await held).ok).toBe(true);
      expect(await violations()).toHaveLength(0);
    });

    it('reactivating a category, and deactivating an already-inactive one, never wait for or break the product side', async () => {
      const c = await newCategory({ active: false });
      expect((await settle(categories().update(c.id, { active: true }, adminA))).ok).toBe(true);
      expect((await settle(products().create(dto(c.id), adminA))).ok).toBe(true);
      expect(await violations()).toHaveLength(0);
    });
  });

  describe('isolation, permissions and rejected operations', () => {
    it('8/9. an ADMIN of another business is refused (403) on PATCH and DELETE with nothing written; a SUPER_ADMIN may do both', async () => {
      const c = await newCategory({ name: 'Burgers' });
      const stamp = (await crow(c.id)).upd.getTime();
      expect(await settle(categories().update(c.id, { name: 'x' }, adminB))).toMatchObject({ ok: false, status: 403 });
      expect(await settle(categories().remove(c.id, adminB))).toMatchObject({ ok: false, status: 403 });
      expect((await crow(c.id)).upd.getTime()).toBe(stamp);
      expect((await settle(categories().update(c.id, { name: 'Por SUPER' }, superAdmin))).ok).toBe(true);
      expect((await settle(categories().remove(c.id, superAdmin))).ok).toBe(true);
      expect((await crow(c.id)).del).not.toBeNull();
    });

    it('10. a refused operation leaves the rows (and their updated_at) exactly as they were', async () => {
      const c = await newCategory();
      const p = await newProduct(c.id);
      const stamp = (await crow(c.id)).upd.getTime();
      expect(await settle(categories().update(c.id, { active: false }, adminA))).toMatchObject({ ok: false, status: 409, code: 'CATEGORY_HAS_ACTIVE_PRODUCTS' });
      expect(await settle(categories().remove(c.id, adminA))).toMatchObject({ ok: false, status: 409, code: 'CATEGORY_HAS_PRODUCTS' });
      expect(await settle(categories().update('00000000-0000-4000-8000-000000000000', { name: 'x' }, adminA))).toMatchObject({ ok: false, status: 404 });
      const after = await crow(c.id);
      expect(after.upd.getTime()).toBe(stamp);
      expect(after.active).toBe(true);
      expect((await prow(p.id)).del).toBeNull();
    });
  });

  describe('no deadlocks and no broken invariants under repeated mixed concurrency', () => {
    it('11. 150 rounds of random simultaneous operations on one category: no 5xx, no deadlock, the invariants hold after every round', async () => {
      const pick = <T,>(items: T[]) => items[Math.floor(Math.random() * items.length)]!;
      let unexpected = 0;
      let broken = 0;
      for (let round = 0; round < 150; round++) {
        const target = await newCategory();
        const source = await newCategory();
        const live = await newProduct(source.id);
        const idle = await newProduct(source.id, { active: false });
        const ops: Array<() => Promise<unknown>> = [
          () => products().create(dto(target.id), adminA),
          () => products().create(dto(target.id), adminA),
          () => products().update(idle.id, { categoryId: target.id, active: true }, adminA),
          () => products().update(live.id, { categoryId: target.id }, adminA),
          () => products().update(live.id, { active: false }, adminA),
          () => categories().update(target.id, { active: false }, adminA),
          () => categories().update(target.id, { name: `r${round}` }, adminA),
          () => categories().update(target.id, { active: true }, adminA),
          () => categories().remove(target.id, adminA),
          () => categories().remove(source.id, adminA),
          () => categories().update(source.id, { active: false }, adminA),
        ];
        const chosen = Array.from({ length: 6 }, () => pick(ops));
        const results = await Promise.all(chosen.map((op) => settle(op())));
        for (const r of results) if (!r.ok && (r.status < 400 || r.status >= 500)) unexpected += 1;
        if ((await violations()).length > 0) broken += 1;
      }
      expect(unexpected).toBe(0); // a deadlock would surface as a 500 (SQLSTATE 40P01)
      expect(broken).toBe(0);
    }, 120_000);
  });

  describe('the product fixes of PR #65 keep working next to the category lock', () => {
    it('a PATCH of a product, an image change and a deletion still write column-scoped and never revive a deleted product', async () => {
      const c = await newCategory();
      const p = await newProduct(c.id, { description: 'base', price: 1000 });
      const svc = products();
      await svc.update(p.id, { price: 1500 }, adminA);
      await svc.update(p.id, { description: 'nueva' }, adminA);
      expect(await ds.query(`SELECT price, description FROM products WHERE id = $1`, [p.id])).toEqual([{ price: 1500, description: 'nueva' }]);

      const g = gate();
      const slow = settle(products([], gatedRepo(pRepo(), 'findOne', g)).update(p.id, { description: 'tarde' }, adminA));
      await g.reached;
      await svc.remove(p.id, adminA);
      g.release();
      expect(await slow).toMatchObject({ ok: false, status: 404 });
      expect((await prow(p.id)).del).not.toBeNull();
    });
  });
});
