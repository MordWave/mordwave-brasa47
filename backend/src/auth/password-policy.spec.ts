import { describe, expect, it } from 'vitest';
import {
  checkNewPassword,
  PASSWORD_BCRYPT_COST,
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
  PASSWORD_VIOLATION_MESSAGES,
} from './password-policy.js';

const EMAIL = 'admin@brasa47.cl';

describe('checkNewPassword', () => {
  it('uses 12 characters, 72 bytes and bcrypt cost 12 (kept in step with the SUPER_ADMIN CLI by a test next to the CLI)', () => {
    expect([PASSWORD_MIN_LENGTH, PASSWORD_MAX_BYTES, PASSWORD_BCRYPT_COST]).toEqual([12, 72, 12]);
  });

  it('accepts exactly 12 characters and exactly 72 bytes', () => {
    expect(checkNewPassword('a'.repeat(12), EMAIL)).toBeNull();
    expect(checkNewPassword('a'.repeat(72), EMAIL)).toBeNull();
  });

  it('rejects 11 characters and 73 bytes', () => {
    expect(checkNewPassword('a'.repeat(11), EMAIL)).toBe('PASSWORD_TOO_SHORT');
    expect(checkNewPassword('a'.repeat(73), EMAIL)).toBe('PASSWORD_TOO_LONG');
  });

  it('counts the ceiling in UTF-8 BYTES (bcrypt truncates at 72 bytes), the minimum in code points', () => {
    expect(checkNewPassword('ñ'.repeat(36), EMAIL)).toBeNull(); // 36 chars = 72 bytes
    expect(checkNewPassword('ñ'.repeat(37), EMAIL)).toBe('PASSWORD_TOO_LONG'); // 74 bytes, only 37 characters
    expect(checkNewPassword('😀'.repeat(18), EMAIL)).toBeNull(); // 18 code points = 72 bytes
    expect(checkNewPassword('😀'.repeat(19), EMAIL)).toBe('PASSWORD_TOO_LONG');
    expect(checkNewPassword('😀'.repeat(11), EMAIL)).toBe('PASSWORD_TOO_SHORT'); // 11 code points, 44 bytes
    expect(checkNewPassword('😀'.repeat(12), EMAIL)).toBeNull();
  });

  it('rejects an empty or blank password and the email address (any case, surrounding spaces)', () => {
    expect(checkNewPassword('', EMAIL)).toBe('PASSWORD_REQUIRED');
    expect(checkNewPassword(' '.repeat(20), EMAIL)).toBe('PASSWORD_REQUIRED');
    expect(checkNewPassword('ADMIN@Brasa47.CL', EMAIL)).toBe('PASSWORD_EQUALS_EMAIL');
    expect(checkNewPassword('  admin@brasa47.cl ', EMAIL)).toBe('PASSWORD_EQUALS_EMAIL');
  });

  it('does not trim: surrounding spaces are part of the password', () => {
    expect(checkNewPassword(` ${'a'.repeat(10)} `, EMAIL)).toBeNull(); // 12 characters including the spaces
  });

  it('every violation has a message that never contains a password', () => {
    for (const message of Object.values(PASSWORD_VIOLATION_MESSAGES)) expect(message).not.toMatch(/\$2[aby]\$/);
    expect(Object.keys(PASSWORD_VIOLATION_MESSAGES).sort()).toEqual(['PASSWORD_EQUALS_EMAIL', 'PASSWORD_REQUIRED', 'PASSWORD_TOO_LONG', 'PASSWORD_TOO_SHORT']);
  });
});
