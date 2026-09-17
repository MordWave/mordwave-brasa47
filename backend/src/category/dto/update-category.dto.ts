import { OmitType, PartialType } from '@nestjs/mapped-types';
import { CreateCategoryDto } from './create-category.dto.js';

// businessId is immutable after creation — moving a category to another
// business would leave its products' businessId inconsistent with it.
// Omitting the field here means sending it is rejected outright by the
// global ValidationPipe's forbidNonWhitelisted, not just ignored.
export class UpdateCategoryDto extends PartialType(
  OmitType(CreateCategoryDto, ['businessId'] as const),
) {}
