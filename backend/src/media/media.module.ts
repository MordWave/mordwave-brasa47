import { Module } from '@nestjs/common';
import { MediaUrlService } from './media-url.service.js';

// PR 1 of the Railway Bucket migration: only the URL resolution used by the
// response presenters. No S3 client and no /media route yet.
@Module({
  providers: [MediaUrlService],
  exports: [MediaUrlService],
})
export class MediaModule {}
