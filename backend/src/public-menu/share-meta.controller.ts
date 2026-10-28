import { Controller, Get, Header, Query } from '@nestjs/common';
import { RateLimit } from '../rate-limit/rate-limit.decorator.js';
import { ShareMetaService } from './share-meta.service.js';

// GET /public/share-meta?slug=&origin= — not called by browsers: the web server (Caddy) asks it for the <head> fragment of
// /menu/<slug> so link previews (WhatsApp, Instagram...) find the restaurant in the initial HTML. Always 200: an empty body means
// "nothing to describe" and the caller keeps its generic page.
@Controller('public/share-meta')
export class ShareMetaController {
  constructor(private readonly shareMeta: ShareMetaService) {}

  @Get()
  @RateLimit('shareMeta')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  getShareMeta(@Query('slug') slug: unknown, @Query('origin') origin: unknown): Promise<string> {
    return this.shareMeta.render(slug, origin);
  }
}
