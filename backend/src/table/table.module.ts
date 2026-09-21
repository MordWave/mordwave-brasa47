import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from '../auth/auth.module.js';
import { Business } from '../business/business.entity.js';
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
    // Scoped to this module, applied only via @UseGuards(ThrottlerGuard) on
    // the three public table-sessions/* routes — resolve/join are one-shot,
    // but status gets polled periodically by every device at a table, all
    // sharing one IP if they're on the same Wi-Fi, so this stays generous.
    // Same isolated mechanism as AuthModule's and OrderModule's own
    // throttlers, with its own limit.
    ThrottlerModule.forRoot([
      {
        name: 'table-sessions',
        ttl: 60_000, // 1 minute, in ms
        limit: 60, // per IP per minute, shared across resolve/join/status
      },
    ]),
  ],
  controllers: [TableController, TableSessionController],
  providers: [TableService, TableSessionService],
  exports: [TypeOrmModule],
})
export class TableModule {}
