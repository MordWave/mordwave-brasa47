import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class CategoryQueryDto {
  @IsOptional()
  @IsUUID()
  businessId?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  businessSlug?: string;
}
