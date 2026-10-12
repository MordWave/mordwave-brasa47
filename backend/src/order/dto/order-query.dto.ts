import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { PAGINATION_MAX_LIMIT } from '../../common/pagination.const.js';
import { OrderStatus } from '../order-status.enum.js';

export class OrderQueryDto {
  @IsOptional()
  @IsUUID()
  businessId?: string;

  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  // Query params arrive as strings — the global ValidationPipe doesn't have
  // implicit primitive conversion enabled, so this needs an explicit @Type
  // for "50" to become the number 50 before @IsInt() runs.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAGINATION_MAX_LIMIT)
  limit?: number;
}
