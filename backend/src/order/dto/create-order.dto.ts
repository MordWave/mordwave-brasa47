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
  // Opaque token from TableSession.sessionToken (generateOpaqueToken
  // output), not a UUID. Business/table are derived server-side from it —
  // the client can no longer choose either. Shared by every device at the
  // table; any of them can order independently.
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  sessionToken: string;

  // Idempotency key — one per checkout attempt. Retrying the same request
  // (same clientRequestId, same business) never creates a second order,
  // as long as sessionToken is still valid.
  @IsUUID()
  clientRequestId: string;

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
