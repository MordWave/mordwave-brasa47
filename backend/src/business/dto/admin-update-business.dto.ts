import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

// PATCH /businesses/:id (SUPER_ADMIN only): the commercial data of one business and nothing else. An explicit whitelist
// (the global ValidationPipe uses forbidNonWhitelisted), so slug (immutable for now), id, active (only the
// deactivate/activate endpoints move it), colours, logo and every internal field or relation answer 400 instead of
// being ignored. Ceilings are the same as UpdateBusinessDto's (PATCH /businesses/me).
//
// Text is trimmed. For the optional fields a blank string or an explicit null clears the value (stored as NULL), the
// only way to empty a field through a PATCH; name can never be blank or null.
const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);
const trimToNull = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

export class AdminUpdateBusinessDto {
  // ValidateIf instead of IsOptional: an explicit null must be rejected, only an omitted name is fine.
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(200)
  address?: string | null;

  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(40)
  phone?: string | null;

  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(200)
  hours?: string | null;
}
