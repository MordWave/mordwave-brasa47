import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { Business } from '../business/business.entity.js';
import { Category } from '../category/category.entity.js';
import { ProductImageService } from './product-image.service.js';
import { Product } from './product.entity.js';
import { ProductController } from './product.controller.js';
import { ProductService } from './product.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Product, Category, Business]),
    // Gives access to AuthModule's exported JwtAuthGuard/RolesGuard (and,
    // via its re-export of PassportModule, the AuthModuleOptions those
    // guards need) without registering PassportModule here again.
    AuthModule,
  ],
  controllers: [ProductController],
  providers: [ProductService, ProductImageService],
  exports: [TypeOrmModule],
})
export class ProductModule {}
