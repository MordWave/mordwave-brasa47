import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { describeS3Config, S3_CONFIG, type S3Config } from './s3.config.js';

// Test seam: a fake S3Client can be provided under this token. Never
// provided in the real module.
export const S3_CLIENT = Symbol('S3_CLIENT');

export interface ObjectHead {
  contentLength: number | undefined;
  contentType: string | undefined;
}

// Raised when the store is not configured or S3 fails for any reason other
// than "object does not exist". Carries no S3 internals, so it is safe to
// map to a generic client-facing error.
export class ObjectStoreUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ObjectStoreUnavailableError';
  }
}

// SigV4 presigned URLs can live at most 7 days.
const MAX_PRESIGN_SECONDS = 7 * 24 * 3600;
const MAX_KEY_LENGTH = 1024;

function isNotFound(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound' || e?.name === 'NoSuchKey'
  );
}

// Thin, generic wrapper over the Railway Bucket (S3 API): head, presignGet and
// put. There is deliberately NO delete: during the Supabase -> Railway
// transition nothing removes objects (cleanup is a separate, reviewed step).
// It knows nothing about products, businesses or Supabase, and does not decide
// which keys are valid media keys — callers (MediaController, ImageStorageService)
// do that.
@Injectable()
export class S3ObjectStoreService implements OnModuleInit {
  private readonly logger = new Logger(S3ObjectStoreService.name);
  private readonly client: S3Client | null;

  constructor(
    @Inject(S3_CONFIG) private readonly config: S3Config | null,
    @Optional() @Inject(S3_CLIENT) client?: S3Client,
  ) {
    this.client =
      client ??
      (config
        ? new S3Client({
            endpoint: config.endpoint,
            region: config.region,
            forcePathStyle: config.forcePathStyle,
            credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
            // Keep a stuck bucket from holding a request until the global
            // deadline; a redirect must be quick or fail.
            maxAttempts: 2,
            requestHandler: { connectionTimeout: 3000, requestTimeout: 5000 },
          })
        : null);
  }

  onModuleInit(): void {
    if (this.config) {
      this.logger.log(`S3 media store configured: ${describeS3Config(this.config)}`);
    } else {
      this.logger.warn('S3 media store NOT configured (AWS_ENDPOINT_URL / AWS_S3_BUCKET_NAME unset): /media is disabled');
    }
  }

  get isConfigured(): boolean {
    return this.client !== null && this.config !== null;
  }

  private requireConfigured(): { client: S3Client; bucket: string } {
    if (!this.client || !this.config) {
      throw new ObjectStoreUnavailableError('S3 media store is not configured');
    }
    return { client: this.client, bucket: this.config.bucket };
  }

  private assertKey(key: string): void {
    if (
      typeof key !== 'string' ||
      key === '' ||
      key.length > MAX_KEY_LENGTH ||
      key.startsWith('/') ||
      key.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
      throw new RangeError('Invalid object key');
    }
  }

  // null when the object does not exist; throws ObjectStoreUnavailableError
  // for every other failure (credentials, network, 5xx...).
  async head(key: string): Promise<ObjectHead | null> {
    this.assertKey(key);
    const { client, bucket } = this.requireConfigured();
    try {
      const out = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { contentLength: out.ContentLength, contentType: out.ContentType };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new ObjectStoreUnavailableError('S3 HeadObject failed', { cause: error });
    }
  }

  // Writes one object. Always a plain PutObject of an in-memory buffer; the
  // caller owns the key (unique per upload) and the content/cache headers.
  async put(
    key: string,
    body: Buffer,
    contentType: string,
    cacheControl: string,
    metadata?: Record<string, string>,
  ): Promise<void> {
    this.assertKey(key);
    const { client, bucket } = this.requireConfigured();
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          CacheControl: cacheControl,
          ...(metadata ? { Metadata: metadata } : {}),
        }),
      );
    } catch (error) {
      throw new ObjectStoreUnavailableError('S3 PutObject failed', { cause: error });
    }
  }

  // Signs locally (no network call). The URL is time-limited and must never
  // be stored or logged.
  async presignGet(key: string, expiresInSeconds: number): Promise<string> {
    this.assertKey(key);
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > MAX_PRESIGN_SECONDS) {
      throw new RangeError('expiresInSeconds must be an integer between 1 and 604800');
    }
    const { client, bucket } = this.requireConfigured();
    try {
      return await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: expiresInSeconds,
      });
    } catch (error) {
      throw new ObjectStoreUnavailableError('S3 presign failed', { cause: error });
    }
  }
}
