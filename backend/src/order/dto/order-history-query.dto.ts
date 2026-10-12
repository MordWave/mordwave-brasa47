import { IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import { OrderStatus } from '../order-status.enum.js';

// History only ever covers terminal orders — NEW belongs on the live board
// (GET /orders/admin), never here.
const HISTORY_STATUSES = [OrderStatus.DELIVERED, OrderStatus.CANCELLED] as const;

export class OrderHistoryQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  businessId?: string;

  @IsOptional()
  @IsIn(HISTORY_STATUSES)
  status?: OrderStatus;

  // Full ISO instants, not date-only strings — the frontend converts the
  // admin's local-calendar-day date inputs into UTC instants before
  // sending them (see OrderHistoryModal's localDayStartIso/
  // localDayAfterIso), so a "day" here always means the admin's own local
  // day, not a UTC one. `to` is already the exclusive upper bound. @IsISO8601
  // (non-strict) accepts both this and a bare date-only string, but the
  // service no longer does its own day-boundary math, so a bare date-only
  // string would be treated as UTC midnight — always send a full instant.
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
}
