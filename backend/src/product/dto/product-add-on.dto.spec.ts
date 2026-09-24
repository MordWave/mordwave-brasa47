import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { ProductAddOnDto } from './product-add-on.dto.js';

// DTO-level validation, exercised directly via class-validator instead of
// through an authenticated HTTP request — POST/PATCH /products both
// require a JWT, and this project's e2e specs deliberately never
// authenticate (no fixtures), so this is the only layer that can actually
// reach these constraints.
describe('ProductAddOnDto', () => {
  it('accepts a valid add-on', async () => {
    const dto = plainToInstance(ProductAddOnDto, { name: 'Queso extra', price: 1200 });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it('rejects an empty name', async () => {
    const dto = plainToInstance(ProductAddOnDto, { name: '', price: 1200 });

    const errors = await validate(dto);

    expect(errors.some((e) => e.property === 'name')).toBe(true);
  });

  it('rejects a name over the 60-character limit', async () => {
    const dto = plainToInstance(ProductAddOnDto, { name: 'x'.repeat(61), price: 1200 });

    const errors = await validate(dto);

    expect(errors.some((e) => e.property === 'name')).toBe(true);
  });

  it('rejects a missing name', async () => {
    const dto = plainToInstance(ProductAddOnDto, { price: 1200 });

    const errors = await validate(dto);

    expect(errors.some((e) => e.property === 'name')).toBe(true);
  });

  it('rejects a negative price', async () => {
    const dto = plainToInstance(ProductAddOnDto, { name: 'Tocino', price: -1 });

    const errors = await validate(dto);

    expect(errors.some((e) => e.property === 'price')).toBe(true);
  });

  it('rejects a price over the 100,000 CLP maximum', async () => {
    const dto = plainToInstance(ProductAddOnDto, { name: 'Tocino', price: 100_001 });

    const errors = await validate(dto);

    expect(errors.some((e) => e.property === 'price')).toBe(true);
  });

  it('rejects an invalid shape (price as a non-numeric string)', async () => {
    const dto = plainToInstance(ProductAddOnDto, { name: 'Tocino', price: 'gratis' });

    const errors = await validate(dto);

    expect(errors.some((e) => e.property === 'price')).toBe(true);
  });
});
