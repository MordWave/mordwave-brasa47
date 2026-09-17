import { IsOptional, IsUUID } from 'class-validator';

export class ProductQueryDto {
  @IsOptional()
  @IsUUID()
  businessId?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;
}
