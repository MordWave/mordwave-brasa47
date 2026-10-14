import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module.js';
import { ImageStorageService } from './image-storage.service.js';

// Shared by ProductModule (product photos) and BusinessModule (logo) — a
// single place for the image pipeline (validate -> sharp -> WebP -> Railway
// Bucket), not duplicated per feature.
@Module({
  imports: [MediaModule],
  providers: [ImageStorageService],
  exports: [ImageStorageService],
})
export class StorageModule {}
