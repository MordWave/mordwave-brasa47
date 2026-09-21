import { IsBoolean, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class CreateTableDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  name: string;

  @IsUUID()
  businessId: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
