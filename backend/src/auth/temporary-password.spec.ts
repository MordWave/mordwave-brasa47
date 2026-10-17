import { describe, expect, it } from 'vitest';
import { checkNewPassword } from './password-policy.js';
import { generateTemporaryPassword, TEMPORARY_PASSWORD_ALPHABET } from './temporary-password.js';

describe('generateTemporaryPassword', () => {
  const pattern = new RegExp(`^[${TEMPORARY_PASSWORD_ALPHABET}]{5}(-[${TEMPORARY_PASSWORD_ALPHABET}]{5}){3}$`);

  it('is four dash-separated groups of five characters from the unambiguous alphabet (no 0, O, o, 1, l, I)', () => {
    for (let i = 0; i < 200; i += 1) expect(generateTemporaryPassword()).toMatch(pattern);
    expect(TEMPORARY_PASSWORD_ALPHABET).not.toMatch(/[0Oo1lI]/);
    expect(new Set(TEMPORARY_PASSWORD_ALPHABET).size).toBe(TEMPORARY_PASSWORD_ALPHABET.length); // no repeated symbol
    expect(TEMPORARY_PASSWORD_ALPHABET).toHaveLength(56);
  });

  it('always satisfies the password policy a user password must satisfy (≥ 12 characters, ≤ 72 bytes)', () => {
    for (let i = 0; i < 200; i += 1) {
      const password = generateTemporaryPassword();
      expect(checkNewPassword(password, 'admin@example.test')).toBeNull();
      expect(password).toHaveLength(23);
      expect(Buffer.byteLength(password, 'utf8')).toBe(23);
    }
  });

  it('is random: no repeats in thousands of draws, and every symbol of the alphabet shows up', () => {
    const seen = new Set<string>();
    const symbols = new Set<string>();
    for (let i = 0; i < 3000; i += 1) {
      const password = generateTemporaryPassword();
      expect(seen.has(password)).toBe(false);
      seen.add(password);
      for (const ch of password.replaceAll('-', '')) symbols.add(ch);
    }
    expect(symbols.size).toBe(TEMPORARY_PASSWORD_ALPHABET.length);
  });

  it('comes from the CSPRNG, not Math.random', () => {
    const original = Math.random;
    Math.random = () => {
      throw new Error('Math.random must not be used for credentials');
    };
    try {
      expect(() => generateTemporaryPassword()).not.toThrow();
    } finally {
      Math.random = original;
    }
  });
});
