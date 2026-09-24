import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

// Deliberately no `businessId` field here — which business this updates is
// resolved server-side (BusinessService, via the same resolveBusinessIdFor*
// pattern every other admin write already uses), never trusted from the
// body. No `logoUrl` either — that's only ever written through
// POST /businesses/me/logo, never through this plain PATCH.
const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

export class UpdateBusinessDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  // Free text ("Lun-Dom 12:00-23:00") — no structured schedule/validation
  // in this phase, purely informational.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  hours?: string;

  @IsOptional()
  @Matches(HEX_COLOR_PATTERN, { message: 'primaryColor must be a hex color like #RRGGBB' })
  primaryColor?: string;

  @IsOptional()
  @Matches(HEX_COLOR_PATTERN, { message: 'accentColor must be a hex color like #RRGGBB' })
  accentColor?: string;
}
