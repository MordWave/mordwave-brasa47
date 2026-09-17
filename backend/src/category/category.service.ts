import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { resolveBusinessIdForCreate } from '../auth/tenant.util.js';
import type { SafeUser } from '../auth/safe-user.js';
import { Business } from '../business/business.entity.js';
import { Category } from './category.entity.js';
import { CategoryQueryDto } from './dto/category-query.dto.js';
import { CreateCategoryDto } from './dto/create-category.dto.js';

@Injectable()
export class CategoryService {
  constructor(
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

  async create(dto: CreateCategoryDto, user: SafeUser): Promise<Category> {
    const businessId = resolveBusinessIdForCreate(user, dto.businessId);
    await this.assertBusinessExists(businessId);
    const category = this.categoryRepository.create(dto);
    category.businessId = businessId;
    return this.categoryRepository.save(category);
  }

  async findAll(query: CategoryQueryDto): Promise<Category[]> {
    return this.categoryRepository.find({
      where: query.businessId ? { businessId: query.businessId } : {},
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
  }
}
