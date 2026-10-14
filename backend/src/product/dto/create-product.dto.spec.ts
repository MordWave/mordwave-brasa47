// Required for @Type()/@ValidateNested (used on addOns below) to work at
// all outside a full Nest app bootstrap — those decorators read type
// metadata via Reflect.getMetadata, which only exists once this polyfill
// has run. main.ts/data-source.ts get it for free as a side effect of
// importing the rest of the app; this spec imports the DTO in isolation,
// so it needs its own copy.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { CreateProductDto } from './create-product.dto.js';
import { UpdateProductDto } from './update-product.dto.js';

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


// Images only ever enter through POST /products/:id/image. The row's image
// fields are never writable from a JSON body — not the legacy URL, not the
// storage key, in either spelling — on create or update.
describe('product DTOs — image fields are not client-writable', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const base = {
    name: 'Clásica Brasa',
    price: 6900,
    businessId: '11111111-1111-4111-8111-111111111111',
    categoryId: '22222222-2222-4222-8222-222222222222',
  };
  const KEY = 'businesses/aaaaaaaa-1111-4abc-8def-111111111abc/products/bbbbbbbb-2222-4abc-8def-222222222abc/cccccccc-3333-4abc-8def-333333333abc.webp';
  const forbidden: Array<[string, unknown]> = [
    ['imageUrl', 'https://evil.example/x.png'],
    ['image_url', 'https://evil.example/x.png'],
    ['imageStorageKey', KEY],
    ['image_storage_key', KEY],
  ];

  it('the control body (no image field) is accepted', async () => {
    await expect(pipe.transform(base, { type: 'body', metatype: CreateProductDto })).resolves.toMatchObject(base);
    await expect(pipe.transform({ name: 'x' }, { type: 'body', metatype: UpdateProductDto })).resolves.toBeDefined();
  });

  it.each(forbidden)('CreateProductDto rejects %s', async (field, value) => {
    await expect(
      pipe.transform({ ...base, [field]: value }, { type: 'body', metatype: CreateProductDto }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it.each(forbidden)('UpdateProductDto rejects %s', async (field, value) => {
    await expect(
      pipe.transform({ name: 'x', [field]: value }, { type: 'body', metatype: UpdateProductDto }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
