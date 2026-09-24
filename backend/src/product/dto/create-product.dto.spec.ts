// Required for @Type()/@ValidateNested (used on addOns below) to work at
// all outside a full Nest app bootstrap — those decorators read type
// metadata via Reflect.getMetadata, which only exists once this polyfill
// has run. main.ts/data-source.ts get it for free as a side effect of
// importing the rest of the app; this spec imports the DTO in isolation,
// so it needs its own copy.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { CreateProductDto } from './create-product.dto.js';

// Same reasoning as product-add-on.dto.spec.ts: this is the only layer
// that can actually reach these constraints without a real JWT/fixtures.
describe('CreateProductDto — personalization fields', () => {
  const base = {
    name: 'Clásica Brasa',
    price: 6900,
    businessId: '11111111-1111-4111-8111-111111111111',
    categoryId: '22222222-2222-4222-8222-222222222222',
  };

  it('accepts a valid tag/ingredients/removableIngredients/addOns combination', async () => {
    const dto = plainToInstance(CreateProductDto, {
      ...base,
      tag: 'Más pedido',
      ingredients: ['Carne', 'Pan', 'Queso'],
      removableIngredients: ['Queso'],
      addOns: [{ name: 'Queso extra', price: 1200 }],
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it('rejects more than 15 add-ons', async () => {
    const dto = plainToInstance(CreateProductDto, {
      ...base,
      addOns: Array.from({ length: 16 }, (_, i) => ({ name: `Extra ${i}`, price: 100 })),
    });

    const errors = await validate(dto);

    expect(errors.some((e) => e.property === 'addOns')).toBe(true);
  });

  it('rejects an add-on with an invalid shape nested inside addOns (empty name, negative price)', async () => {
    const dto = plainToInstance(CreateProductDto, {
      ...base,
      addOns: [{ name: '', price: -5 }],
    });

    const errors = await validate(dto);

    const addOnsError = errors.find((e) => e.property === 'addOns');
    expect(addOnsError).toBeDefined();
    // @ValidateNested surfaces the nested ProductAddOnDto's own errors
    // under .children[index].children — confirms the nested shape is
    // actually being validated, not just "addOns is an array".
    expect(addOnsError?.children?.[0]?.children?.length).toBeGreaterThan(0);
  });
});
