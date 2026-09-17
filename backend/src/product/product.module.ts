import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Business } from '../business/business.entity.js';
import { Category } from '../category/category.entity.js';
import { Product } from './product.entity.js';
import { ProductController } from './product.controller.js';
import { ProductService } from './product.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Product, Category, Business]),
    // Required wherever AuthGuard('jwt')-based guards are used — see
    // AuthModule for the same wiring and the UnknownDependenciesException
    // this avoids.
    PassportModule.register({ defaultStrategy: 'jwt' }),
  ],
  controllers: [ProductController],
  providers: [ProductService],
  exports: [TypeOrmModule],
})
export class ProductModule {}
