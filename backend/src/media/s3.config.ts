// Strict configuration for the Railway Bucket S3 client.
//
// Reads the variables Railway already references into the backend service
// (AWS_*, see `railway variables`) — nothing else, no secrets are copied.
//
//   AWS_ENDPOINT_URL          https endpoint, e.g. https://t3.storageapi.dev
//   AWS_S3_BUCKET_NAME        the bucket name to use on the S3 API
//   AWS_DEFAULT_REGION        region string used for SigV4 signing
//   AWS_ACCESS_KEY_ID
//   AWS_SECRET_ACCESS_KEY
//   AWS_S3_FORCE_PATH_STYLE   optional, "true" | "false" (default "false")
//
// Railway's docs: buckets use virtual-hosted-style URLs by default; older
// buckets "might require path-style". Which one applies is shown in the
// bucket's Credentials tab, so it is an explicit switch and not guessed.

export const S3_CONFIG = Symbol('S3_CONFIG');

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

const REQUIRED = [
  'AWS_ENDPOINT_URL',
  'AWS_S3_BUCKET_NAME',
  'AWS_DEFAULT_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
] as const;

// Only the two Railway-specific variables switch the feature on. Generic
// AWS_ACCESS_KEY_ID / AWS_DEFAULT_REGION can legitimately exist in a
// developer's shell for unrelated AWS work and must not break the boot.
const ACTIVATING = ['AWS_ENDPOINT_URL', 'AWS_S3_BUCKET_NAME'] as const;

type Env = Record<string, string | undefined>;

const blank = (value: string | undefined): boolean => value === undefined || value.trim() === '';

// Error messages name variables, never values.
function parseEndpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('AWS_ENDPOINT_URL must be a valid absolute URL');
  }
  if (url.protocol !== 'https:') {
    throw new Error('AWS_ENDPOINT_URL must use https');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('AWS_ENDPOINT_URL must not contain credentials, a query or a fragment');
  }
  if (url.pathname !== '/') {
    throw new Error('AWS_ENDPOINT_URL must be an origin without a path');
  }
  return url.origin;
}

function parseForcePathStyle(raw: string | undefined): boolean {
  if (raw === undefined || raw === '') return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error('AWS_S3_FORCE_PATH_STYLE must be exactly "true" or "false"');
}

// null  -> media storage is not configured at all (no Railway bucket vars):
//          /media answers 503 and nothing else is affected.
// throw -> partially or wrongly configured: fail the boot loudly.
export function loadS3Config(env: Env = process.env): S3Config | null {
  if (ACTIVATING.every((name) => blank(env[name]))) return null;

  const missing = REQUIRED.filter((name) => blank(env[name]));
  if (missing.length > 0) {
    throw new Error(`Missing required S3 configuration: ${missing.join(', ')}`);
  }

  const bucket = (env.AWS_S3_BUCKET_NAME as string).trim();
  if (/[\s/]/.test(bucket)) {
    throw new Error('AWS_S3_BUCKET_NAME must not contain whitespace or "/"');
  }

  return {
    endpoint: parseEndpoint(env.AWS_ENDPOINT_URL as string),
    region: (env.AWS_DEFAULT_REGION as string).trim(),
    bucket,
    accessKeyId: (env.AWS_ACCESS_KEY_ID as string).trim(),
    secretAccessKey: (env.AWS_SECRET_ACCESS_KEY as string).trim(),
    forcePathStyle: parseForcePathStyle(env.AWS_S3_FORCE_PATH_STYLE),
  };
}

// Safe-to-log summary: never the access key id or the secret.
export function describeS3Config(config: S3Config): string {
  return `endpoint=${new URL(config.endpoint).host} region=${config.region} bucket=${config.bucket} style=${
    config.forcePathStyle ? 'path' : 'virtual-hosted'
  }`;
}
