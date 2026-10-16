import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export const BUSINESS_SUSPENSION_REASON_MAX_LENGTH = 200;

// POST /businesses/:id/deactivate. The only input is an optional free-text reason, kept in the audit entry (and
// nowhere else). Trimmed; a blank reason means "none given". Nothing else is accepted (forbidNonWhitelisted), in
// particular no flag that forces the suspension past pending orders.
export class DeactivateBusinessDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  })
  @IsString()
  @MaxLength(BUSINESS_SUSPENSION_REASON_MAX_LENGTH)
  reason?: string;
}
