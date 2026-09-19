import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  resolveBusinessIdForCreate,
  resolveBusinessIdForRead,
  resolveBusinessIdForUpdate,
} from '../auth/tenant.util.js';
import type { SafeUser } from '../auth/safe-user.js';
import { Business } from '../business/business.entity.js';
import { PublicBusinessResolverService } from '../business/public-business-resolver.service.js';
import { Product } from '../product/product.entity.js';
import { Category } from './category.entity.js';
import { CategoryQueryDto } from './dto/category-query.dto.js';
import { CreateCategoryDto } from './dto/create-category.dto.js';
import { UpdateCategoryDto } from './dto/update-category.dto.js';

@Injectable()
export class CategoryService {
  constructor(
    @InjectRepository(Category)
    private readonly categoryRepository: Repository<Category>,
    @InjectRepository(Business)
    private readonly businessRepository: Repository<Business>,
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
    private readonly publicBusinessResolver: PublicBusinessResolverService,
  ) {}

  private async assertBusinessExists(businessId: string): Promise<void> {
    const business = await this.businessRepository.findOne({
      where: { id: businessId },
    });
    if (!business) {
      throw new NotFoundException(
        `Business with id "${businessId}" does not exist`,
      );
    }
  }

  async create(dto: CreateCategoryDto, user: SafeUser): Promise<Category> {
    const businessId = resolveBusinessIdForCreate(user, dto.businessId);
    await this.assertBusinessExists(businessId);
    const category = this.categoryRepository.create(dto);
    category.businessId = businessId;
    return this.categoryRepository.save(category);
  }

  // Public menu read — active:false categories never show up here. Always
  // scoped to exactly one business (see PublicBusinessResolverService) — an
  // unscoped public read would otherwise mix every tenant's menu together.
  async findAllPublic(query: CategoryQueryDto): Promise<Category[]> {
    const businessId = await this.publicBusinessResolver.resolve(query);
    return this.categoryRepository.find({
      where: { businessId, active: true },
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
  }

  // Admin listing — includes active:false categories, scoped to the
  // caller's tenant (ADMIN: always their own business; SUPER_ADMIN:
  // whatever they ask for, or everything if unscoped).
  async findAllAdmin(query: CategoryQueryDto, user: SafeUser): Promise<Category[]> {
    const businessId = resolveBusinessIdForRead(user, query.businessId);
    return this.categoryRepository.find({
      where: businessId ? { businessId } : {},
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
  }

  // Internal lookup, no active filter — used by update() so a deactivated
  // category can still be found and reactivated.
  private async findOne(id: string): Promise<Category> {
    const category = await this.categoryRepository.findOne({ where: { id } });
    if (!category) {
      throw new NotFoundException(`Category with id "${id}" not found`);
    }
    return category;
  }

  async update(id: string, dto: UpdateCategoryDto, user: SafeUser): Promise<Category> {
    const category = await this.findOne(id);

    // businessId isn't part of UpdateCategoryDto (immutable), so this only
    // ever enforces ownership: ADMIN must own this category, SUPER_ADMIN
    // always passes.
    resolveBusinessIdForUpdate(user, category.businessId, undefined);

    if (dto.active === false && category.active) {
      const activeProductCount = await this.productRepository.count({
        where: { categoryId: id, active: true },
      });
      if (activeProductCount > 0) {
        throw new ConflictException({
          message: `Cannot deactivate category "${id}": it still has ${activeProductCount} active product(s). Deactivate them first.`,
          errorCode: 'CATEGORY_HAS_ACTIVE_PRODUCTS',
          count: activeProductCount,
        });
      }
    }

    Object.assign(category, dto);
    return this.categoryRepository.save(category);
  }

  // Soft delete: sets deletedAt instead of removing the row (see the
  // deletedAt column comment on Category), so every existing find/findOne/
  // count already excludes it going forward. Blocked while the category
  // still has any non-deleted product under it — active or inactive,
  // unlike the deactivate check above, which only cares about active ones —
  // since deleting the category out from under a still-existing product
  // would leave that product pointing at a category that no longer exists
  // for any normal purpose.
  async remove(id: string, user: SafeUser): Promise<void> {
    const category = await this.findOne(id);
    resolveBusinessIdForUpdate(user, category.businessId, undefined);

    const productCount = await this.productRepository.count({
      where: { categoryId: id },
    });
    if (productCount > 0) {
      throw new ConflictException({
        message: `Cannot delete category "${id}": it still has ${productCount} product(s). Delete or move them first.`,
        errorCode: 'CATEGORY_HAS_PRODUCTS',
        count: productCount,
      });
    }

    await this.categoryRepository.softDelete(id);
  }
}
