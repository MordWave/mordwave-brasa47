import { afterEach, describe, expect, it } from 'vitest';
import { MediaUrlService } from '../media/media-url.service.js';
import { productImageKey } from '../media/media-key.util.js';
import type { Product } from './product.entity.js';
import { ProductPresenter } from './product.presenter.js';

const BIZ = '11111111-1111-4111-8111-111111111111';
const PROD = '22222222-2222-4222-8222-222222222222';
const KEY = productImageKey(BIZ, PROD, '33333333-3333-4333-8333-333333333333');
const BASE = 'https://api.example.com';

function product(extra: Partial<Product> = {}): Product {
  return {
    id: PROD,
    name: 'Clásica',
    description: null,
    price: 6900,
    imageStorageKey: null,
    available: true,
    active: true,
    sortOrder: 1,
    tag: null,
    ingredients: [],
    removableIngredients: [],
    addOns: [],
    businessId: BIZ,
    categoryId: 'c1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
    ...extra,
  } as unknown as Product;
}

function presenter(base?: string): ProductPresenter {
  if (base === undefined) delete process.env.MEDIA_PUBLIC_BASE_URL;
  else process.env.MEDIA_PUBLIC_BASE_URL = base;
  return new ProductPresenter(new MediaUrlService());
}

afterEach(() => {
  delete process.env.MEDIA_PUBLIC_BASE_URL;
});

describe('ProductPresenter', () => {
  it('serves the stable /media URL when the product has a storage key', () => {
    expect(presenter(BASE).present(product({ imageStorageKey: KEY })).imageUrl).toBe(`${BASE}/media/${KEY}`);
  });

  it('a product without a storage key has no image (imageUrl null) — there is no other source', () => {
    expect(presenter(BASE).present(product()).imageUrl).toBeNull();
  });

  it('without MEDIA_PUBLIC_BASE_URL a keyed product has no image either, and the key does not leak', () => {
    const out = presenter().present(product({ imageStorageKey: KEY }));
    expect(out.imageUrl).toBeNull();
    expect(JSON.stringify(out)).not.toContain(KEY);
  });

  it('never exposes imageStorageKey, whatever the configuration', () => {
    for (const p of [presenter(), presenter(BASE)]) {
      const out = p.present(product({ imageStorageKey: KEY }));
      expect(out).not.toHaveProperty('imageStorageKey');
      expect(JSON.stringify(out)).not.toContain('imageStorageKey');
    }
  });

  it('keeps the response contract: the same fields as before, imageUrl included', () => {
    const out = presenter(BASE).present(product({ imageStorageKey: KEY }));
    expect(Object.keys(out).sort()).toEqual(
      [
        'id', 'name', 'description', 'price', 'imageUrl', 'available', 'active', 'sortOrder', 'tag',
        'ingredients', 'removableIngredients', 'addOns', 'businessId', 'categoryId', 'createdAt',
        'updatedAt', 'deletedAt',
      ].sort(),
    );
  });

  it('ignores a stray legacy imageUrl on the object: it is never read', () => {
    const stray = product({ imageStorageKey: null }) as unknown as Record<string, unknown>;
    stray.imageUrl = 'https://legacy.example/old.webp';
    expect(presenter(BASE).present(stray as unknown as Product).imageUrl).toBeNull();
  });

  it('does not mutate the entity it is given', () => {
    const entity = product({ imageStorageKey: KEY });
    presenter(BASE).present(entity);
    expect(entity.imageStorageKey).toBe(KEY);
    expect(entity).not.toHaveProperty('imageUrl');
  });

  it('presentMany / presentPage map every item and keep the page metadata', () => {
    const p = presenter(BASE);
    const rows = [product({ imageStorageKey: KEY }), product({ id: 'x' })];
    expect(p.presentMany(rows).map((r) => r.imageUrl)).toEqual([`${BASE}/media/${KEY}`, null]);
    const page = p.presentPage({ items: rows, page: 2, limit: 10, total: 12, totalPages: 2, hasMore: false });
    expect(page).toMatchObject({ page: 2, limit: 10, total: 12, totalPages: 2, hasMore: false });
    expect(page.items).toHaveLength(2);
    expect(JSON.stringify(page)).not.toContain('imageStorageKey');
  });
});
