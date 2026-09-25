import { Type } from 'class-transformer';
import { IsISO8601, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

// Same shape/purpose as OrderHistoryQueryDto — page/limit for pagination,
// businessId only effective for a SUPER_ADMIN (see resolveBusinessIdForRead),
// from/to as full ISO instants (never a bare date-only string interpreted
// server-side, same reasoning as OrderHistoryQueryDto). action/entityType
// are plain strings, not validated against AUDIT_ACTIONS/AUDIT_ENTITY_TYPES
// here — an unknown value just matches nothing, which is simpler than
// keeping this DTO in lockstep with every action a module ever adds.
export class AuditLogQueryDto {
  @IsOptional()
  @IsUUID()
  businessId?: string;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  action?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  entityType?: string;

  @IsOptional()
  @IsUUID()
  entityId?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

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
