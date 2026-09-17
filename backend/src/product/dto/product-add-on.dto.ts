import { IsNumber, IsString, Min } from 'class-validator';

export class ProductAddOnDto {
  @IsString()
  name: string;

  @IsNumber()
  @Min(0)
  price: number;
}
