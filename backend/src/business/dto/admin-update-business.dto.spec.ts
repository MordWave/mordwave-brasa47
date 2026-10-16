import { ValidationPipe, type ArgumentMetadata } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AdminUpdateBusinessDto } from './admin-update-business.dto.js';
import { DeactivateBusinessDto } from './deactivate-business.dto.js';
import { UpdateBusinessDto } from './update-business.dto.js';

// The same pipe main.ts installs globally, so this is what the endpoints really accept, normalise and reject.
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const run = <T>(metatype: new () => T, body: unknown) => pipe.transform(body, { type: 'body', metatype } as ArgumentMetadata) as Promise<T>;
const rejects = async <T>(metatype: new () => T, body: unknown) => {
  expect(await run(metatype, body).catch((e: unknown) => e)).toMatchObject({ status: 400 });
};

describe('AdminUpdateBusinessDto (PATCH /businesses/:id)', () => {
  it('accepts any subset of name/address/phone/hours, trimmed; an empty body is valid', async () => {
    expect(await run(AdminUpdateBusinessDto, {})).toEqual({});
    const dto = await run(AdminUpdateBusinessDto, { name: '  Nuevo  ', phone: ' +56 9 ' });
    expect(dto).toMatchObject({ name: 'Nuevo', phone: '+56 9' });
  });

  it('a blank string or null clears the optional fields (null); the name cannot be blank, null or non-string', async () => {
    const dto = await run(AdminUpdateBusinessDto, { address: '   ', phone: null, hours: '' });
    expect(dto).toMatchObject({ address: null, phone: null, hours: null });
    await rejects(AdminUpdateBusinessDto, { name: '   ' });
    await rejects(AdminUpdateBusinessDto, { name: '' });
    await rejects(AdminUpdateBusinessDto, { name: null });
    await rejects(AdminUpdateBusinessDto, { name: 123 });
    await rejects(AdminUpdateBusinessDto, { address: 5 });
  });

  it.each(['slug', 'id', 'active', 'primaryColor', 'accentColor', 'logoStorageKey', 'logoUrl', 'createdAt', 'updatedAt', 'users', 'products', 'tables', 'orders', 'businessId'])(
    'rejects %s (not editable here)',
    async (field) => {
      await rejects(AdminUpdateBusinessDto, { name: 'Valido', [field]: field === 'active' ? false : 'x' });
    },
  );

  it('has the same length ceilings as UpdateBusinessDto (PATCH /businesses/me) — the validations are reused, not loosened', async () => {
    const cases: Array<[string, number]> = [['name', 120], ['address', 200], ['phone', 40], ['hours', 200]];
    for (const [field, max] of cases) {
      await expect(run(UpdateBusinessDto, { [field]: 'x'.repeat(max) })).resolves.toBeDefined();
      await expect(run(AdminUpdateBusinessDto, { [field]: 'x'.repeat(max) })).resolves.toBeDefined();
      await rejects(UpdateBusinessDto, { [field]: 'x'.repeat(max + 1) });
      await rejects(AdminUpdateBusinessDto, { [field]: 'x'.repeat(max + 1) });
    }
  });
});

describe('DeactivateBusinessDto (POST /businesses/:id/deactivate)', () => {
  it('reason is optional, trimmed, and a blank reason means none', async () => {
    expect(await run(DeactivateBusinessDto, {})).toEqual({});
    expect(await run(DeactivateBusinessDto, { reason: '  Falta de pago ' })).toMatchObject({ reason: 'Falta de pago' });
    expect((await run(DeactivateBusinessDto, { reason: '   ' })).reason).toBeUndefined();
  });

  it('reason is capped at 200 characters and must be a string', async () => {
    await expect(run(DeactivateBusinessDto, { reason: 'r'.repeat(200) })).resolves.toBeDefined();
    await rejects(DeactivateBusinessDto, { reason: 'r'.repeat(201) });
    await rejects(DeactivateBusinessDto, { reason: 42 });
  });

  it.each(['acknowledgePendingOrders', 'force', 'active', 'closeSessions', 'id'])('accepts nothing else: %s -> 400', async (field) => {
    await rejects(DeactivateBusinessDto, { [field]: true });
  });
});
