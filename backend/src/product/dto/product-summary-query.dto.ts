import { PickType } from '@nestjs/mapped-types';
import { ProductAdminQueryDto } from './product-admin-query.dto.js';

// Same filters as the list (and the same validators/transforms, inherited via
// PickType) EXCEPT categoryId and pagination: the summary breaks the filtered
// set down BY category, so the category chips can show how many products
// each category has under the current search/active/available filters.
export class ProductSummaryQueryDto extends PickType(ProductAdminQueryDto, [
  'businessId',
  'search',
  'active',
  'available',
] as const) {}
