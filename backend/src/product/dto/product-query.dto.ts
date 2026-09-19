import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class ProductQueryDto {
  @IsOptional()
  @IsUUID()
  businessId?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  businessSlug?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;
}
