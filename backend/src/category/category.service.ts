import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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

  async create(dto: CreateCategoryDto): Promise<Category> {
    const business = await this.businessRepository.findOne({
      where: { id: dto.businessId },
    });
    if (!business) {
      throw new NotFoundException(
        `Business with id "${dto.businessId}" does not exist`,
      );
    }
    const category = this.categoryRepository.create(dto);
    return this.categoryRepository.save(category);
  }

  async findAll(query: CategoryQueryDto): Promise<Category[]> {
    return this.categoryRepository.find({
      where: query.businessId ? { businessId: query.businessId } : {},
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
  }
}
