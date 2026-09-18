import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  resolveBusinessIdForCreate,
  resolveBusinessIdForRead,
  resolveBusinessIdForUpdate,
} from '../auth/tenant.util.js';
import type { SafeUser } from '../auth/safe-user.js';
import { Business } from '../business/business.entity.js';
import { Category } from '../category/category.entity.js';
import { CreateProductDto } from './dto/create-product.dto.js';
import { ProductQueryDto } from './dto/product-query.dto.js';
import { UpdateProductDto } from './dto/update-product.dto.js';
import { Product } from './product.entity.js';

@Injectable()
export class ProductService {
  constructor(
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
    @InjectRepository(Category)
    private readonly categoryRepository: Repository<Category>,
    @InjectRepository(Business)
    private readonly businessRepository: Repository<Business>,
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

  private async getCategoryOrThrow(categoryId: string): Promise<Category> {
    const category = await this.categoryRepository.findOne({
      where: { id: categoryId },
    });
    if (!category) {
      throw new NotFoundException(
        `Category with id "${categoryId}" does not exist`,
      );
    }
    return category;
  }

  private assertCategoryBelongsToBusiness(category: Category, businessId: string): void {
    if (category.businessId !== businessId) {
      throw new BadRequestException(
        `Category "${category.id}" does not belong to business "${businessId}"`,
      );
    }
  }

  private assertCategoryIsActive(category: Category): void {
    if (!category.active) {
      throw new ConflictException(
        `Category "${category.id}" is inactive and cannot be used for products`,
      );
    }
  }

  async create(dto: CreateProductDto, user: SafeUser): Promise<Product> {
    const businessId = resolveBusinessIdForCreate(user, dto.businessId);
    await this.assertBusinessExists(businessId);
    const category = await this.getCategoryOrThrow(dto.categoryId);
    this.assertCategoryBelongsToBusiness(category, businessId);
    this.assertCategoryIsActive(category);
    const product = this.productRepository.create(dto);
    product.businessId = businessId;
    return this.productRepository.save(product);
  }

  private async findActiveCategoryIds(businessId?: string, categoryId?: string): Promise<string[]> {
    const where: { active: boolean; businessId?: string; id?: string } = { active: true };
    if (businessId) where.businessId = businessId;
    if (categoryId) where.id = categoryId;
    const categories = await this.categoryRepository.find({ where, select: { id: true } });
    return categories.map((category) => category.id);
  }

  // Public menu read — active:false products never show up here, and
  // neither do products whose category is itself inactive (a product can't
  // be "in" a category the menu no longer shows). `available` is left
  // untouched: an unavailable-but-active product still appears (e.g. "sold
  // out today"), it's just flagged as unavailable.
  async findAllPublic(query: ProductQueryDto): Promise<Product[]> {
    const activeCategoryIds = await this.findActiveCategoryIds(query.businessId, query.categoryId);
    if (activeCategoryIds.length === 0) {
      return [];
    }

    const where: { active: boolean; categoryId: ReturnType<typeof In>; businessId?: string } = {
      active: true,
      categoryId: In(activeCategoryIds),
    };
    if (query.businessId) where.businessId = query.businessId;

    return this.productRepository.find({
      where,
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
  }

  async findOnePublic(id: string): Promise<Product> {
    const product = await this.productRepository.findOne({
      where: { id, active: true },
    });
    if (!product) {
      throw new NotFoundException(`Product with id "${id}" not found`);
    }
    const category = await this.categoryRepository.findOne({
      where: { id: product.categoryId, active: true },
    });
    if (!category) {
      // Same 404 as "doesn't exist" — an inactive parent category hides the
      // product from the public menu just as effectively as active:false.
      throw new NotFoundException(`Product with id "${id}" not found`);
    }
    return product;
  }

  // Admin listing — includes active:false products (and products under an
  // inactive category), scoped to the caller's tenant (ADMIN: always their
  // own business; SUPER_ADMIN: whatever they ask for, or everything if
  // unscoped).
  async findAllAdmin(query: ProductQueryDto, user: SafeUser): Promise<Product[]> {
    const businessId = resolveBusinessIdForRead(user, query.businessId);
    const where: Partial<Record<'businessId' | 'categoryId', string>> = {};
    if (businessId) where.businessId = businessId;
    if (query.categoryId) where.categoryId = query.categoryId;
    return this.productRepository.find({
      where,
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
  }

  // Internal lookup, no active filter — used by update() so a deactivated
  // product can still be found and reactivated.
  async findOne(id: string): Promise<Product> {
    const product = await this.productRepository.findOne({ where: { id } });
    if (!product) {
      throw new NotFoundException(`Product with id "${id}" not found`);
    }
    return product;
  }

  async update(id: string, dto: UpdateProductDto, user: SafeUser): Promise<Product> {
    const product = await this.findOne(id);

    // ADMIN: always their own business (throws if it doesn't match the
    // product's current one). SUPER_ADMIN: the requested business, or the
    // product's current one if none was sent.
    const businessId = resolveBusinessIdForUpdate(user, product.businessId, dto.businessId);

    if (businessId !== product.businessId) {
      await this.assertBusinessExists(businessId);
    }

    // Re-validate the category (existence, business, and active status)
    // whenever it's actually being assigned to the product: the category
    // changed, the business changed (so the current category needs
    // re-checking against the destination business), or the product is
    // being reactivated (active: false -> true) — a product can't come back
    // to the menu under a category that's no longer on it either. A plain
    // deactivation, or an edit that leaves an already-active product's
    // category untouched, doesn't re-run this.
    const categoryId = dto.categoryId ?? product.categoryId;
    const categoryTargetChanged = Boolean(dto.categoryId) || businessId !== product.businessId;
    const reactivating = dto.active === true && !product.active;

    if (categoryTargetChanged || reactivating) {
      const category = await this.getCategoryOrThrow(categoryId);
      this.assertCategoryBelongsToBusiness(category, businessId);
      this.assertCategoryIsActive(category);
    }

    Object.assign(product, dto, { businessId });
    return this.productRepository.save(product);
  }

  // Soft delete: sets deletedAt instead of removing the row, so it's
  // excluded from every find/findOne/count going forward (see the
  // deletedAt column comment on Product) while staying intact for any
  // future orders table to reference. No extra precondition beyond
  // ownership — unlike a category, a product has nothing under it.
  async remove(id: string, user: SafeUser): Promise<void> {
    const product = await this.findOne(id);
    resolveBusinessIdForUpdate(user, product.businessId, undefined);
    await this.productRepository.softDelete(id);
  }
}
