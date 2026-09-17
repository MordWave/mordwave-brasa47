import { IsOptional, IsUUID } from 'class-validator';

export class ProductQueryDto {
  @IsOptional()
  @IsUUID()
  categoryId?: string;
}
