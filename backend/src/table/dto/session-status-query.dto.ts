import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

// By body, never a query param.
export class SessionStatusQueryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  sessionToken: string;
}
