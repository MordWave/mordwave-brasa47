import { Type } from 'class-transformer';
import {
  IsArray,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { ProductAddOnDto } from './product-add-on.dto.js';

export class ProductModifiersDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  remove?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductAddOnDto)
  add?: ProductAddOnDto[];
}
