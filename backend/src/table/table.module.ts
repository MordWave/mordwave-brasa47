import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { Business } from '../business/business.entity.js';
import { BusinessModule } from '../business/business.module.js';
import { RestaurantTable } from './table.entity.js';
import { TableController } from './table.controller.js';
import { TableSession } from './table-session.entity.js';
import { TableSessionController } from './table-session.controller.js';
import { TableSessionService } from './table-session.service.js';
import { TableService } from './table.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([RestaurantTable, TableSession, Business]),
    // Gives access to AuthModule's exported JwtAuthGuard/RolesGuard.
    AuthModule,
    // Gives TableService access to BusinessLimitsService (per-Business table
    // ceiling).
    BusinessModule,
    // Gives TableController access to AuditService for its explicit
    // update()/remove() audit calls (create/openSession/closeSession are
    // audited generically via @Audit(...) + the global AuditInterceptor).
    AuditModule,
  ],
  controllers: [TableController, TableSessionController],
  providers: [TableService, TableSessionService],
  exports: [TypeOrmModule],
})
export class TableModule {}
