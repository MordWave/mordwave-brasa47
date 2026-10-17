import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { MediaModule } from '../media/media.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { User } from '../user/user.entity.js';
import { BusinessAdminController } from './business-admin.controller.js';
import { BusinessAdminService } from './business-admin.service.js';
import { Business } from './business.entity.js';
import { BusinessController } from './business.controller.js';
import { BusinessPresenter } from './business.presenter.js';
import { BusinessLimitsService } from './business-limits.service.js';
import { BusinessLifecycleService } from './business-lifecycle.service.js';
import { BusinessService } from './business.service.js';
import { PublicBusinessResolverService } from './public-business-resolver.service.js';

@Module({
  imports: [
    // User: BusinessAdminService manages the ADMIN accounts of a business (SUPER_ADMIN only).
    TypeOrmModule.forFeature([Business, User]),
    // Gives access to AuthModule's exported JwtAuthGuard/RolesGuard for the
    // admin-only /businesses/me* routes below.
    AuthModule,
    // Gives BusinessService access to the shared ImageStorageService (logo
    // upload).
    StorageModule,
    // Gives BusinessPresenter the media URL resolution.
    MediaModule,
    // Gives BusinessController access to AuditService for its explicit
    // updateMe()/uploadLogo() audit calls.
    AuditModule,
  ],
  controllers: [BusinessController, BusinessAdminController],
  providers: [PublicBusinessResolverService, BusinessService, BusinessLifecycleService, BusinessLimitsService, BusinessPresenter, BusinessAdminService],
  exports: [TypeOrmModule, PublicBusinessResolverService, BusinessLimitsService, BusinessPresenter],
})
export class BusinessModule {}
