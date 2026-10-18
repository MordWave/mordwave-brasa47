import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { DeleteBusinessAdminDto } from './delete-business-admin.dto.js';

const run = async (body: unknown) => {
  const dto = plainToInstance(DeleteBusinessAdminDto, body);
  const errors = await validate(dto as object, { whitelist: true, forbidNonWhitelisted: true });
  return { dto, properties: errors.map((e) => e.property).sort() };
};

describe('DeleteBusinessAdminDto', () => {
  it('accepts exactly { confirmEmail } and normalises it (trim + lowercase)', async () => {
    const { dto, properties } = await run({ confirmEmail: '  Some.Admin@Example.TEST ' });
    expect(properties).toEqual([]);
    expect(dto.confirmEmail).toBe('some.admin@example.test');
  });

  it('rejects a missing, empty, malformed, too long or non-string confirmation', async () => {
    for (const confirmEmail of ['', 'plain', 'a@', `${'a'.repeat(250)}@x.test`, 123, ['a@b.test'], null, undefined]) {
      expect((await run({ confirmEmail })).properties, String(confirmEmail)).toContain('confirmEmail');
    }
  });

  it('is a strict whitelist: nothing but the confirmation may be sent', async () => {
    for (const extra of ['force', 'email', 'reason', 'businessId', 'role', 'id']) {
      expect((await run({ confirmEmail: 'a@b.test', [extra]: 'x' })).properties, extra).toEqual([extra]);
    }
  });
});
