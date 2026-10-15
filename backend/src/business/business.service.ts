import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { type FindOptionsWhere, ILike, Repository } from 'typeorm';
import { resolveBusinessIdForRead } from '../auth/tenant.util.js';
import {
  PAGINATION_DEFAULT_LIMIT,
  PAGINATION_DEFAULT_PAGE,
} from '../common/pagination.const.js';
import { buildPaginated, escapeLikePattern, type Paginated } from '../common/pagination.util.js';
import type { SafeUser } from '../auth/safe-user.js';
import { businessLogoKey } from '../media/media-key.util.js';
import { ImageStorageService, type UploadableFile } from '../storage/image-storage.service.js';
import { Business } from './business.entity.js';
import type { BusinessListRow } from './business.presenter.js';
import { BusinessListQueryDto } from './dto/business-list-query.dto.js';
import { BusinessQueryDto } from './dto/business-query.dto.js';
import { UpdateBusinessDto } from './dto/update-business.dto.js';

@Injectable()
export class BusinessService {
  private readonly logger = new Logger(BusinessService.name);

  constructor(
    @InjectRepository(Business)
    private readonly businessRepository: Repository<Business>,
    private readonly imageStorage: ImageStorageService,
  ) {}

  // Business has no "reassign to a different tenant" concept the way
  // Product/Category/Table do (resolveBusinessIdForUpdate exists for
  // exactly that, which doesn't apply here — there's no separate
  // "current" vs "requested" business, just "which one am I"). The read
  // resolver already expresses precisely that: an ADMIN's own businessId
  // always wins, a SUPER_ADMIN must say which one via ?businessId=. Used
  // for get/update/logo alike, since none of them "move" anything.
  private resolveTargetBusinessId(user: SafeUser, requestedBusinessId: string | undefined): string {
    const businessId = resolveBusinessIdForRead(user, requestedBusinessId);
    if (!businessId) {
      throw new BadRequestException(
        'businessId is required for a SUPER_ADMIN on this endpoint',
      );
    }
    return businessId;
  }

  private async findOrThrow(businessId: string): Promise<Business> {
    const business = await this.businessRepository.findOne({ where: { id: businessId } });
    if (!business) {
      throw new NotFoundException(`Business with id "${businessId}" not found`);
    }
    return business;
  }

  // GLOBAL listing for the SUPER_ADMIN business picker: one of the very few reads that is deliberately NOT
  // tenant-scoped, so it takes no user and never goes through the resolveBusinessIdFor* helpers (the controller's
  // @Roles(SUPER_ADMIN) is the gate). Paginated with a real total — businesses are few, the COUNT is cheap.
  // Only the columns a picker needs are selected (the storage key is selected only to build logoUrl in the
  // presenter and is never returned); no relations are loaded, so there is no N+1. `id` is the ORDER BY tiebreaker
  // so businesses sharing a name can never shuffle between pages. `search` is a parameterised ILIKE (TypeORM) on
  // name OR slug, with LIKE wildcards escaped.
  async findAll(query: BusinessListQueryDto): Promise<Paginated<BusinessListRow>> {
    const page = query.page ?? PAGINATION_DEFAULT_PAGE;
    const limit = query.limit ?? PAGINATION_DEFAULT_LIMIT;

    const filters: FindOptionsWhere<Business> = {};
    if (query.active !== undefined) filters.active = query.active;

    let where: FindOptionsWhere<Business> | FindOptionsWhere<Business>[] = filters;
    if (query.search) {
      const pattern = ILike(`%${escapeLikePattern(query.search)}%`);
      where = [
        { ...filters, name: pattern },
        { ...filters, slug: pattern },
      ];
    }

    const [items, total] = await this.businessRepository.findAndCount({
      select: { id: true, name: true, slug: true, active: true, logoStorageKey: true },
      where,
      order: { name: 'ASC', id: 'ASC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return buildPaginated(items, page, limit, total);
  }

  async getMe(query: BusinessQueryDto, user: SafeUser): Promise<Business> {
    const businessId = this.resolveTargetBusinessId(user, query.businessId);
    return this.findOrThrow(businessId);
  }

  async updateMe(query: BusinessQueryDto, dto: UpdateBusinessDto, user: SafeUser): Promise<Business> {
    const businessId = this.resolveTargetBusinessId(user, query.businessId);
    const business = await this.findOrThrow(businessId);
    Object.assign(business, dto);
    return this.businessRepository.save(business);
  }

  // New logo: upload to the bucket under a brand-new key (businesses/<id>/logo/
  // <uuid>.webp), THEN point the row at it. The previous logo object is never
  // deleted here, and a DB failure after the upload only leaves a logged orphan
  // candidate.
  async uploadLogo(query: BusinessQueryDto, user: SafeUser, file: UploadableFile): Promise<Business> {
    const businessId = this.resolveTargetBusinessId(user, query.businessId);
    const business = await this.findOrThrow(businessId);

    const storageKey = await this.imageStorage.upload(businessLogoKey(businessId), file);

    business.logoStorageKey = storageKey;
    try {
      return await this.businessRepository.save(business);
    } catch (error) {
      this.logger.error(`Logo uploaded but not saved; orphan candidate key=${storageKey}`);
      throw error;
    }
  }
}
