import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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

  async create(dto: CreateProductDto): Promise<Product> {
    await this.assertBusinessExists(dto.businessId);
    await this.assertCategoryBelongsToBusiness(dto.categoryId, dto.businessId);
    const product = this.productRepository.create(dto);
    return this.productRepository.save(product);
  }

  async findAll(query: ProductQueryDto): Promise<Product[]> {
    const where: Partial<Record<'businessId' | 'categoryId', string>> = {};
    if (query.businessId) where.businessId = query.businessId;
    if (query.categoryId) where.categoryId = query.categoryId;
    return this.productRepository.find({
      where,
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
  }

  async findOne(id: string): Promise<Product> {
    const product = await this.productRepository.findOne({ where: { id } });
    if (!product) {
      throw new NotFoundException(`Product with id "${id}" not found`);
    }
    return product;
  }

  async update(id: string, dto: UpdateProductDto): Promise<Product> {
    const product = await this.findOne(id);
    const businessId = dto.businessId ?? product.businessId;
    if (dto.businessId) {
      await this.assertBusinessExists(dto.businessId);
    }
    if (dto.categoryId) {
      await this.assertCategoryBelongsToBusiness(dto.categoryId, businessId);
    }
    Object.assign(product, dto);
    return this.productRepository.save(product);
  }
}
