import { describe, expect, it } from 'vitest';
import { COVER_KEY_CASES, LOGO_KEY_CASES, PRODUCT_KEY_CASES } from '../../test/support/media-key-cases.js';
import {
  BUSINESS_COVER_KEY_PATTERN,
  BUSINESS_LOGO_KEY_PATTERN,
  businessCoverKey,
  businessLogoKey,
  isBusinessCoverKey,
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

describe('businessCoverKey', () => {
  it('builds the exact documented layout, a different object id every call, and the result always validates', () => {
    expect(businessCoverKey(BIZ, OBJ)).toBe(`businesses/${BIZ}/cover/${OBJ}.webp`);
    const a = businessCoverKey(BIZ);
    expect(a).not.toBe(businessCoverKey(BIZ));
    expect(isBusinessCoverKey(a)).toBe(true);
    expect(a.startsWith(`businesses/${BIZ}/cover/`)).toBe(true);
  });

  it.each([
    ['uppercase uuid', BIZ.toUpperCase()],
    ['path traversal', '../..'],
    ['slash', `${BIZ}/x`],
    ['empty', ''],
    ['not a uuid', 'abc'],
  ])('refuses to build a key from %s', (_label, bad) => {
    expect(() => businessCoverKey(bad, OBJ)).toThrow();
    expect(() => businessCoverKey(BIZ, bad)).toThrow();
  });

  it('the key is always under the business it was built for (no way to address another business)', () => {
    const other = 'dddddddd-4444-4abc-8def-444444444abc';
    expect(businessCoverKey(other, OBJ)).toBe(`businesses/${other}/cover/${OBJ}.webp`);
    expect(businessCoverKey(other, OBJ)).not.toContain(BIZ);
  });
});

describe('logo and cover patterns', () => {
  it('the logo pattern is unchanged (frozen migrations and the CHECK in the database depend on its exact text)', () => {
    const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
    expect(BUSINESS_LOGO_KEY_PATTERN).toBe(`^businesses/${UUID}/logo/${UUID}\\.webp$`);
    expect(BUSINESS_COVER_KEY_PATTERN).toBe(`^businesses/${UUID}/cover/${UUID}\\.webp$`);
  });

  it('a logo key is never a cover key and vice versa', () => {
    expect(isBusinessCoverKey(businessLogoKey(BIZ, OBJ))).toBe(false);
    expect(isBusinessLogoKey(businessCoverKey(BIZ, OBJ))).toBe(false);
    expect(isProductImageKey(businessCoverKey(BIZ, OBJ))).toBe(false);
  });
});

describe('key validators', () => {
  it.each(PRODUCT_KEY_CASES)('product image key: %s', (_label, key, valid) => {
    expect(isProductImageKey(key)).toBe(valid);
  });

  it.each(LOGO_KEY_CASES)('business logo key: %s', (_label, key, valid) => {
    expect(isBusinessLogoKey(key)).toBe(valid);
  });

  it.each(COVER_KEY_CASES)('business cover key: %s', (_label, key, valid) => {
    expect(isBusinessCoverKey(key)).toBe(valid);
  });

  it('isMediaKey accepts the three shapes (product image, logo, cover) and rejects non-strings', () => {
    expect(isMediaKey(productImageKey(BIZ, PROD, OBJ))).toBe(true);
    expect(isMediaKey(businessLogoKey(BIZ, OBJ))).toBe(true);
    expect(isMediaKey(businessCoverKey(BIZ, OBJ))).toBe(true);
    for (const [, key, valid] of COVER_KEY_CASES) if (!valid) expect(isMediaKey(key) && !isBusinessLogoKey(key) && !isProductImageKey(key)).toBe(false);
    expect(isMediaKey(undefined)).toBe(false);
    expect(isMediaKey(null)).toBe(false);
    expect(isMediaKey(42)).toBe(false);
  });
});
