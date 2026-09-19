import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { CreateOrderItemDto } from './create-order-item.dto.js';

export class CreateOrderDto {
  @IsOptional()
  @IsUUID()
  businessId?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  businessSlug?: string;

  // Idempotency key — one per checkout attempt. Retrying the same request
  // (same clientRequestId, same business) never creates a second order.
  @IsUUID()
  clientRequestId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  table: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items: CreateOrderItemDto[];
}
