import { afterEach, describe, expect, it } from 'vitest';
import { MediaUrlService } from '../media/media-url.service.js';
import { productImageKey } from '../media/media-key.util.js';
import type { Product } from './product.entity.js';
import { ProductPresenter } from './product.presenter.js';

const BIZ = '11111111-1111-4111-8111-111111111111';
const PROD = '22222222-2222-4222-8222-222222222222';
const KEY = productImageKey(BIZ, PROD, '33333333-3333-4333-8333-333333333333');
const LEGACY = 'https://legacy.example/product-images/a.webp?v=1';

function product(extra: Partial<Product> = {}): Product {
  return {
    id: PROD,
    name: 'Clásica',
    description: null,
    price: 6900,
    imageUrl: LEGACY,
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
  it('with a NULL key the JSON is exactly the current entity JSON (same legacy URL, same fields)', () => {
    const entity = product();
    const { imageStorageKey: _omit, ...legacyShape } = entity;
    for (const p of [presenter(), presenter('https://api.example.com')]) {
      const out = p.present(entity);
      expect(JSON.parse(JSON.stringify(out))).toEqual(JSON.parse(JSON.stringify(legacyShape)));
      expect(out.imageUrl).toBe(LEGACY);
    }
  });

  it('keeps a null legacy URL null', () => {
    expect(presenter().present(product({ imageUrl: null })).imageUrl).toBeNull();
  });

  it('never exposes imageStorageKey, whatever the configuration', () => {
    for (const p of [presenter(), presenter('https://api.example.com')]) {
      const out = p.present(product({ imageStorageKey: KEY }));
      expect(out).not.toHaveProperty('imageStorageKey');
      expect(JSON.stringify(out)).not.toContain('imageStorageKey');
    }
  });

  it('uses the stable /media URL when a key exists and the base URL is configured', () => {
    const out = presenter('https://api.example.com').present(product({ imageStorageKey: KEY }));
    expect(out.imageUrl).toBe(`https://api.example.com/media/${KEY}`);
  });

  it('a keyed row NEVER falls back to the legacy URL: without a base URL it has no image (and leaks no key)', () => {
    const out = presenter().present(product({ imageStorageKey: KEY }));
    expect(out.imageUrl).toBeNull();
    expect(JSON.stringify(out)).not.toContain(KEY);
    expect(JSON.stringify(out)).not.toContain(LEGACY);
  });

  it('the legacy URL is only a fallback for rows WITHOUT a storage key', () => {
    const p = presenter('https://api.example.com');
    expect(p.present(product({ imageStorageKey: null })).imageUrl).toBe(LEGACY);
    expect(p.present(product({ imageStorageKey: KEY })).imageUrl).toBe(`https://api.example.com/media/${KEY}`);
  });

  it('does not mutate the entity it is given', () => {
    const entity = product({ imageStorageKey: KEY });
    presenter('https://api.example.com').present(entity);
    expect(entity.imageStorageKey).toBe(KEY);
    expect(entity.imageUrl).toBe(LEGACY);
  });

  it('presentMany / presentPage map every item and keep the page metadata', () => {
    const p = presenter('https://api.example.com');
    const rows = [product({ imageStorageKey: KEY }), product({ id: 'x' })];
    const many = p.presentMany(rows);
    expect(many.map((r) => r.imageUrl)).toEqual([`https://api.example.com/media/${KEY}`, LEGACY]);
    const page = p.presentPage({ items: rows, page: 2, limit: 10, total: 12, totalPages: 2, hasMore: false });
    expect(page).toMatchObject({ page: 2, limit: 10, total: 12, totalPages: 2, hasMore: false });
    expect(page.items).toHaveLength(2);
    expect(JSON.stringify(page)).not.toContain('imageStorageKey');
  });
});
