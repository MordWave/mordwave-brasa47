import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Business } from './business.entity.js';
import { PublicBusinessResolverService } from './public-business-resolver.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([Business])],
  providers: [PublicBusinessResolverService],
  exports: [TypeOrmModule, PublicBusinessResolverService],
})
export class BusinessModule {}
