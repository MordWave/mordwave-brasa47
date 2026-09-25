import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '../audit/audit-actions.const.js';
import { AuditService } from '../audit/audit.service.js';
import { extractClientInfo } from '../audit/request-client-info.util.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import type { SafeUser } from '../auth/safe-user.js';
import { UserRole } from '../user/user-role.enum.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { OrderHistoryQueryDto } from './dto/order-history-query.dto.js';
import { OrderQueryDto } from './dto/order-query.dto.js';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto.js';
import { Order } from './order.entity.js';
import { OrderStatus } from './order-status.enum.js';
import { OrderHistoryPage, OrderService } from './order.service.js';

@Controller('orders')
export class OrderController {
  constructor(
    private readonly orderService: OrderService,
    private readonly auditService: AuditService,
  ) {}

  // Public, unauthenticated — a customer's table submits its own order. See
  // Order's SECURITY NOTE: `table` is unverified free text, and this
  // ThrottlerGuard (20/min per IP — see order.module.ts) is a basic abuse
  // guard, not a substitute for a real table session.
  @Post()
  @UseGuards(ThrottlerGuard)
  create(@Body() dto: CreateOrderDto): Promise<Order> {
    return this.orderService.create(dto);
  }

  @Get('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  findAllAdmin(
    @Query() query: OrderQueryDto,
    @CurrentUser() user: SafeUser,
  ): Promise<Order[]> {
    return this.orderService.findAllAdmin(query, user);
  }

  @Get('admin/history')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  findHistoryAdmin(
    @Query() query: OrderHistoryQueryDto,
    @CurrentUser() user: SafeUser,
  ): Promise<OrderHistoryPage> {
    return this.orderService.findHistoryAdmin(query, user);
  }

  // Explicit call, not @Audit(...): the same route handles both terminal
  // transitions (DELIVERED/CANCELLED), only distinguishable at runtime.
  // Normal customer checkout (POST /orders) is deliberately not audited —
  // high-volume, and not an admin action.
  @Patch(':id/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOrderStatusDto,
    @CurrentUser() user: SafeUser,
    @Req() req: Request,
  ): Promise<Order> {
    const updated = await this.orderService.updateStatus(id, dto, user);
    void this.auditService.record({
      businessId: updated.businessId,
      userId: user.id,
      userEmail: user.email,
      action: updated.status === OrderStatus.DELIVERED ? AUDIT_ACTIONS.ORDER_DELIVERED : AUDIT_ACTIONS.ORDER_CANCELLED,
      entityType: AUDIT_ENTITY_TYPES.ORDER,
      entityId: updated.id,
      metadata: { orderNumber: updated.orderNumber, table: updated.table },
      ...extractClientInfo(req),
    });
    return updated;
  }
}
