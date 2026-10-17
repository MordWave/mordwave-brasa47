import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { CreateBusinessAdminDto } from './create-business-admin.dto.js';

const run = async (body: unknown) => {
  const dto = plainToInstance(CreateBusinessAdminDto, body);
  const errors = await validate(dto as object, { whitelist: true, forbidNonWhitelisted: true });
  return { dto, properties: errors.map((e) => e.property).sort() };
};

describe('CreateBusinessAdminDto', () => {
  it('accepts exactly { email } and normalises it like the login does (trim + lowercase)', async () => {
    const { dto, properties } = await run({ email: '  New.Admin@Example.TEST ' });
    expect(properties).toEqual([]);
    expect(dto.email).toBe('new.admin@example.test');
  });

  it('rejects anything that is not a plausible address, or too long, or not a string', async () => {
    for (const email of ['', 'plain', 'a@', '@b.test', 'a b@c.test', `${'a'.repeat(250)}@x.test`, 123, ['a@b.test'], null, undefined]) {
      expect((await run({ email })).properties, String(email)).toContain('email');
    }
  });

  it('is a strict whitelist: password, role, businessId, active, mustChangePassword, credentialsVersion, id... are refused', async () => {
    for (const extra of ['password', 'passwordHash', 'role', 'businessId', 'active', 'mustChangePassword', 'credentialsVersion', 'id']) {
      expect((await run({ email: 'a@b.test', [extra]: 'x' })).properties, extra).toEqual([extra]);
    }
  });
});
