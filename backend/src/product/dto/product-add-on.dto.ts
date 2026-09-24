import { IsInt, IsNotEmpty, IsString, Max, MaxLength, Min } from 'class-validator';

// One customer-selectable extra on a product ("Queso extra", "Tocino"),
// with its own price — CLP integer, no cents, same convention as
// Product.price. Server-resolved at order time (OrderService.create)
// against the product's own list; the client never sends a price.
export class ProductAddOnDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name: string;

  @IsInt()
  @Min(0)
  @Max(100_000)
  price: number;
}
