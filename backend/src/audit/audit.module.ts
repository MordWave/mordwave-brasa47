import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { AuditController } from './audit.controller.js';
import { AuditLog } from './audit-log.entity.js';
import { AuditService } from './audit.service.js';
import { AuditInterceptor } from './interceptors/audit.interceptor.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([AuditLog]),
    // Gives access to AuthModule's exported JwtAuthGuard/RolesGuard for
    // GET /audit-logs.
    AuthModule,
  ],
  controllers: [AuditController],
  providers: [
    AuditService,
    // Registered here (not in AppModule) so importing AuditModule once is
    // the only wiring another module needs — Nest applies an
    // APP_INTERCEPTOR globally regardless of which module declares it.
    // AuditInterceptor is a no-op for any route without @Audit(...).
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
  exports: [AuditService],
})
export class AuditModule {}
