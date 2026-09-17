import { IsOptional, IsUUID } from 'class-validator';

export class CategoryQueryDto {
  @IsOptional()
  @IsUUID()
  businessId?: string;
}
