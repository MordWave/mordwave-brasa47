import { Module } from '@nestjs/common';
import { ImageStorageService } from './image-storage.service.js';

// Shared by ProductModule (product photos) and BusinessModule (logo) — a
// single place for the Supabase Storage image pipeline, not duplicated
// per feature.
@Module({
  providers: [ImageStorageService],
  exports: [ImageStorageService],
})
export class StorageModule {}
