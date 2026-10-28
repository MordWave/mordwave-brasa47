import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Business } from '../business/business.entity.js';
import { CategoryModule } from '../category/category.module.js';
import { MediaModule } from '../media/media.module.js';
import { ProductModule } from '../product/product.module.js';
import { PublicMenuController } from './public-menu.controller.js';
import { PublicMenuService } from './public-menu.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Business]),
    // The services of the existing public reads (their visibility rules are reused, not copied).
    CategoryModule,
    ProductModule,
    // MediaUrlService: logo, cover and product images as stable /media URLs.
    MediaModule,
  ],
  controllers: [PublicMenuController],
  providers: [PublicMenuService],
})
export class PublicMenuModule {}
