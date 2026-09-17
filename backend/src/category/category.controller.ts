import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { Category } from './category.entity.js';
import { CategoryService } from './category.service.js';
import { CategoryQueryDto } from './dto/category-query.dto.js';
import { CreateCategoryDto } from './dto/create-category.dto.js';

@Controller('categories')
export class CategoryController {
  constructor(private readonly categoryService: CategoryService) {}

  @Post()
  create(@Body() dto: CreateCategoryDto): Promise<Category> {
    return this.categoryService.create(dto);
  }

  @Get()
  findAll(@Query() query: CategoryQueryDto): Promise<Category[]> {
    return this.categoryService.findAll(query);
  }
}
