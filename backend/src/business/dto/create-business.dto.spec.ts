import { ValidationPipe, type ArgumentMetadata } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { CreateBusinessDto } from './create-business.dto.js';

// The same pipe main.ts installs globally (whitelist + forbidNonWhitelisted + transform), so this proves what the
// real endpoint accepts, normalises and rejects — POST /businesses needs a JWT and is covered end to end in
// test/businesses-create.e2e-spec.ts as well.
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const meta: ArgumentMetadata = { type: 'body', metatype: CreateBusinessDto };
const run = (body: unknown) => pipe.transform(body, meta) as Promise<CreateBusinessDto>;
const rejects = async (body: unknown) => {
  const error = await run(body).catch((err: unknown) => err);
  expect(error).toMatchObject({ status: 400 });
};

describe('CreateBusinessDto', () => {
  it('accepts the minimum: name and slug', async () => {
    const dto = await run({ name: 'Nuevo Grill', slug: 'nuevo-grill' });
    expect(dto).toMatchObject({ name: 'Nuevo Grill', slug: 'nuevo-grill' });
  });

  it('normalises: trims the name, trims and lowercases the slug', async () => {
    const dto = await run({ name: '  Nuevo Grill  ', slug: '  Nuevo-GRILL ' });
    expect(dto.name).toBe('Nuevo Grill');
    expect(dto.slug).toBe('nuevo-grill');
  });

  it('blank optional fields are treated as not provided; others are trimmed', async () => {
    const dto = await run({ name: 'X Bar', slug: 'x-bar', address: '   ', phone: ' +56 9 ', hours: '' });
    expect(dto.address).toBeUndefined();
    expect(dto.phone).toBe('+56 9');
    expect(dto.hours).toBeUndefined();
  });

  it.each([
    ['empty', ''],
    ['too short', 'ab'],
    ['with a space', 'dos palabras'],
    ['with an accent', 'café-bar'],
    ['with an underscore', 'cafe_bar'],
    ['with a dot', 'cafe.bar'],
    ['with a slash', 'cafe/bar'],
    ['leading hyphen', '-cafe'],
    ['trailing hyphen', 'cafe-'],
    ['double hyphen', 'cafe--bar'],
    ['uppercase-only accent letter', 'ÑANDÚ'],
    ['too long', 'a'.repeat(61)],
  ])('rejects a slug that is %s', async (_label, slug) => {
    await rejects({ name: 'Valid', slug });
  });

  it('accepts the length boundaries (3 and 60) and digits', async () => {
    await expect(run({ name: 'V', slug: 'a1b' })).resolves.toBeDefined();
    await expect(run({ name: 'V', slug: 'a'.repeat(60) })).resolves.toBeDefined();
    await expect(run({ name: 'V', slug: '47' + '-x' })).resolves.toBeDefined();
  });

  it('rejects missing, blank or oversized names and non-string values', async () => {
    await rejects({ slug: 'valid-slug' });
    await rejects({ name: '   ', slug: 'valid-slug' });
    await rejects({ name: 'n'.repeat(121), slug: 'valid-slug' });
    await rejects({ name: 123, slug: 'valid-slug' });
    await rejects({ name: 'Valid', slug: 12345 });
    await rejects({ name: 'Valid' });
  });

  it('enforces the optional field ceilings', async () => {
    await rejects({ name: 'V', slug: 'valid', address: 'a'.repeat(201) });
    await rejects({ name: 'V', slug: 'valid', phone: 'p'.repeat(41) });
    await rejects({ name: 'V', slug: 'valid', hours: 'h'.repeat(201) });
  });

  it.each(['id', 'active', 'logoStorageKey', 'logoUrl', 'createdAt', 'updatedAt', 'primaryColor', 'accentColor', 'users', 'products', 'tables', 'orders', 'businessId'])(
    'rejects a client-supplied %s (forbidNonWhitelisted)',
    async (field) => {
      await rejects({ name: 'Valid', slug: 'valid', [field]: field === 'active' ? false : 'x' });
    },
  );
});
