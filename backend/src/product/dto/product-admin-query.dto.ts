import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';

// Query-string booleans arrive as the literal strings "true"/"false" — and
// @Type(() => Boolean) would turn "false" into true (any non-empty string is
// truthy), so they're parsed explicitly. Anything else is left untouched so
// @IsBoolean() rejects it with a 400 instead of being silently coerced.
function parseQueryBoolean({ value }: { value: unknown }): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

export class ProductAdminQueryDto extends PaginationQueryDto {
  // Only effective for a SUPER_ADMIN (see resolveBusinessIdForRead) — an
  // ADMIN's own businessId always wins.
  @IsOptional()
  @IsUUID()
  businessId?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  // Case-insensitive partial match on the product name.
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(80)
  search?: string;

  @IsOptional()
  @Transform(parseQueryBoolean)
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @Transform(parseQueryBoolean)
  @IsBoolean()
  available?: boolean;
}
