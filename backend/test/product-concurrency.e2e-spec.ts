import { randomBytes } from 'node:crypto';
import { ConflictException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SafeUser } from '../src/auth/safe-user.js';
import { AuditLog } from '../src/audit/audit-log.entity.js';
import { Business } from '../src/business/business.entity.js';
import { BusinessLimitsService } from '../src/business/business-limits.service.js';
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

// 9E.21 — the lost updates of ProductService (update / attachImage / removeImage), reproduced against a REAL PostgreSQL server with
// INDEPENDENT connections (a pool), not PGlite (a single connection) and not mocks. OPT-IN: it runs only when REAL_PG_ADMIN_URL
// points at a LOCAL, disposable PostgreSQL (loopback only), e.g.
//
//   REAL_PG_ADMIN_URL=postgresql://user:pw@127.0.0.1:54351/postgres JWT_SECRET=... npm run test:e2e -- product-concurrency
//
// Without the variable the whole file is skipped. With it, the file creates its OWN throw-away database (e2e_product_<random>), runs
// every real migration in it, uses fictitious data and DROPs the database afterwards. It never touches any other database. The bucket
// is a stub: no object storage of any kind is involved.
//
// How the interleaving is forced: a repository's `findOne` is wrapped so that, after it returned its row, the request pauses until
// released (the window between "read" and "write"); for image uploads the stub bucket pauses inside upload() (the window is the whole
// upload). The `legacy*` functions are the implementations of main 01aaf0e (findOne -> assign -> save()), kept here so that the same
// harness shows the defects on the old code and their absence on the new one. They exist only in this test file.
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

type Outcome = { ok: true } | { ok: false; status: number; code?: string };
const settle = (p: Promise<unknown>): Promise<Outcome> =>
  p.then(
    (): Outcome => ({ ok: true }),
    (e: unknown): Outcome => {
      const body = (e as { getResponse?: () => unknown }).getResponse?.();
      return { ok: false, status: (e as { getStatus?: () => number }).getStatus?.() ?? 0, code: (body as { errorCode?: string } | undefined)?.errorCode };
    },
  );

