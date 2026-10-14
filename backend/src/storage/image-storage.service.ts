import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import {
  IMAGE_MAX_FILE_SIZE_BYTES,
  IMAGE_MAX_INPUT_PIXELS,
  IMAGE_MAX_OUTPUT_DIMENSION,
  IMAGE_OUTPUT_QUALITY,
} from '../common/limits/resource-limits.const.js';
import { MEDIA_OBJECT_CACHE_CONTROL, MEDIA_OBJECT_CONTENT_TYPE } from '../media/media.const.js';
import { isMediaKey } from '../media/media-key.util.js';
import { MediaUrlService } from '../media/media-url.service.js';
import { ObjectStoreUnavailableError, S3ObjectStoreService } from '../media/s3-object-store.service.js';

// HEIC/HEIF (iPhone) is allowed through this check, but whether sharp can
// actually decode it depends on how it was built (libvips w/ libheif) — that
// failure is caught separately below as IMAGE_PROCESSING_FAILED, not
// silently rejected here.
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

export interface UploadableFile {
  buffer: Buffer;
  size: number;
}

// Generic image pipeline: validate, optimize, and store in the Railway Bucket
// under a caller-supplied storage key. Extracted from ProductImageService
// (Fase 4) so the business logo upload can reuse the exact same validation /
// sharp logic — this service knows nothing about products or businesses,
// only keys and files. Callers (ProductImageService, BusinessService) build
// the key with media-key.util; a key never comes from a client.
//
// Supabase Storage is no longer written to or deleted from here (it stays
// readable through the legacy URLs still stored in image_url / logo_url).
// Nothing is ever deleted from the bucket either: replaced and removed
// images are left for the later orphan cleanup.
@Injectable()
export class ImageStorageService {
  private readonly logger = new Logger(ImageStorageService.name);

  constructor(
    private readonly store: S3ObjectStoreService,
    private readonly mediaUrls: MediaUrlService,
  ) {}

  // Validates, optimizes, and uploads. Resolves with the storage key only once
  // the object really is in the bucket — callers must not persist anything
  // before this resolves.
  async upload(key: string, file: UploadableFile): Promise<string> {
    // Programming-error guard (the key is built server-side), not user input.
    if (!isMediaKey(key)) {
      throw new Error('upload() requires a valid media storage key');
    }
    // Fail closed BEFORE doing any work: storing a key whose /media URL can't
    // be built would make the image disappear from every API response.
    if (!this.store.isConfigured || !this.mediaUrls.isConfigured) {
      throw new ServiceUnavailableException({
        message: 'Image storage is not configured',
        errorCode: 'IMAGE_STORAGE_UNAVAILABLE',
      });
    }

    if (file.size > IMAGE_MAX_FILE_SIZE_BYTES) {
      throw new BadRequestException({
        message: 'Uploaded file exceeds the maximum allowed size (10 MB)',
        errorCode: 'IMAGE_TOO_LARGE',
      });
    }

    const detected = await fileTypeFromBuffer(file.buffer);
    if (!detected || !ALLOWED_MIME_TYPES.has(detected.mime)) {
      throw new BadRequestException({
        message: 'Unsupported or undetectable image format',
        errorCode: 'IMAGE_INVALID_FORMAT',
      });
    }

    let webpBuffer: Buffer;
    try {
      webpBuffer = await sharp(file.buffer, { limitInputPixels: IMAGE_MAX_INPUT_PIXELS })
        .rotate() // auto-orients from EXIF before it gets stripped below
        .resize({
          width: IMAGE_MAX_OUTPUT_DIMENSION,
          height: IMAGE_MAX_OUTPUT_DIMENSION,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: IMAGE_OUTPUT_QUALITY })
        .toBuffer();
      // .withMetadata() is deliberately never called — sharp strips EXIF/ICC
      // metadata by default, which is what "eliminar metadata innecesaria" asks for.
    } catch {
      // Covers both a genuinely corrupt file and a format sharp can't
      // decode in this build (e.g. HEIC without libheif) — never leak
      // sharp's raw internal error text to the client.
      throw new BadRequestException({
        message: 'Could not process the uploaded image',
        errorCode: 'IMAGE_PROCESSING_FAILED',
      });
    }

    try {
      await this.store.put(key, webpBuffer, MEDIA_OBJECT_CONTENT_TYPE, MEDIA_OBJECT_CACHE_CONTROL);
    } catch (error) {
      if (error instanceof ObjectStoreUnavailableError) {
        // The cause stays in the server log; the client only gets a generic
        // message.
        this.logger.error(`Failed to upload ${key} to the bucket`, error.cause as Error | undefined);
        throw new BadGatewayException({
          message: 'Failed to upload the image to storage',
          errorCode: 'IMAGE_UPLOAD_FAILED',
        });
      }
      throw error;
    }

    return key;
  }
}
