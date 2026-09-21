import { IsOptional, IsUUID } from 'class-validator';

export class TableQueryDto {
  @IsOptional()
  @IsUUID()
  businessId?: string;
}
