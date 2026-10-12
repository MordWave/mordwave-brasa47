import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { AuditLogQueryDto } from '../../audit/dto/audit-log-query.dto.js';
import { OrderHistoryQueryDto } from '../../order/dto/order-history-query.dto.js';
import { OrderQueryDto } from '../../order/dto/order-query.dto.js';
import { ProductAdminQueryDto } from '../../product/dto/product-admin-query.dto.js';
import { ProductSummaryQueryDto } from '../../product/dto/product-summary-query.dto.js';
import { PAGINATION_DEFAULT_LIMIT, PAGINATION_MAX_LIMIT } from '../pagination.const.js';
import { PaginationQueryDto } from './pagination-query.dto.js';

// Query params always arrive as strings, so every case goes through
// plainToInstance exactly like the global ValidationPipe({ transform: true }).
async function errorsFor<T extends object>(cls: new () => T, plain: Record<string, unknown>) {
  const errors = await validate(plainToInstance(cls, plain));
  return errors.map((e) => e.property);
}

describe('pagination constants', () => {
  it('standardises default 20 / max 100', () => {
    expect(PAGINATION_DEFAULT_LIMIT).toBe(20);
    expect(PAGINATION_MAX_LIMIT).toBe(100);
  });
});

describe('PaginationQueryDto', () => {
  it('accepts no params at all (services apply the defaults)', async () => {
    const dto = plainToInstance(PaginationQueryDto, {});
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.page).toBeUndefined();
    expect(dto.limit).toBeUndefined();
  });

  it('coerces string page/limit to numbers', async () => {
    const dto = plainToInstance(PaginationQueryDto, { page: '3', limit: '50' });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.page).toBe(3);
    expect(dto.limit).toBe(50);
  });

  it('accepts the maximum limit and rejects anything above it', async () => {
    expect(await errorsFor(PaginationQueryDto, { limit: '100' })).toEqual([]);
    expect(await errorsFor(PaginationQueryDto, { limit: '101' })).toEqual(['limit']);
  });

  it.each([
    ['page', '0'],
    ['page', '-1'],
    ['page', '1.5'],
    ['page', 'abc'],
    ['limit', '0'],
    ['limit', '-5'],
    ['limit', 'abc'],
  ])('rejects %s=%s', async (field, value) => {
    expect(await errorsFor(PaginationQueryDto, { [field]: value })).toEqual([field]);
  });
});

// The history/audit DTOs now inherit page/limit from the shared base — their
// public contract (page >= 1, 1 <= limit <= 100, own filters intact) must not
// have changed.
describe.each([
  ['OrderHistoryQueryDto', OrderHistoryQueryDto],
  ['AuditLogQueryDto', AuditLogQueryDto],
])('%s keeps its pagination contract after extending PaginationQueryDto', (_name, cls) => {
  it('is a PaginationQueryDto', () => {
    expect(new cls()).toBeInstanceOf(PaginationQueryDto);
  });

  it('accepts page=2&limit=100', async () => {
    expect(await errorsFor(cls, { page: '2', limit: '100' })).toEqual([]);
  });

  it('rejects limit=101 and page=0', async () => {
    expect(await errorsFor(cls, { limit: '101' })).toEqual(['limit']);
    expect(await errorsFor(cls, { page: '0' })).toEqual(['page']);
  });

  it('still rejects an invalid filter alongside valid pagination', async () => {
    expect(await errorsFor(cls, { page: '1', businessId: 'not-a-uuid' })).toEqual(['businessId']);
  });
});

describe('OrderQueryDto (live NEW queue)', () => {
  it('accepts no limit (service default is 50)', async () => {
    expect(await errorsFor(OrderQueryDto, { status: 'NEW' })).toEqual([]);
  });

  it('accepts up to 100 and now rejects 101 (was 200)', async () => {
    expect(await errorsFor(OrderQueryDto, { limit: '100' })).toEqual([]);
    expect(await errorsFor(OrderQueryDto, { limit: '101' })).toEqual(['limit']);
    expect(await errorsFor(OrderQueryDto, { limit: '200' })).toEqual(['limit']);
  });
});

describe('ProductAdminQueryDto', () => {
  it('is a PaginationQueryDto', () => {
    expect(new ProductAdminQueryDto()).toBeInstanceOf(PaginationQueryDto);
  });

  it('accepts the full contract', async () => {
    const dto = plainToInstance(ProductAdminQueryDto, {
      page: '2',
      limit: '20',
      categoryId: '5f3b9a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
      search: '  burger  ',
      active: 'true',
      available: 'false',
    });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.page).toBe(2);
    expect(dto.limit).toBe(20);
    expect(dto.search).toBe('burger');
    expect(dto.active).toBe(true);
    expect(dto.available).toBe(false);
  });

  it('parses "false" as false (not truthy-string true)', async () => {
    const dto = plainToInstance(ProductAdminQueryDto, { active: 'false' });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.active).toBe(false);
  });

  it('leaves omitted filters undefined', () => {
    const dto = plainToInstance(ProductAdminQueryDto, {});
    expect(dto.active).toBeUndefined();
    expect(dto.available).toBeUndefined();
    expect(dto.search).toBeUndefined();
  });

  it.each([
    ['active', 'yes'],
    ['active', '1'],
    ['available', 'maybe'],
    ['categoryId', 'not-a-uuid'],
    ['businessId', 'not-a-uuid'],
    ['limit', '101'],
    ['page', '0'],
  ])('rejects %s=%s', async (field, value) => {
    expect(await errorsFor(ProductAdminQueryDto, { [field]: value })).toEqual([field]);
  });

  it('rejects a search over 80 characters, accepts exactly 80', async () => {
    expect(await errorsFor(ProductAdminQueryDto, { search: 'x'.repeat(80) })).toEqual([]);
    expect(await errorsFor(ProductAdminQueryDto, { search: 'x'.repeat(81) })).toEqual(['search']);
  });
});

// Mirrors the app's global ValidationPipe({ whitelist, forbidNonWhitelisted }).
async function strictErrorsFor<T extends object>(cls: new () => T, plain: Record<string, unknown>) {
  const errors = await validate(plainToInstance(cls, plain), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((e) => e.property);
}

describe('ProductSummaryQueryDto', () => {
  it('accepts search/active/available (with the same coercion as the list)', async () => {
    const dto = plainToInstance(ProductSummaryQueryDto, { search: ' pizza ', active: 'false', available: 'true' });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.search).toBe('pizza');
    expect(dto.active).toBe(false);
    expect(dto.available).toBe(true);
  });

  it('keeps the list validators: invalid booleans, long search and bad businessId are rejected', async () => {
    expect(await errorsFor(ProductSummaryQueryDto, { active: 'yes' })).toEqual(['active']);
    expect(await errorsFor(ProductSummaryQueryDto, { available: '1' })).toEqual(['available']);
    expect(await errorsFor(ProductSummaryQueryDto, { search: 'x'.repeat(81) })).toEqual(['search']);
    expect(await errorsFor(ProductSummaryQueryDto, { businessId: 'nope' })).toEqual(['businessId']);
  });

  it('does NOT accept categoryId or pagination params (the breakdown is by category, over the whole filtered set)', async () => {
    expect(await strictErrorsFor(ProductSummaryQueryDto, { categoryId: '5f3b9a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b' })).toEqual(['categoryId']);
    expect(await strictErrorsFor(ProductSummaryQueryDto, { page: '1' })).toEqual(['page']);
    expect(await strictErrorsFor(ProductSummaryQueryDto, { limit: '20' })).toEqual(['limit']);
  });
});
