import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

// POST /businesses (SUPER_ADMIN only). An explicit whitelist: only what a restaurant needs to exist. The global
// ValidationPipe uses forbidNonWhitelisted, so anything else in the body (id, active, logoStorageKey, createdAt,
// colours, users, relations...) is answered with 400 instead of being ignored — the server decides those.
// Colours are not accepted: a new business starts with none (null) and the frontend falls back to the app palette
// until PATCH /businesses/me sets them. Logo only ever comes from POST /businesses/me/logo.

// The slug identifies the business in public menu URLs (?businessSlug=). Lowercase letters and digits in
// hyphen-separated groups: no accents, spaces, underscores, dots or leading/trailing/double hyphens. It is
// normalised by trimming and lowercasing ONLY — never transliterated or "fixed" — so what is stored is exactly what
// the caller sent, minus case/outer whitespace, and anything else is a 400.
export const BUSINESS_SLUG_MIN_LENGTH = 3;
export const BUSINESS_SLUG_MAX_LENGTH = 60;
export const BUSINESS_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
// Optional free-text fields: a blank string means "not provided".
const trimOrOmit = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};
const normalizeSlug = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class CreateBusinessDto {
  // Same ceiling as UpdateBusinessDto.name.
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @Transform(normalizeSlug)
  @IsString()
  @MinLength(BUSINESS_SLUG_MIN_LENGTH)
  @MaxLength(BUSINESS_SLUG_MAX_LENGTH)
  @Matches(BUSINESS_SLUG_PATTERN, {
    message: 'slug may only contain lowercase letters, digits and single hyphens between them',
  })
  slug: string;

  // Same ceilings as UpdateBusinessDto.
  @IsOptional()
  @Transform(trimOrOmit)
  @IsString()
  @MaxLength(200)
  address?: string;

  @IsOptional()
  @Transform(trimOrOmit)
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @Transform(trimOrOmit)
  @IsString()
  @MaxLength(200)
  hours?: string;
}
