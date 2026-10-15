import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';

// Query-string booleans arrive as the literal strings "true"/"false" — same explicit parsing as
// ProductAdminQueryDto (anything else is left untouched so @IsBoolean() answers 400 instead of coercing).
function parseQueryBoolean({ value }: { value: unknown }): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

// GET /businesses (SUPER_ADMIN only): the one deliberately cross-tenant listing, so there is NO `businessId` here.
// The global ValidationPipe uses forbidNonWhitelisted, so a `?businessId=` is answered with 400 instead of being
// silently ignored or, worse, turned into a tenant scope.
export class BusinessListQueryDto extends PaginationQueryDto {
  // Case-insensitive partial match on name OR slug. Whitespace is trimmed and collapsed.
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value))
  @IsString()
  @MaxLength(80)
  search?: string;

  // Business.active — the only status the entity really has.
  @IsOptional()
  @Transform(parseQueryBoolean)
  @IsBoolean()
  active?: boolean;
}
