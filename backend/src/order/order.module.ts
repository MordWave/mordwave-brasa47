import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from '../auth/auth.module.js';
import { Business } from '../business/business.entity.js';
import { BusinessModule } from '../business/business.module.js';
import { Product } from '../product/product.entity.js';
import { OrderItem } from './order-item.entity.js';
import { Order } from './order.entity.js';
import { OrderController } from './order.controller.js';
import { OrderService } from './order.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Order, OrderItem, Product, Business]),
    // Gives access to AuthModule's exported JwtAuthGuard/RolesGuard for the
    // admin-only routes below.
    AuthModule,
    // Gives access to PublicBusinessResolverService (businessId/businessSlug
    // resolution) for the public POST /orders route.
    BusinessModule,
    // Scoped to this module, applied only via @UseGuards(ThrottlerGuard) on
    // POST /orders — the one public, unauthenticated write in this app.
    // Same isolated mechanism as AuthModule's own throttler for
    // /auth/login, with its own separate limit (see order.controller.ts).
    ThrottlerModule.forRoot([
      {
        name: 'orders',
        ttl: 60_000, // 1 minute, in ms
        limit: 20, // max 20 order submissions per IP per minute
      },
    ]),
  ],
  controllers: [OrderController],
  providers: [OrderService],
  exports: [TypeOrmModule],
})
export class OrderModule {}
