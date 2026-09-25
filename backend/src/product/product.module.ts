import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { Business } from '../business/business.entity.js';
import { BusinessModule } from '../business/business.module.js';
import { Category } from '../category/category.entity.js';
import { StorageModule } from '../storage/storage.module.js';
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
    // Gives access to PublicBusinessResolverService (businessId/businessSlug
    // resolution for the public, unauthenticated GET endpoints).
    BusinessModule,
    // Gives ProductImageService access to the shared ImageStorageService.
    StorageModule,
    // Gives ProductController access to AuditService for its explicit
    // update()/remove() audit calls (create() is audited generically via
    // @Audit(...) + the global AuditInterceptor, no dependency needed here
    // for that one).
    AuditModule,
  ],
  controllers: [ProductController],
  providers: [ProductService, ProductImageService],
  exports: [TypeOrmModule],
})
export class ProductModule {}
