import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Business } from './business.entity.js';

export interface PublicBusinessQuery {
  businessId?: string;
  businessSlug?: string;
}

// Every unauthenticated public menu read (categories, products) must be
// scoped to exactly one business, identified by the caller via id or slug —
// never both (ambiguous) and never neither (would otherwise mix every
// tenant's menu together once more than one business exists).
@Injectable()
export class PublicBusinessResolverService {
  constructor(
    @InjectRepository(Business)
    private readonly businessRepository: Repository<Business>,
  ) {}

  async resolve(query: PublicBusinessQuery): Promise<string> {
    const { businessId, businessSlug } = query;

    if (businessId && businessSlug) {
      throw new BadRequestException(
        'Provide either businessId or businessSlug, not both',
      );
    }
    if (!businessId && !businessSlug) {
      throw new BadRequestException('businessId or businessSlug is required');
    }

    const business = await this.businessRepository.findOne({
      where: businessId
        ? { id: businessId, active: true }
        : { slug: businessSlug, active: true },
    });

    if (!business) {
      throw new NotFoundException({
        message: 'Business not found',
        errorCode: 'BUSINESS_NOT_FOUND',
      });
    }

    return business.id;
  }
}
