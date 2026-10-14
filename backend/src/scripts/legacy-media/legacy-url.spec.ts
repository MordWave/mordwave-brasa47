import { describe, expect, it } from 'vitest';
import { expectedLegacyObjectPath, looksLikeWebp, parseLegacyUrl } from './legacy-url.js';
import { SUPABASE_BUCKET, SUPABASE_HOST, productUrl, webp } from '../../../test/support/legacy-media-doubles.js';

const ctx = { supabaseHost: SUPABASE_HOST, bucket: SUPABASE_BUCKET };
const BIZ = 'aaaaaaaa-1111-4abc-8def-111111111abc';
const PROD = 'bbbbbbbb-2222-4abc-8def-222222222abc';

describe('parseLegacyUrl', () => {
  it('extracts the object path of a public Supabase URL (ignoring the ?v= cache buster)', () => {
    expect(parseLegacyUrl(productUrl(BIZ, PROD, 1700000000000), ctx)).toEqual({
      kind: 'supabase',
      objectPath: `${BIZ}/${PROD}/imagen.webp`,
    });
  });

  it.each([
    ['another host', `https://evil.example/storage/v1/object/public/${SUPABASE_BUCKET}/${BIZ}/${PROD}/imagen.webp`],
    ['another bucket', `https://${SUPABASE_HOST}/storage/v1/object/public/other/${BIZ}/${PROD}/imagen.webp`],
    ['a signed (non-public) URL', `https://${SUPABASE_HOST}/storage/v1/object/sign/${SUPABASE_BUCKET}/${BIZ}/${PROD}/imagen.webp?token=x`],
    ['http', `http://${SUPABASE_HOST}/storage/v1/object/public/${SUPABASE_BUCKET}/${BIZ}/${PROD}/imagen.webp`],
    ['credentials in the URL', `https://u:p@${SUPABASE_HOST}/storage/v1/object/public/${SUPABASE_BUCKET}/${BIZ}/${PROD}/imagen.webp`],
    ['an encoded traversal path', `https://${SUPABASE_HOST}/storage/v1/object/public/${SUPABASE_BUCKET}/${BIZ}%2F..%2Fx.webp`],
    ['a railway /media URL', 'https://api.example.test/media/businesses/x/logo/y.webp'],
    ['garbage', 'not a url'],
  ])('treats %s as not Supabase', (_label, url) => {
    expect(parseLegacyUrl(url, ctx)).toEqual({ kind: 'other' });
  });
});

describe('expectedLegacyObjectPath', () => {
  it('matches the layout the old upload code used', () => {
    expect(expectedLegacyObjectPath('product', BIZ, PROD)).toBe(`${BIZ}/${PROD}/imagen.webp`);
    expect(expectedLegacyObjectPath('logo', BIZ, BIZ)).toBe(`business-logos/${BIZ}/logo.webp`);
  });
});

describe('looksLikeWebp', () => {
  it('accepts a RIFF/WEBP container only', () => {
    expect(looksLikeWebp(webp('x'))).toBe(true);
    expect(looksLikeWebp(Buffer.from('<html>not an image</html>'))).toBe(false);
    expect(looksLikeWebp(Buffer.from('RIFF'))).toBe(false);
    expect(looksLikeWebp(Buffer.alloc(0))).toBe(false);
  });
});
