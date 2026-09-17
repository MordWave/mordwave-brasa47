import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { Business } from '../business/business.entity.js';
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
  ],
  controllers: [CategoryController],
  providers: [CategoryService],
  exports: [TypeOrmModule],
})
export class CategoryModule {}
