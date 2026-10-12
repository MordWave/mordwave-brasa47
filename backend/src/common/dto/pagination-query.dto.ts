import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { PAGINATION_MAX_LIMIT } from '../pagination.const.js';

// Shared page/limit pair for every paginated query DTO. Query params arrive
// as strings and the global ValidationPipe has no implicit primitive
// conversion, so each needs an explicit @Type(() => Number) before @IsInt().
// Defaults (page 1, limit 20) are applied by the services, not here, so an
// omitted param stays `undefined` on the DTO.
export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAGINATION_MAX_LIMIT)
  limit?: number;
}
