import { IsOptional, IsUUID } from 'class-validator';

// Same shape/purpose as TableQueryDto/ProductQueryDto's own businessId
// param: an ADMIN's own businessId always wins regardless of what's sent
// here (see resolveBusinessIdForRead); only a SUPER_ADMIN's request is
// actually scoped by this value.
export class BusinessQueryDto {
  @IsOptional()
  @IsUUID()
  businessId?: string;
}
