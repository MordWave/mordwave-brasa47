// Shared by the unit spec (util regex) and the e2e spec (real DB CHECK
// constraints) so the two can never disagree about what a valid key is.
const BIZ = 'aaaaaaaa-1111-4abc-8def-111111111abc';
const PROD = 'bbbbbbbb-2222-4abc-8def-222222222abc';
const OBJ = 'cccccccc-3333-4abc-8def-333333333abc';

export const PRODUCT_KEY_CASES: ReadonlyArray<readonly [string, string, boolean]> = [
  ['valid', `businesses/${BIZ}/products/${PROD}/${OBJ}.webp`, true],
  ['uppercase hex', `businesses/${BIZ.toUpperCase()}/products/${PROD}/${OBJ}.webp`, false],
  ['wrong extension', `businesses/${BIZ}/products/${PROD}/${OBJ}.png`, false],
  ['no extension', `businesses/${BIZ}/products/${PROD}/${OBJ}`, false],
  ['leading slash', `/businesses/${BIZ}/products/${PROD}/${OBJ}.webp`, false],
  ['wrong root', `tenants/${BIZ}/products/${PROD}/${OBJ}.webp`, false],
  ['traversal', `businesses/${BIZ}/products/../${PROD}/${OBJ}.webp`, false],
  ['extra segment', `businesses/${BIZ}/products/${PROD}/x/${OBJ}.webp`, false],
  ['trailing newline', `businesses/${BIZ}/products/${PROD}/${OBJ}.webp\n`, false],
  ['trailing text', `businesses/${BIZ}/products/${PROD}/${OBJ}.webp.exe`, false],
  ['logo shape', `businesses/${BIZ}/logo/${OBJ}.webp`, false],
  ['cover shape', `businesses/${BIZ}/cover/${OBJ}.webp`, false],
  ['legacy supabase path', `${BIZ}/${PROD}/imagen.webp`, false],
  ['empty', '', false],
];

export const LOGO_KEY_CASES: ReadonlyArray<readonly [string, string, boolean]> = [
  ['valid', `businesses/${BIZ}/logo/${OBJ}.webp`, true],
  ['uppercase hex', `businesses/${BIZ}/logo/${OBJ.toUpperCase()}.webp`, false],
  ['wrong extension', `businesses/${BIZ}/logo/${OBJ}.jpg`, false],
  ['traversal', `businesses/${BIZ}/logo/../${OBJ}.webp`, false],
  ['trailing newline', `businesses/${BIZ}/logo/${OBJ}.webp\n`, false],
  ['product shape', `businesses/${BIZ}/products/${PROD}/${OBJ}.webp`, false],
  ['cover shape', `businesses/${BIZ}/cover/${OBJ}.webp`, false],
  ['legacy supabase path', `business-logos/${BIZ}/logo.webp`, false],
  ['empty', '', false],
];

export const COVER_KEY_CASES: ReadonlyArray<readonly [string, string, boolean]> = [
  ['valid', `businesses/${BIZ}/cover/${OBJ}.webp`, true],
  ['uppercase hex business id', `businesses/${BIZ.toUpperCase()}/cover/${OBJ}.webp`, false],
  ['uppercase hex object id', `businesses/${BIZ}/cover/${OBJ.toUpperCase()}.webp`, false],
  ['wrong extension', `businesses/${BIZ}/cover/${OBJ}.jpg`, false],
  ['no extension', `businesses/${BIZ}/cover/${OBJ}`, false],
  ['double extension', `businesses/${BIZ}/cover/${OBJ}.webp.exe`, false],
  ['leading slash', `/businesses/${BIZ}/cover/${OBJ}.webp`, false],
  ['wrong root', `tenants/${BIZ}/cover/${OBJ}.webp`, false],
  ['traversal', `businesses/${BIZ}/cover/../${OBJ}.webp`, false],
  ['traversal to another business', `businesses/${BIZ}/cover/../../${OBJ.replace('cccccccc', 'dddddddd')}/cover/${OBJ}.webp`, false],
  ['extra segment', `businesses/${BIZ}/cover/x/${OBJ}.webp`, false],
  ['two keys concatenated', `businesses/${BIZ}/cover/${OBJ}.webpbusinesses/${BIZ}/cover/${OBJ}.webp`, false],
  ['url instead of a key', `https://evil.example/businesses/${BIZ}/cover/${OBJ}.webp`, false],
  ['trailing newline', `businesses/${BIZ}/cover/${OBJ}.webp\n`, false],
  ['logo shape', `businesses/${BIZ}/logo/${OBJ}.webp`, false],
  ['product shape', `businesses/${BIZ}/products/${PROD}/${OBJ}.webp`, false],
  ['folder in another case', `businesses/${BIZ}/Cover/${OBJ}.webp`, false],
  ['legacy supabase path', `business-covers/${BIZ}/cover.webp`, false],
  ['empty', '', false],
];
