import { Type } from 'class-transformer';
import { IsIn, IsISO8601, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { OrderStatus } from '../order-status.enum.js';

// History only ever covers terminal orders — NEW belongs on the live board
// (GET /orders/admin), never here.
const HISTORY_STATUSES = [OrderStatus.DELIVERED, OrderStatus.CANCELLED] as const;

export class OrderHistoryQueryDto {
  @IsOptional()
  @IsUUID()
  businessId?: string;

  @IsOptional()
  @IsIn(HISTORY_STATUSES)
  status?: OrderStatus;

  // Plain "YYYY-MM-DD" from a date input — @IsISO8601 (non-strict) accepts
  // a date-only string. Inclusive on both ends; see the service for how
  // the day boundary is computed.
  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  // Free-text partial match against Order.table (the resolved name
  // snapshot) — simple, no dependency on RestaurantTable still existing.
  @IsOptional()
  @IsString()
  @MaxLength(40)
  table?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
