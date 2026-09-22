import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ProductAddOnDto } from './product-add-on.dto.js';

export class CreateProductDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsInt()
  @Min(0)
  price: number;

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsOptional()
  @IsBoolean()
  available?: boolean;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;

  // Short badge shown on the menu tile ("Más pedido", "Nuevo") — purely
  // cosmetic, no business logic reads this.
  @IsOptional()
  @IsString()
  @MaxLength(40)
  tag?: string;

  // Informational — shown on the product detail sheet. Not all of these
  // are removable (see removableIngredients below), so this list on its
  // own carries no ordering/pricing behavior.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  ingredients?: string[];

  // Must be a subset of `ingredients` — enforced in ProductService
  // (create/update), not here: a DTO can't see the *other* field's final
  // value after a partial PATCH merges onto the existing row, only the
  // service has that. Removing one of these from a cart line never
  // affects price.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  removableIngredients?: string[];

  // Customer-selectable extras, each with its own price — resolved and
  // priced server-side at order time (OrderService.create), never trusted
  // from the client's cart.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(15)
  @ValidateNested({ each: true })
  @Type(() => ProductAddOnDto)
  addOns?: ProductAddOnDto[];

  @IsUUID()
  businessId: string;

  @IsUUID()
  categoryId: string;
}
