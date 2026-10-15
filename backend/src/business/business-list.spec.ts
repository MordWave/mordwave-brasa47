import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ValidationPipe } from '@nestjs/common';
import { ILike } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaUrlService } from '../media/media-url.service.js';
import { businessLogoKey } from '../media/media-key.util.js';
import { ImageStorageService } from '../storage/image-storage.service.js';
import { Business } from './business.entity.js';
import { BusinessPresenter, type BusinessListRow } from './business.presenter.js';
import { BusinessService } from './business.service.js';
import { BusinessListQueryDto } from './dto/business-list-query.dto.js';

// Unit layer for GET /businesses (SUPER_ADMIN's global listing): what the service asks TypeORM for, what the
// presenter lets out, and what the query DTO accepts. The real-database proof is test/businesses-list.e2e-spec.ts.

const BIZ = '11111111-1111-4111-8111-111111111111';
const LOGO_KEY = businessLogoKey(BIZ, '33333333-3333-4333-8333-333333333333');

describe('BusinessService.findAll (global listing)', () => {
  let service: BusinessService;
  let findAndCount: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    findAndCount = vi.fn(async () => [[], 0]);
    const moduleRef = await Test.createTestingModule({
      providers: [
        BusinessService,
        { provide: getRepositoryToken(Business), useValue: { findAndCount } },
        { provide: ImageStorageService, useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(BusinessService);
  });

  it('takes no user and no tenant: it lists across tenants, defaulting to page 1 / limit 20, name then id', async () => {
    expect(service.findAll.length).toBe(1); // (query) only: there is no SafeUser to scope by
    await service.findAll(new BusinessListQueryDto());

    const options = findAndCount.mock.calls[0]![0];
    expect(options.where).toEqual({}); // no businessId anywhere
    expect(options.order).toEqual({ name: 'ASC', id: 'ASC' });
    expect(options.skip).toBe(0);
    expect(options.take).toBe(20);
  });

  it('selects only the picker columns and loads no relations (no N+1, nothing sensitive)', async () => {
    await service.findAll(new BusinessListQueryDto());

    const options = findAndCount.mock.calls[0]![0];
    expect(options.select).toEqual({ id: true, name: true, slug: true, active: true, logoStorageKey: true });
    expect(options.relations).toBeUndefined();
    expect(options.relationLoadStrategy).toBeUndefined();
  });

  it('paginates: skip/take follow page and limit, and the result carries total, totalPages and hasMore', async () => {
    findAndCount.mockResolvedValue([[{ id: 'x' }], 45]);
    const result = await service.findAll(plainToInstance(BusinessListQueryDto, { page: '3', limit: '10' }));

    const options = findAndCount.mock.calls[0]![0];
    expect(options.skip).toBe(20);
    expect(options.take).toBe(10);
    expect(result).toMatchObject({ page: 3, limit: 10, total: 45, totalPages: 5, hasMore: true });
  });

  it('search is a parameterised ILIKE on name OR slug with LIKE wildcards escaped', async () => {
    await service.findAll(plainToInstance(BusinessListQueryDto, { search: '50%_off\\' }));

    const where = findAndCount.mock.calls[0]![0].where as Array<Record<string, unknown>>;
    expect(where).toHaveLength(2); // OR
    const expected = ILike('%50\\%\\_off\\\\%');
    expect(where[0]!.name).toEqual(expected);
    expect(where[1]!.slug).toEqual(expected);
  });

  it('active=true/false filters on Business.active, combined with search on both OR branches', async () => {
    await service.findAll(plainToInstance(BusinessListQueryDto, { active: 'false', search: 'brasa' }));

    const where = findAndCount.mock.calls[0]![0].where as Array<Record<string, unknown>>;
    expect(where.every((w) => w.active === false)).toBe(true);
    await service.findAll(plainToInstance(BusinessListQueryDto, { active: 'true' }));
    expect(findAndCount.mock.calls[1]![0].where).toEqual({ active: true });
  });
});

describe('BusinessPresenter.presentListItem', () => {
  afterEach(() => {
    delete process.env.MEDIA_PUBLIC_BASE_URL;
  });

  const row = (extra: Partial<BusinessListRow> = {}): BusinessListRow => ({
    id: BIZ,
    name: 'Brasa 47',
    slug: 'brasa-47',
    active: true,
    logoStorageKey: null,
    ...extra,
  });

  it('returns exactly id, name, slug, active and logoUrl, whatever else the row carries', () => {
    process.env.MEDIA_PUBLIC_BASE_URL = 'https://api.example.com';
    const noisy = {
      ...row({ logoStorageKey: LOGO_KEY }),
      address: 'Calle 1',
      phone: '1',
      hours: 'x',
      primaryColor: '#FF0000',
      users: [{ passwordHash: 'secret' }],
      products: [],
    } as unknown as BusinessListRow;

    const item = new BusinessPresenter(new MediaUrlService()).presentListItem(noisy);

    expect(Object.keys(item).sort()).toEqual(['active', 'id', 'logoUrl', 'name', 'slug']);
    expect(item.logoUrl).toBe(`https://api.example.com/media/${LOGO_KEY}`);
    expect(JSON.stringify(item)).not.toMatch(/storage|secret|password|Calle|users|products|logoStorageKey/i);
  });

  it('logoUrl is null without a logo (or when media URLs are not configured)', () => {
    delete process.env.MEDIA_PUBLIC_BASE_URL;
    const presenter = new BusinessPresenter(new MediaUrlService());
    expect(presenter.presentListItem(row()).logoUrl).toBeNull();
    expect(presenter.presentListItem(row({ logoStorageKey: LOGO_KEY })).logoUrl).toBeNull();
  });
});

describe('BusinessListQueryDto', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const parse = (query: Record<string, string>) => pipe.transform(query, { type: 'query', metatype: BusinessListQueryDto });

  it('accepts page, limit, search and active', async () => {
    await expect(parse({ page: '2', limit: '50', search: 'brasa', active: 'true' })).resolves.toMatchObject({
      page: 2,
      limit: 50,
      search: 'brasa',
      active: true,
    });
    await expect(parse({})).resolves.toBeDefined();
  });

  it('rejects ?businessId= (the listing is global, a tenant scope is not part of the contract)', async () => {
    const error = await parse({ businessId: '11111111-1111-4111-8111-111111111111' }).catch((e: unknown) => e);
    expect((error as { getStatus(): number }).getStatus()).toBe(400);
    expect(JSON.stringify((error as { getResponse(): unknown }).getResponse())).toMatch(/property businessId should not exist/);
  });

  it('enforces the pagination ceilings (limit <= 100, page and limit >= 1)', async () => {
    await expect(parse({ limit: '100' })).resolves.toBeDefined();
    for (const bad of [{ limit: '101' }, { limit: '0' }, { page: '0' }, { page: '-1' }, { limit: 'abc' }]) {
      await expect(parse(bad)).rejects.toThrow();
    }
  });

  it('normalises search: trims and collapses whitespace; caps it at 80 characters', async () => {
    expect((await parse({ search: '   brasa    47  ' })).search).toBe('brasa 47');
    expect((await parse({ search: '   ' })).search).toBe('');
    await expect(parse({ search: 'a'.repeat(80) })).resolves.toBeDefined();
    await expect(parse({ search: 'a'.repeat(81) })).rejects.toThrow();
    const dto = plainToInstance(BusinessListQueryDto, { search: 'x'.repeat(200) });
    expect((await validate(dto)).some((e) => e.property === 'search')).toBe(true);
  });

  it('active only takes the literal strings true/false', async () => {
    expect((await parse({ active: 'false' })).active).toBe(false);
    for (const bad of ['yes', '1', 'FALSE', '']) await expect(parse({ active: bad })).rejects.toThrow();
  });
});
