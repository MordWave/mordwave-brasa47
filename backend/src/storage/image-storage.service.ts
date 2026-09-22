import { BadGatewayException, BadRequestException, Inject, Injectable } from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import supabaseConfig from '../config/supabase.config.js';

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB, matches the bucket's own limit
// ~50 megapixels — comfortably above any phone camera's output, but bounded
// enough to reject a deliberately crafted "pixel bomb" before sharp decodes
// the full image into memory.
const MAX_INPUT_PIXELS = 50_000_000;
const MAX_OUTPUT_DIMENSION = 1200; // plenty for a menu card/detail view or a logo
const OUTPUT_QUALITY = 80;

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

// Generic Supabase Storage image pipeline: validate, optimize, upload/
// remove at a given path. Extracted from ProductImageService (Fase 4) so
// the business logo upload (Fase 7) can reuse the exact same validation/
// sharp/Supabase-client logic without duplicating it — this service knows
// nothing about products or businesses, only paths and files. Callers
// (ProductImageService, BusinessService) own their own path-building.
@Injectable()
export class ImageStorageService {
  private readonly client: SupabaseClient;
  private readonly bucket: string;

  constructor(
    @Inject(supabaseConfig.KEY)
    config: ReturnType<typeof supabaseConfig>,
  ) {
    this.client = createClient(config.url, config.secretKey);
    this.bucket = config.bucket;
  }

  // Validates, optimizes, and uploads. Returns the public URL (with a
  // cache-busting query param) only once the file actually exists in
  // Storage — callers should not persist anything until this resolves.
  async upload(path: string, file: UploadableFile): Promise<string> {
    if (file.size > MAX_FILE_SIZE_BYTES) {
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
      webpBuffer = await sharp(file.buffer, { limitInputPixels: MAX_INPUT_PIXELS })
        .rotate() // auto-orients from EXIF before it gets stripped below
        .resize({
          width: MAX_OUTPUT_DIMENSION,
          height: MAX_OUTPUT_DIMENSION,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: OUTPUT_QUALITY })
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

    const { error } = await this.client.storage
      .from(this.bucket)
      .upload(path, webpBuffer, { contentType: 'image/webp', upsert: true });

    if (error) {
      throw new BadGatewayException({
        message: 'Failed to upload the image to storage',
        errorCode: 'IMAGE_UPLOAD_FAILED',
      });
    }

    const { data } = this.client.storage.from(this.bucket).getPublicUrl(path);
    // Cache-busting: the Storage path is fixed and reused on every
    // replace (upsert), so the query param is what actually changes.
    return `${data.publicUrl}?v=${Date.now()}`;
  }

  async remove(path: string): Promise<void> {
    const { error } = await this.client.storage.from(this.bucket).remove([path]);
    if (error) {
      throw new BadGatewayException({
        message: 'Failed to remove the image from storage',
        errorCode: 'IMAGE_UPLOAD_FAILED',
      });
    }
  }
}
