import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BCRYPT_COST, PASSWORD_MAX_BYTES, PASSWORD_MIN_LENGTH } from './constants.js';

// The CLI is a standalone tool: nothing outside this folder may import it and it imports nothing from the backend. The
// API's password policy (src/auth/password-policy.ts) must nevertheless stay in step with it, so the numbers are
// compared here from the API's SOURCE TEXT.
describe('SUPER_ADMIN CLI and POST /auth/change-password share one password policy', () => {
  const api = readFileSync(new URL('../../auth/password-policy.ts', import.meta.url), 'utf8');
  const apiNumber = (name: string): number => Number(new RegExp(`export const ${name} = (\\d+);`).exec(api)![1]);

  it('same minimum length, same byte ceiling, same bcrypt cost', () => {
    expect(apiNumber('PASSWORD_MIN_LENGTH')).toBe(PASSWORD_MIN_LENGTH);
    expect(apiNumber('PASSWORD_MAX_BYTES')).toBe(PASSWORD_MAX_BYTES);
    expect(apiNumber('PASSWORD_BCRYPT_COST')).toBe(BCRYPT_COST);
  });
});
