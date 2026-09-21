import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

// Shared by resolve and join — both only ever need the physical QR's own
// token.
export class QrTokenDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  qrToken: string;
}
