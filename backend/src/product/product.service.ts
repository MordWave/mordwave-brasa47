import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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

  private async assertCategoryBelongsToBusiness(
    categoryId: string,
    businessId: string,
  ): Promise<void> {
    const category = await this.categoryRepository.findOne({
      where: { id: categoryId },
    });
    if (!category) {
      throw new NotFoundException(
        `Category with id "${categoryId}" does not exist`,
      );
    }
    if (category.businessId !== businessId) {
      throw new BadRequestException(
        `Category "${categoryId}" does not belong to business "${businessId}"`,
      );
    }
  }

  async create(dto: CreateProductDto, user: SafeUser): Promise<Product> {
    const businessId = resolveBusinessIdForCreate(user, dto.businessId);
    await this.assertBusinessExists(businessId);
    await this.assertCategoryBelongsToBusiness(dto.categoryId, businessId);
    const product = this.productRepository.create(dto);
    product.businessId = businessId;
    return this.productRepository.save(product);
  }

  // Public menu read — active:false products never show up here.
  // `available` is left untouched: an unavailable-but-active product still
  // appears (e.g. "sold out today"), it's just flagged as unavailable.
  async findAllPublic(query: ProductQueryDto): Promise<Product[]> {
    const where: { active: boolean; businessId?: string; categoryId?: string } = {
      active: true,
    };
    if (query.businessId) where.businessId = query.businessId;
    if (query.categoryId) where.categoryId = query.categoryId;
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
    return product;
  }

  // Admin listing — includes active:false products, scoped to the caller's
  // tenant (ADMIN: always their own business; SUPER_ADMIN: whatever they ask
  // for, or everything if unscoped).
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

    // Re-validate the category against the *resolved* business whenever the
    // category changes, or whenever the business itself changes — moving a
    // product to another business without also moving its category would
    // otherwise leave Product.businessId and Category.businessId
    // inconsistent.
    const categoryId = dto.categoryId ?? product.categoryId;
    if (dto.categoryId || businessId !== product.businessId) {
      await this.assertCategoryBelongsToBusiness(categoryId, businessId);
    }

    Object.assign(product, dto, { businessId });
    return this.productRepository.save(product);
  }
}
