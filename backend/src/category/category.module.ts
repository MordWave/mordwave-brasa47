import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { Business } from '../business/business.entity.js';
import { BusinessModule } from '../business/business.module.js';
import { Product } from '../product/product.entity.js';
import { Category } from './category.entity.js';
import { CategoryController } from './category.controller.js';
import { CategoryService } from './category.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Category, Business, Product]),
    // Gives access to AuthModule's exported JwtAuthGuard/RolesGuard (and,
    // via its re-export of PassportModule, the AuthModuleOptions those
    // guards need) without registering PassportModule here again.
    AuthModule,
    // Gives access to PublicBusinessResolverService (businessId/businessSlug
    // resolution for the public, unauthenticated GET endpoint).
    BusinessModule,
    // Gives CategoryController access to AuditService for its explicit
    // update()/remove() audit calls.
    AuditModule,
  ],
  controllers: [CategoryController],
  providers: [CategoryService],
  // CategoryService: reused by the shareable public menu (PublicMenuModule).
  exports: [TypeOrmModule, CategoryService],
})
export class CategoryModule {}