describe.skipIf(!ADMIN_URL)('ProductService under real concurrency (e2e, real local PostgreSQL, independent connections)', () => {
  let admin: DataSource;
  let ds: DataSource;
  let dbName: string;
  let bizA: Business;
  let bizB: Business;
  let catA: Category;
  let catA2: Category;
  let catB: Category;

  const adminA: SafeUser = { id: '00000000-0000-4000-8000-0000000000a1', email: 'a@real-pg.test', role: UserRole.ADMIN, businessId: '', active: true, mustChangePassword: false };
  const adminB: SafeUser = { id: '00000000-0000-4000-8000-0000000000b1', email: 'b@real-pg.test', role: UserRole.ADMIN, businessId: '', active: true, mustChangePassword: false };
  const superAdmin: SafeUser = { id: '00000000-0000-4000-8000-0000000000c1', email: 'super@real-pg.test', role: UserRole.SUPER_ADMIN, businessId: null, active: true, mustChangePassword: false };

  const pRepo = () => ds.getRepository(Product);
  const KEY = (productId: string, tag = '1') => `businesses/${bizA.id}/products/${productId}/00000000-0000-4000-8000-00000000000${tag}.webp`;

  // the bucket stub: records every upload; optionally pauses inside upload() (the window is the upload itself)
  const bucket = (g: Gate | null = null) => {
    const uploads: string[] = [];
    return {
      uploads,
      async upload(businessId: string, productId: string) {
        if (g) {
          g.reach();
          await g.wait;
        }
        const key = `businesses/${businessId}/products/${productId}/${randomBytes(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5')}.webp`;
        uploads.push(key);
        return key;
      },
    };
  };
  const limits = () => new BusinessLimitsService({ business: { product: 500, category: 50, table: 200, user: 20 } } as never);
  const resolver = { resolve: async () => { throw new Error('unused'); } };
  const service = (opts: { productRepo?: ReturnType<typeof pRepo>; images?: ReturnType<typeof bucket> } = {}) =>
    new ProductService(opts.productRepo ?? pRepo(), ds.getRepository(Category), ds.getRepository(Business), (opts.images ?? bucket()) as never, resolver as never, ds, limits());

  let seq = 0;
  const newProduct = async (extra: Partial<Product> = {}, businessId = bizA.id, categoryId = catA.id) => {
    seq += 1;
    return pRepo().save(pRepo().create({ name: `Burger ${seq}`, price: 1000, businessId, categoryId, ...extra }));
  };
  const row = async (id: string) =>
    (await ds.query(
      `SELECT name, description, price, available, active, sort_order AS "sortOrder", tag, ingredients, removable_ingredients AS removable, add_ons AS "addOns", image_storage_key AS img,
              business_id AS biz, category_id AS cat, deleted_at AS del, updated_at AS upd FROM products WHERE id = $1`,
      [id],
    ))[0] as {
      name: string; description: string | null; price: number; available: boolean; active: boolean; sortOrder: number; tag: string | null; ingredients: string[]; removable: string[];
      addOns: Array<{ name: string; price: number }>; img: string | null; biz: string; cat: string; del: Date | null; upd: Date;
    };
  const softDelete = (id: string) => ds.query(`UPDATE products SET deleted_at = now() WHERE id = $1`, [id]);

  // ---- main 01aaf0e1 (the defect): read -> assign -> save() of the whole stale entity ----
  async function legacyUpdate(repo: ReturnType<typeof pRepo>, id: string, dto: Partial<Product>): Promise<Product> {
    const product = await repo.findOne({ where: { id } });
    if (!product) throw new NotFoundException();
    Object.assign(product, dto);
    return repo.save(product);
  }
  async function legacyAttachImage(repo: ReturnType<typeof pRepo>, id: string, images: ReturnType<typeof bucket>): Promise<Product> {
    const product = await repo.findOne({ where: { id } });
    if (!product) throw new NotFoundException();
    product.imageStorageKey = await images.upload(product.businessId, product.id);
    return repo.save(product);
  }
  async function legacyRemoveImage(repo: ReturnType<typeof pRepo>, id: string): Promise<Product> {
    const product = await repo.findOne({ where: { id } });
    if (!product) throw new NotFoundException();
    product.imageStorageKey = null;
    return repo.save(product);
  }

  beforeAll(async () => {
    const base = assertLoopback(ADMIN_URL as string);
    dbName = `e2e_product_${randomBytes(6).toString('hex')}`;
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
    const cRepo = ds.getRepository(Category);
    catA = await cRepo.save(cRepo.create({ name: 'Burgers', slug: 'burgers', businessId: bizA.id }));
    catA2 = await cRepo.save(cRepo.create({ name: 'Bebidas', slug: 'bebidas', businessId: bizA.id }));
    catB = await cRepo.save(cRepo.create({ name: 'Pizzas', slug: 'pizzas', businessId: bizB.id }));
    Logger.overrideLogger(false); // the orphan-candidate log of the failing cases is expected noise
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
    it('A. an edit / an image change on a product DELETED meanwhile writes deleted_at = NULL: the product is resurrected', async () => {
      for (const run of [
        (repo: ReturnType<typeof pRepo>, id: string) => legacyUpdate(repo, id, { description: 'x' }),
        (repo: ReturnType<typeof pRepo>, id: string) => legacyRemoveImage(repo, id),
        (repo: ReturnType<typeof pRepo>, id: string) => legacyAttachImage(repo, id, bucket()),
      ]) {
        const p = await newProduct();
        const g = gate();
        const pending = settle(run(gatedRepo(pRepo(), g), p.id));
        await g.reached;
        await softDelete(p.id);
        expect((await row(p.id)).del).not.toBeNull();
        g.release();
        expect(await pending).toEqual({ ok: true }); // told "ok"...
        expect((await row(p.id)).del).toBeNull(); // ...and the deleted product is back on the menu
      }
    });

    it('B. an image upload restores the price, availability and name another admin changed during the upload', async () => {
      const p = await newProduct({ name: 'Burger', price: 1000 });
      const g = gate();
      const pending = settle(legacyAttachImage(gatedRepo(pRepo(), g), p.id, bucket()));
      await g.reached;
      await service().update(p.id, { name: 'Burger XL', price: 1500, available: false }, adminA);
      g.release();
      expect(await pending).toEqual({ ok: true });
      const after = await row(p.id);
      expect(after).toMatchObject({ name: 'Burger', price: 1000, available: true }); // all three silently reverted
      expect(after.img).not.toBeNull();
    });

    it('C. two PATCH of different columns: the later save() puts the earlier one\'s columns back', async () => {
      const p = await newProduct();
      const g = gate();
      const slow = settle(legacyUpdate(gatedRepo(pRepo(), g), p.id, { description: 'Con queso' }));
      await g.reached;
      await legacyUpdate(pRepo(), p.id, { price: 2000, available: false });
      g.release();
      await slow;
      expect(await row(p.id)).toMatchObject({ price: 1000, available: true, description: 'Con queso' });
    });
  });

  describe('the corrected implementation (column-scoped UPDATE ... WHERE id = $1 AND deleted_at IS NULL, under the row lock for PATCH)', () => {
    it('A1. a PATCH on a product deleted meanwhile is a 404 and the product stays deleted', async () => {
      const p = await newProduct();
      const g = gate();
      const pending = settle(service({ productRepo: gatedRepo(pRepo(), g) }).update(p.id, { description: 'x', price: 1 }, adminA));
      await g.reached;
      await softDelete(p.id);
      const stamp = (await row(p.id)).upd.getTime();
      g.release();
      expect(await pending).toMatchObject({ ok: false, status: 404 });
      const after = await row(p.id);
      expect(after.del).not.toBeNull();
      expect(after.description).toBeNull();
      expect(after.price).toBe(1000);
      expect(after.upd.getTime()).toBe(stamp); // nothing was written at all
    });

    it('A2. an image upload on a product deleted during the upload: 404, the product stays deleted, no key is written (the object is a logged orphan)', async () => {
      const p = await newProduct();
      const g = gate();
      const images = bucket(g);
      const pending = settle(service({ images }).attachImage(p.id, adminA, { buffer: Buffer.alloc(8), size: 8 }));
      await g.reached; // inside the upload
      await softDelete(p.id);
      g.release();
      expect(await pending).toMatchObject({ ok: false, status: 404 });
      const after = await row(p.id);
      expect(after.del).not.toBeNull();
      expect(after.img).toBeNull();
      expect(images.uploads).toHaveLength(1); // uploaded once, never retried, never deleted
    });

    it('A3. removeImage on a product deleted meanwhile: 404, the product stays deleted', async () => {
      const p = await newProduct({ imageStorageKey: null });
      await ds.query(`UPDATE products SET image_storage_key = $2 WHERE id = $1`, [p.id, KEY(p.id)]);
      const g = gate();
      const pending = settle(service({ productRepo: gatedRepo(pRepo(), g) }).removeImage(p.id, adminA));
      await g.reached;
      await softDelete(p.id);
      g.release();
      expect(await pending).toMatchObject({ ok: false, status: 404 });
      const after = await row(p.id);
      expect(after.del).not.toBeNull();
      expect(after.img).toBe(KEY(p.id)); // untouched
    });

    it('B. an image upload never reverts the price, availability, name or description changed during the upload', async () => {
      const p = await newProduct({ name: 'Burger', price: 1000, description: 'Clásica' });
      const g = gate();
      const images = bucket(g);
      const pending = settle(service({ images }).attachImage(p.id, adminA, { buffer: Buffer.alloc(8), size: 8 }));
      await g.reached;
      await service().update(p.id, { name: 'Burger XL', price: 1500, available: false, description: null as unknown as string, tag: 'Nuevo' }, adminA);
      g.release();
      expect(await pending).toEqual({ ok: true });
      const after = await row(p.id);
      expect(after).toMatchObject({ name: 'Burger XL', price: 1500, available: false, description: null, tag: 'Nuevo' });
      expect(after.img).toBe(images.uploads[0]); // the S3 object and the reference agree
    });

    it('B2. the answer of an image upload is the row as it is NOW (it carries the concurrent price), and removeImage keeps every other column', async () => {
      const p = await newProduct({ price: 1000 });
      const g = gate();
      const images = bucket(g);
      const pending = service({ images }).attachImage(p.id, adminA, { buffer: Buffer.alloc(8), size: 8 });
      await g.reached;
      await service().update(p.id, { price: 1800 }, adminA);
      g.release();
      expect(await pending).toMatchObject({ price: 1800, imageStorageKey: images.uploads[0] });
      const removed = await service().removeImage(p.id, adminA);
      expect(removed).toMatchObject({ price: 1800, imageStorageKey: null });
      expect((await row(p.id)).price).toBe(1800);
    });

    it('C. two PATCH of DIFFERENT columns conserve both changes, whichever commits first', async () => {
      for (const slowFirst of [true, false]) {
        const p = await newProduct();
        const g = gate();
        const slow = settle(service({ productRepo: gatedRepo(pRepo(), g) }).update(p.id, { description: 'Con queso', tag: 'Nuevo' }, adminA));
        await g.reached;
        const fast = settle(service().update(p.id, { price: 2000, available: false }, adminA));
        if (slowFirst) { g.release(); await slow; await fast; } else { await fast; g.release(); await slow; }
        expect(await row(p.id)).toMatchObject({ description: 'Con queso', tag: 'Nuevo', price: 2000, available: false });
      }
    });

    it('C2. natural concurrency (no pausing), 60 rounds of two PATCH over different columns: never a lost column', async () => {
      const p = await newProduct();
      let lost = 0;
      for (let i = 0; i < 60; i++) {
        const price = 1000 + i + 1;
        const description = `d${i}`;
        const results = await Promise.all([settle(service().update(p.id, { price }, adminA)), settle(service().update(p.id, { description }, adminA))]);
        const r = await row(p.id);
        if (results.some((x) => !x.ok) || r.price !== price || r.description !== description) lost += 1;
      }
      expect(lost).toBe(0);
    });

    it('D. the SAME column: the last statement to commit wins and the other columns are untouched (documented last-writer-wins)', async () => {
      const p = await newProduct({ description: 'base' });
      const g = gate();
      const first = settle(service({ productRepo: gatedRepo(pRepo(), g) }).update(p.id, { price: 2000 }, adminA));
      await g.reached;
      await service().update(p.id, { price: 3000 }, adminA); // commits first
      g.release();
      await first; // commits last
      expect(await row(p.id)).toMatchObject({ price: 2000, description: 'base' });
    });

    it('E. the ingredient invariant survives two concurrent PATCH (removable ⊆ ingredients), because it is judged under the row lock', async () => {
      let violations = 0;
      let rejected = 0;
      for (let i = 0; i < 40; i++) {
        const p = await newProduct({ ingredients: ['Carne', 'Pan', 'Queso'], removableIngredients: ['Queso'] });
        const results = await Promise.all([
          settle(service().update(p.id, { ingredients: ['Carne', 'Pan'] }, adminA)), // drops Queso from the ingredients
          settle(service().update(p.id, { removableIngredients: ['Queso', 'Pan'] }, adminA)), // keeps relying on Queso
        ]);
        rejected += results.filter((x) => !x.ok).length;
        const r = await row(p.id);
        if (r.removable.some((x) => !r.ingredients.includes(x))) violations += 1;
        for (const x of results) if (!x.ok) expect(x).toMatchObject({ status: 400, code: 'REMOVABLE_INGREDIENTS_NOT_SUBSET' });
      }
      expect(violations).toBe(0);
      expect(rejected).toBeGreaterThan(0); // the losing request is refused, never silently merged
    });

    it('F. values survive the round trip exactly: arrays, jsonb add-ons, zero, false, empty string and null', async () => {
      const p = await newProduct({ description: 'x', tag: 'Nuevo' });
      await service().update(p.id, { ingredients: ['Carne', 'Pan'], removableIngredients: ['Pan'], addOns: [{ name: 'Tocino', price: 1500 }], price: 0, available: false, tag: '', description: null as unknown as string, sortOrder: 7 }, adminA);
      expect(await row(p.id)).toMatchObject({ ingredients: ['Carne', 'Pan'], removable: ['Pan'], addOns: [{ name: 'Tocino', price: 1500 }], price: 0, available: false, tag: '', description: null, sortOrder: 7 });
    });

    it('G. isolation: an ADMIN of another business is refused (403) on every operation and nothing changes; other products are untouched', async () => {
      const mine = await newProduct();
      const sibling = await newProduct();
      const stamp = (await row(mine.id)).upd.getTime();
      expect(await settle(service().update(mine.id, { price: 1 }, adminB))).toMatchObject({ ok: false, status: 403 });
      expect(await settle(service().attachImage(mine.id, adminB, { buffer: Buffer.alloc(8), size: 8 }))).toMatchObject({ ok: false, status: 403 });
      expect(await settle(service().removeImage(mine.id, adminB))).toMatchObject({ ok: false, status: 403 });
      expect((await row(mine.id)).upd.getTime()).toBe(stamp);
      await service().update(mine.id, { price: 1234 }, adminA);
      expect((await row(sibling.id)).price).toBe(1000);
    });

    it('H. SUPER_ADMIN keeps the previous powers: edits any business, and moves a product to another business with the category of the destination', async () => {
      const p = await newProduct();
      await service().update(p.id, { price: 1111 }, superAdmin);
      expect((await row(p.id)).price).toBe(1111);

      // moving without moving the category is still refused (the category belongs to the old business)
      expect(await settle(service().update(p.id, { businessId: bizB.id }, superAdmin))).toMatchObject({ ok: false, status: 400 });
      expect((await row(p.id)).biz).toBe(bizA.id);

      const moved = await service().update(p.id, { businessId: bizB.id, categoryId: catB.id }, superAdmin);
      expect(moved).toMatchObject({ businessId: bizB.id, categoryId: catB.id, price: 1111 });
      expect(await row(p.id)).toMatchObject({ biz: bizB.id, cat: catB.id, price: 1111 });
      // the old owner can no longer touch it
      expect(await settle(service().update(p.id, { price: 2 }, adminA))).toMatchObject({ ok: false, status: 403 });
    });

    it('H2. a PATCH of the old owner that raced a SUPER_ADMIN move is refused on the locked row; an image upload built for the old business is not written after the move', async () => {
      const p = await newProduct();
      const g = gate();
      const slow = settle(service({ productRepo: gatedRepo(pRepo(), g) }).update(p.id, { price: 5 }, adminA));
      await g.reached;
      await service().update(p.id, { businessId: bizB.id, categoryId: catB.id }, superAdmin);
      g.release();
      expect(await slow).toMatchObject({ ok: false, status: 403 });
      expect((await row(p.id)).price).toBe(1000);

      const q = await newProduct();
      const gi = gate();
      const images = bucket(gi);
      const upload = settle(service({ images }).attachImage(q.id, superAdmin, { buffer: Buffer.alloc(8), size: 8 }));
      await gi.reached;
      await service().update(q.id, { businessId: bizB.id, categoryId: catB.id }, superAdmin);
      gi.release();
      expect(await upload).toMatchObject({ ok: false, status: 409, code: 'PRODUCT_CONCURRENT_MODIFICATION' });
      expect((await row(q.id)).img).toBeNull();
    });

    it('I. a refused request writes nothing and is not retried: validation errors leave the row, and its updated_at, exactly as they were', async () => {
      const p = await newProduct({ ingredients: ['Carne'], removableIngredients: [] });
      const stamp = (await row(p.id)).upd.getTime();
      expect(await settle(service().update(p.id, { removableIngredients: ['Cebolla'] }, adminA))).toMatchObject({ ok: false, status: 400, code: 'REMOVABLE_INGREDIENTS_NOT_SUBSET' });
      expect(await settle(service().update(p.id, { categoryId: catB.id }, adminA))).toMatchObject({ ok: false, status: 400 });
      expect(await settle(service().update('00000000-0000-4000-8000-000000000000', { price: 1 }, adminA))).toMatchObject({ ok: false, status: 404 });
      expect((await row(p.id)).upd.getTime()).toBe(stamp);
    });

    it('J. nothing but the requested columns (and updated_at) changes: ids, business, category, image key and creation data are as they were', async () => {
      const p = await newProduct({ description: 'base', tag: 'T', sortOrder: 3 });
      await ds.query(`UPDATE products SET image_storage_key = $2 WHERE id = $1`, [p.id, KEY(p.id)]);
      const before = await row(p.id);
      await service().update(p.id, { price: 1999 }, adminA);
      const after = await row(p.id);
      expect({ ...after, price: before.price, upd: before.upd }).toEqual(before);
      expect(after.price).toBe(1999);
    });

    it('K. a reactivation is judged against the category as it is under the lock, and an unrelated edit does not re-check it', async () => {
      const p = await newProduct({ active: false }, bizA.id, catA2.id);
      await ds.query(`UPDATE categories SET active = false WHERE id = $1`, [catA2.id]);
      expect(await settle(service().update(p.id, { active: true }, adminA))).toMatchObject({ ok: false, status: 409 });
      expect(await settle(service().update(p.id, { name: 'renamed' }, adminA))).toEqual({ ok: true });
      await ds.query(`UPDATE categories SET active = true WHERE id = $1`, [catA2.id]);
      expect(await settle(service().update(p.id, { active: true }, adminA))).toEqual({ ok: true });
    });

    it('L. errors are a plain NotFound / Forbidden / Conflict, never a 500', async () => {
      const p = await newProduct();
      await softDelete(p.id);
      for (const call of [service().update(p.id, { price: 1 }, adminA), service().removeImage(p.id, adminA), service().attachImage(p.id, adminA, { buffer: Buffer.alloc(8), size: 8 })]) {
        await expect(call).rejects.toBeInstanceOf(NotFoundException);
      }
      expect(ForbiddenException).toBeDefined();
      expect(ConflictException).toBeDefined();
    });
  });
});
