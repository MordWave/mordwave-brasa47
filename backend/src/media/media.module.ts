import { Module } from '@nestjs/common';
import { MediaController } from './media.controller.js';
import { MediaUrlService } from './media-url.service.js';
import { S3ObjectStoreService } from './s3-object-store.service.js';
import { loadS3Config, S3_CONFIG } from './s3.config.js';

// Read path of the Railway Bucket: GET /media/<key> -> 302 to a presigned GET.
// Nothing here writes to the bucket yet.
@Module({
  controllers: [MediaController],
  providers: [
    // Strict: a partial or malformed AWS_* configuration fails the boot.
    { provide: S3_CONFIG, useFactory: () => loadS3Config() },
    S3ObjectStoreService,
    MediaUrlService,
  ],
  exports: [MediaUrlService, S3ObjectStoreService],
})
export class MediaModule {}
