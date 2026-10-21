// Static technical ceilings. Plain literals (no DI, no env) so they can be
// used anywhere — including class-validator decorators and controller
// metadata, which are evaluated before Nest's container exists. Anything an
// operator may need to tune without a code change lives in
// config/resource-limits.config.ts instead (and takes its defaults from here).

// ---- Per-Business resource ceilings ----------------------------------------

export const BUSINESS_LIMITED_RESOURCES = ['product', 'category', 'table', 'user'] as const;
export type BusinessLimitedResource = (typeof BUSINESS_LIMITED_RESOURCES)[number];

// Technical ceilings, not commercial plans: they exist to keep one tenant
// from consuming the shared database, not to meter features.
export const DEFAULT_BUSINESS_LIMITS: Record<BusinessLimitedResource, number> = {
  product: 500,
  category: 50,
  table: 200,
  user: 20,
};

export const BUSINESS_LIMIT_ENV_VARS: Record<BusinessLimitedResource, string> = {
  product: 'BUSINESS_MAX_PRODUCTS',
  category: 'BUSINESS_MAX_CATEGORIES',
  table: 'BUSINESS_MAX_TABLES',
  user: 'BUSINESS_MAX_USERS',
};

// Machine-readable codes the frontend maps to friendly messages.
export const BUSINESS_LIMIT_ERROR_CODES: Record<BusinessLimitedResource, string> = {
  product: 'BUSINESS_PRODUCT_LIMIT_REACHED',
  category: 'BUSINESS_CATEGORY_LIMIT_REACHED',
  table: 'BUSINESS_TABLE_LIMIT_REACHED',
  user: 'BUSINESS_USER_LIMIT_REACHED',
};

// Sanity bound for configured values — rejects typos like 5000000 that would
// silently turn the ceiling into "no ceiling".
export const BUSINESS_LIMIT_MAX_CONFIGURABLE = 100_000;

// ---- Image upload ceilings (moved here verbatim — values unchanged) --------

// Pure infrastructure-level ceiling (protects the process from buffering an
// absurdly large upload at all) — the real, user-facing 10 MB business rule
// (IMAGE_MAX_FILE_SIZE_BYTES) is enforced with a proper structured error
// inside ImageStorageService.
export const IMAGE_MULTER_HARD_LIMIT_BYTES = 20 * 1024 * 1024;

export const IMAGE_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB, matches the bucket's own limit

// ~50 megapixels — comfortably above any phone camera's output, but bounded
// enough to reject a deliberately crafted "pixel bomb" before sharp decodes
// the full image into memory.
export const IMAGE_MAX_INPUT_PIXELS = 50_000_000;

export const IMAGE_MAX_OUTPUT_DIMENSION = 1200; // plenty for a menu card/detail view or a logo
// A welcome-screen cover fills the whole viewport (phones at 2-3x pixel density, desktop up to 1920 px wide), so it keeps
// more detail. Applied only to cover keys (see ImageStorageService); never enlarges a smaller image.
export const IMAGE_COVER_MAX_OUTPUT_DIMENSION = 1920;
export const IMAGE_OUTPUT_QUALITY = 80;
