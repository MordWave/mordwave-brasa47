import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

// join's own body — only ever needs the physical QR's own token.
export class QrTokenDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  qrToken: string;
}
