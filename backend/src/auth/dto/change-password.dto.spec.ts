import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { ChangePasswordDto } from './change-password.dto.js';

const errorsFor = async (body: unknown) =>
  (await validate(plainToInstance(ChangePasswordDto, body) as object, { whitelist: true, forbidNonWhitelisted: true })).map((e) => e.property).sort();

describe('ChangePasswordDto', () => {
  it('accepts exactly { currentPassword, newPassword }', async () => {
    expect(await errorsFor({ currentPassword: 'a', newPassword: 'b' })).toEqual([]);
  });

  it('requires both, as non-empty strings', async () => {
    expect(await errorsFor({})).toEqual(['currentPassword', 'newPassword']);
    expect(await errorsFor({ currentPassword: '', newPassword: '' })).toEqual(['currentPassword', 'newPassword']);
    expect(await errorsFor({ currentPassword: 1, newPassword: ['x'] })).toEqual(['currentPassword', 'newPassword']);
  });

  it('is a strict whitelist: any other field (id, email, role, credentialsVersion, mustChangePassword...) is rejected', async () => {
    for (const extra of ['id', 'email', 'role', 'businessId', 'credentialsVersion', 'mustChangePassword', 'userId']) {
      expect(await errorsFor({ currentPassword: 'a', newPassword: 'b', [extra]: 'x' }), extra).toEqual([extra]);
    }
  });

  it('caps the request size (not the policy)', async () => {
    expect(await errorsFor({ currentPassword: 'a'.repeat(1025), newPassword: 'b' })).toEqual(['currentPassword']);
    expect(await errorsFor({ currentPassword: 'a', newPassword: 'b'.repeat(1025) })).toEqual(['newPassword']);
    expect(await errorsFor({ currentPassword: 'a'.repeat(1024), newPassword: 'b'.repeat(1024) })).toEqual([]);
  });
});
