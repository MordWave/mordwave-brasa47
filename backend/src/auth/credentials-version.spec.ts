import { describe, expect, it } from 'vitest';
import { readTokenCredentialsVersion } from './credentials-version.js';

describe('readTokenCredentialsVersion', () => {
  it('a missing claim (a token issued before cv existed) is version 0', () => {
    expect(readTokenCredentialsVersion(undefined)).toBe(0);
  });

  it('accepts non-negative safe integers', () => {
    for (const v of [0, 1, 2, 41, Number.MAX_SAFE_INTEGER]) expect(readTokenCredentialsVersion(v)).toBe(v);
  });

  it.each([['string', '0'], ['numeric string', '1'], ['float', 1.5], ['negative', -1], ['negative zero is fine as 0? no: -0 is a number equal to 0', -0.5], ['null', null], ['NaN', Number.NaN], ['Infinity', Number.POSITIVE_INFINITY], ['object', {}], ['array', [0]], ['boolean', true], ['unsafe integer', 2 ** 53]])(
    'refuses a malformed claim (%s)',
    (_label, claim) => {
      expect(readTokenCredentialsVersion(claim)).toBeNull();
    },
  );
});
