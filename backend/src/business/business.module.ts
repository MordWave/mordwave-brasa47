import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { Business } from './business.entity.js';
import { BusinessController } from './business.controller.js';
import { BusinessService } from './business.service.js';
import { PublicBusinessResolverService } from './public-business-resolver.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Business]),
    // Gives access to AuthModule's exported JwtAuthGuard/RolesGuard for the
    // admin-only /businesses/me* routes below.
    AuthModule,
    // Gives BusinessService access to the shared ImageStorageService (logo
    // upload).
    StorageModule,
    // Gives BusinessController access to AuditService for its explicit
    // updateMe()/uploadLogo() audit calls.
    AuditModule,
  ],
  controllers: [BusinessController],
  providers: [PublicBusinessResolverService, BusinessService],
  exports: [TypeOrmModule, PublicBusinessResolverService],
})
export class BusinessModule {}
