import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Business } from './business.entity.js';

@Module({
  imports: [TypeOrmModule.forFeature([Business])],
  exports: [TypeOrmModule],
})
export class BusinessModule {}
