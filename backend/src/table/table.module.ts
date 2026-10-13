import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
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
    // Scoped to this module, applied only via @UseGuards(ThrottlerGuard) on
    // the two public table-sessions/* routes. `join` is one-shot per visit,
    // so it keeps this default limit. `status`, in contrast, is polled by
    // every device at a table roughly every 12s (see CustomerApp's
    // STATUS_POLL_MS) — and in a real venue, many customer phones often
    // share one public IP via the venue's own Wi-Fi NAT, so a limit sized
    // for one device would starve a full table. TableSessionController
    // overrides this throttler's limit specifically for `status` via
    // @Throttle(...) rather than raising it here, which would also loosen
    // `join`. Same isolated mechanism as AuthModule's and OrderModule's own
    // throttlers.
    ThrottlerModule.forRoot([
      {
        name: 'table-sessions',
        ttl: 60_000, // 1 minute, in ms
        limit: 60, // per IP per minute — applies to `join`; `status` overrides this, see above
      },
    ]),
  ],
  controllers: [TableController, TableSessionController],
  providers: [TableService, TableSessionService],
  exports: [TypeOrmModule],
})
export class TableModule {}
