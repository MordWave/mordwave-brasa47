import { randomUUID } from 'node:crypto';

// Single source of truth for the SHAPE of an object-storage key. The DB CHECK
// constraints (entity @Check + the AddMediaStorageKeys migration) embed these
// same patterns, and the future /media endpoint validates with them before it
// ever talks to the bucket.
//
// Lowercase hex only, fixed length, anchored: a key can't contain "..", a
// leading slash, uppercase, or any segment other than the three below, so it
// can't address anything outside its own business prefix.
//
//   businesses/<businessId>/products/<productId>/<objectId>.webp
//   businesses/<businessId>/logo/<objectId>.webp
//   businesses/<businessId>/cover/<objectId>.webp
//
// <objectId> is a fresh uuid per upload, so every upload is a new immutable
// object and a replaced image is never served stale from a CDN/browser cache.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_REGEX = new RegExp(`^${UUID}$`);

// Strings (not just RegExps) because the same text is embedded in SQL.
// Valid as both a JS RegExp and a Postgres POSIX regex.
export const PRODUCT_IMAGE_KEY_PATTERN = `^businesses/${UUID}/products/${UUID}/${UUID}\\.webp$`;
// A business-level image lives directly under its business: logo and cover share one shape, only the folder differs.
type BusinessAssetFolder = 'logo' | 'cover';
const businessAssetKeyPattern = (folder: BusinessAssetFolder): string => `^businesses/${UUID}/${folder}/${UUID}\\.webp$`;

export const BUSINESS_LOGO_KEY_PATTERN = businessAssetKeyPattern('logo');
export const BUSINESS_COVER_KEY_PATTERN = businessAssetKeyPattern('cover');

const PRODUCT_IMAGE_KEY_REGEX = new RegExp(PRODUCT_IMAGE_KEY_PATTERN);
const BUSINESS_LOGO_KEY_REGEX = new RegExp(BUSINESS_LOGO_KEY_PATTERN);
const BUSINESS_COVER_KEY_REGEX = new RegExp(BUSINESS_COVER_KEY_PATTERN);

export function isProductImageKey(value: unknown): value is string {
  return typeof value === 'string' && PRODUCT_IMAGE_KEY_REGEX.test(value);
}

export function isBusinessLogoKey(value: unknown): value is string {
  return typeof value === 'string' && BUSINESS_LOGO_KEY_REGEX.test(value);
}

export function isBusinessCoverKey(value: unknown): value is string {
  return typeof value === 'string' && BUSINESS_COVER_KEY_REGEX.test(value);
}

export function isMediaKey(value: unknown): value is string {
  return isProductImageKey(value) || isBusinessLogoKey(value) || isBusinessCoverKey(value);
}

function assertUuid(name: string, value: string): void {
  if (!UUID_REGEX.test(value)) {
    throw new Error(`${name} must be a lowercase uuid`);
  }
}

// `objectId` is injectable for tests and for the one-off migration script;
// production callers leave it out and get a fresh uuid.
export function productImageKey(
  businessId: string,
  productId: string,
  objectId: string = randomUUID(),
): string {
  assertUuid('businessId', businessId);
  assertUuid('productId', productId);
  assertUuid('objectId', objectId);
  return `businesses/${businessId}/products/${productId}/${objectId}.webp`;
}

function businessAssetKey(folder: BusinessAssetFolder, businessId: string, objectId: string): string {
  assertUuid('businessId', businessId);
  assertUuid('objectId', objectId);
  return `businesses/${businessId}/${folder}/${objectId}.webp`;
}

export function businessLogoKey(businessId: string, objectId: string = randomUUID()): string {
  return businessAssetKey('logo', businessId, objectId);
}

export function businessCoverKey(businessId: string, objectId: string = randomUUID()): string {
  return businessAssetKey('cover', businessId, objectId);
}
