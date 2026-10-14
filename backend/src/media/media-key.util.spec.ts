import { describe, expect, it } from 'vitest';
import { LOGO_KEY_CASES, PRODUCT_KEY_CASES } from '../../test/support/media-key-cases.js';
import {
  businessLogoKey,
  isBusinessLogoKey,
  isMediaKey,
  isProductImageKey,
  productImageKey,
} from './media-key.util.js';

const BIZ = 'aaaaaaaa-1111-4abc-8def-111111111abc';
const PROD = 'bbbbbbbb-2222-4abc-8def-222222222abc';
const OBJ = 'cccccccc-3333-4abc-8def-333333333abc';

describe('productImageKey / businessLogoKey', () => {
  it('builds the exact documented layout', () => {
    expect(productImageKey(BIZ, PROD, OBJ)).toBe(`businesses/${BIZ}/products/${PROD}/${OBJ}.webp`);
    expect(businessLogoKey(BIZ, OBJ)).toBe(`businesses/${BIZ}/logo/${OBJ}.webp`);
  });

  it('generates a different object id on every call and the result always validates', () => {
    const a = productImageKey(BIZ, PROD);
    const b = productImageKey(BIZ, PROD);
    expect(a).not.toBe(b);
    expect(isProductImageKey(a)).toBe(true);
    const c = businessLogoKey(BIZ);
    expect(c).not.toBe(businessLogoKey(BIZ));
    expect(isBusinessLogoKey(c)).toBe(true);
  });

  it.each([
    ['uppercase uuid', BIZ.toUpperCase()],
    ['path traversal', '../..'],
    ['slash', `${BIZ}/x`],
    ['empty', ''],
    ['not a uuid', 'abc'],
  ])('refuses to build a key from %s', (_label, bad) => {
    expect(() => productImageKey(bad, PROD, OBJ)).toThrow();
    expect(() => productImageKey(BIZ, bad, OBJ)).toThrow();
    expect(() => productImageKey(BIZ, PROD, bad)).toThrow();
    expect(() => businessLogoKey(bad, OBJ)).toThrow();
    expect(() => businessLogoKey(BIZ, bad)).toThrow();
  });
});

describe('key validators', () => {
  it.each(PRODUCT_KEY_CASES)('product image key: %s', (_label, key, valid) => {
    expect(isProductImageKey(key)).toBe(valid);
  });

  it.each(LOGO_KEY_CASES)('business logo key: %s', (_label, key, valid) => {
    expect(isBusinessLogoKey(key)).toBe(valid);
  });

  it('isMediaKey accepts either shape and rejects non-strings', () => {
    expect(isMediaKey(productImageKey(BIZ, PROD, OBJ))).toBe(true);
    expect(isMediaKey(businessLogoKey(BIZ, OBJ))).toBe(true);
    expect(isMediaKey(undefined)).toBe(false);
    expect(isMediaKey(null)).toBe(false);
    expect(isMediaKey(42)).toBe(false);
  });
});
