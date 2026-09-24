import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { resolveBusinessIdForRead } from '../auth/tenant.util.js';
import type { SafeUser } from '../auth/safe-user.js';
import { ImageStorageService, type UploadableFile } from '../storage/image-storage.service.js';
import { Business } from './business.entity.js';
import { BusinessQueryDto } from './dto/business-query.dto.js';
import { UpdateBusinessDto } from './dto/update-business.dto.js';

@Injectable()
export class BusinessService {
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

  // Distinct storage prefix from Product's own ({businessId}/{productId}/
  // imagen.webp) — nothing to disambiguate by id here (one logo per
  // business), just a fixed name under its own top-level folder so it can
  // never collide with a product image path.
  private buildLogoPath(businessId: string): string {
    return `business-logos/${businessId}/logo.webp`;
  }

  async uploadLogo(query: BusinessQueryDto, user: SafeUser, file: UploadableFile): Promise<Business> {
    const businessId = this.resolveTargetBusinessId(user, query.businessId);
    const business = await this.findOrThrow(businessId);

    // upsert:true (inside ImageStorageService) means re-uploading a logo
    // overwrites the previous object at this same fixed path — no
    // separate "delete the old one first" step needed, same as products.
    const logoUrl = await this.imageStorage.upload(this.buildLogoPath(businessId), file);

    business.logoUrl = logoUrl;
    return this.businessRepository.save(business);
  }
}
