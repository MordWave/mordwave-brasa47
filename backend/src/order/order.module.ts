import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { Product } from '../product/product.entity.js';
import { RestaurantTable } from '../table/table.entity.js';
import { TableSession } from '../table/table-session.entity.js';
import { OrderItem } from './order-item.entity.js';
import { Order } from './order.entity.js';
import { OrderController } from './order.controller.js';
import { OrderService } from './order.service.js';

@Module({
  imports: [
    // TableSession/RestaurantTable are read/locked directly here, not via
    // TableModule's TableSessionService — same convention OrderService
    // already uses for Product (reach into the repo, not the owning
    // module's service).
    TypeOrmModule.forFeature([Order, OrderItem, Product, TableSession, RestaurantTable]),
    // Gives access to AuthModule's exported JwtAuthGuard/RolesGuard for the
    // admin-only routes below.
    AuthModule,
    // Gives OrderController access to AuditService for its explicit
    // updateStatus() audit call (DELIVERED/CANCELLED).
    AuditModule,
  ],
  controllers: [OrderController],
  providers: [OrderService],
  exports: [TypeOrmModule],
})
export class OrderModule {}
