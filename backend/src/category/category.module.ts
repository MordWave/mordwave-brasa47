import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Business } from '../business/business.entity.js';
import { Category } from './category.entity.js';
import { CategoryController } from './category.controller.js';
import { CategoryService } from './category.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Category, Business]),
    // Required wherever AuthGuard('jwt')-based guards are used — see
    // AuthModule for the same wiring and the UnknownDependenciesException
    // this avoids.
    PassportModule.register({ defaultStrategy: 'jwt' }),
  ],
  controllers: [CategoryController],
  providers: [CategoryService],
  exports: [TypeOrmModule],
})
export class CategoryModule {}
