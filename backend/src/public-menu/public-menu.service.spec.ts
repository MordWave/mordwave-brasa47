import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { Business } from '../business/business.entity.js';
import type { CategoryService } from '../category/category.service.js';
import type { MediaUrlService } from '../media/media-url.service.js';
import type { ProductService } from '../product/product.service.js';
import { PublicMenuService } from './public-menu.service.js';

const BUSINESS_ID = '11111111-1111-4111-8111-111111111111';

function setup(business: Partial<Business> | null = { id: BUSINESS_ID, name: 'Demo', slug: 'demo-resto', primaryColor: null, accentColor: null }) {
  const findOne = vi.fn().mockResolvedValue(business);
  const findAllCategories = vi.fn().mockResolvedValue([]);
  const findAllProducts = vi.fn().mockResolvedValue([]);
  const resolve = vi.fn((key: string | null) => (key ? `https://api.test/media/${key}` : null));
  const service = new PublicMenuService(
    { findOne } as never,
    { findAllPublic: findAllCategories } as unknown as CategoryService,
    { findAllPublic: findAllProducts } as unknown as ProductService,
    { resolve } as unknown as MediaUrlService,
  );
  return { service, findOne, findAllCategories, findAllProducts };
}

describe('PublicMenuService', () => {
  it.each([
    ['empty', ''],
    ['too short', 'ab'],
    ['too long', 'a'.repeat(61)],
    ['uppercase', 'Demo-Resto'],
    ['underscore', 'demo_resto'],
    ['leading hyphen', '-demo'],
    ['double hyphen', 'demo--resto'],
    ['path traversal', '../demo'],
    ['SQL-looking', "demo' OR '1'='1"],
    ['a UUID-like value with spaces', 'demo resto'],
  ])('a value that cannot be a slug (%s) is a 404 and never reaches the database', async (_label, slug) => {
    const { service, findOne, findAllCategories, findAllProducts } = setup();
    await expect(service.getMenu(slug)).rejects.toBeInstanceOf(NotFoundException);
    expect(findOne).not.toHaveBeenCalled();
    expect(findAllCategories).not.toHaveBeenCalled();
    expect(findAllProducts).not.toHaveBeenCalled();
  });

  it('an unknown or inactive business is the standard BUSINESS_NOT_FOUND 404 and no menu is queried', async () => {
    const { service, findAllCategories, findAllProducts, findOne } = setup(null);
    await expect(service.getMenu('demo-resto')).rejects.toMatchObject({ response: { errorCode: 'BUSINESS_NOT_FOUND' } });
    expect(findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { slug: 'demo-resto', active: true } }));
    expect(findAllCategories).not.toHaveBeenCalled();
    expect(findAllProducts).not.toHaveBeenCalled();
  });

  it('scopes both reads by the id resolved from the slug, never by anything the caller sends', async () => {
    const { service, findAllCategories, findAllProducts } = setup();
    await service.getMenu('demo-resto');
    expect(findAllCategories).toHaveBeenCalledWith({ businessId: BUSINESS_ID });
    expect(findAllProducts).toHaveBeenCalledWith({ businessId: BUSINESS_ID });
  });

  it('whitelists the fields: internal columns of the rows are dropped, nulls are explicit', async () => {
    const { service, findAllCategories, findAllProducts } = setup({
      id: BUSINESS_ID,
      name: 'Demo',
      slug: 'demo-resto',
      logoStorageKey: 'k/logo.webp',
      coverStorageKey: null,
      primaryColor: '#112233',
      accentColor: undefined,
    } as Partial<Business>);
    findAllCategories.mockResolvedValue([{ id: 'c1', name: 'Entradas', slug: 'entradas', sortOrder: 1, businessId: BUSINESS_ID, active: true, createdAt: new Date() }]);
    findAllProducts.mockResolvedValue([
      { id: 'p1', categoryId: 'c1', name: 'Papas', description: undefined, price: 3000, imageStorageKey: null, tag: undefined, available: true, active: true, sortOrder: 2, businessId: BUSINESS_ID, ingredients: ['papa'], addOns: [] },
    ]);
    const menu = await service.getMenu('demo-resto');
    expect(menu).toEqual({
      business: { name: 'Demo', slug: 'demo-resto', logoUrl: 'https://api.test/media/k/logo.webp', coverUrl: null, primaryColor: '#112233', accentColor: null },
      categories: [{ id: 'c1', name: 'Entradas', slug: 'entradas', sortOrder: 1 }],
      products: [{ id: 'p1', categoryId: 'c1', name: 'Papas', description: null, price: 3000, imageUrl: null, tag: null, available: true, sortOrder: 2 }],
    });
  });
});
