import { Controller, Get, Param } from '@nestjs/common';
import { RateLimit } from '../rate-limit/rate-limit.decorator.js';
import { PublicMenuService, type PublicMenu } from './public-menu.service.js';

// GET /public/menu/:slug — the read-only menu behind the shareable link /menu/:slug. No authentication, no table token, no
// session: it only ever answers with public data of the restaurant named by the slug.
@Controller('public/menu')
export class PublicMenuController {
  constructor(private readonly menu: PublicMenuService) {}

  @Get(':slug')
  @RateLimit('publicMenu')
  getMenu(@Param('slug') slug: string): Promise<PublicMenu> {
    return this.menu.getMenu(slug);
  }
}
