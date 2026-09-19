import { IsIn } from 'class-validator';
import { OrderStatus } from '../order-status.enum.js';

export class UpdateOrderStatusDto {
  // NEW is deliberately excluded — it's only ever the initial status set by
  // create(), never a target of a status update.
  @IsIn([OrderStatus.DELIVERED, OrderStatus.CANCELLED])
  status: OrderStatus.DELIVERED | OrderStatus.CANCELLED;
}
