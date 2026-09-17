import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import type { SafeUser } from '../auth/safe-user.js';
import { UserRole } from '../user/user-role.enum.js';
import { Category } from './category.entity.js';
import { CategoryService } from './category.service.js';
import { CategoryQueryDto } from './dto/category-query.dto.js';
import { CreateCategoryDto } from './dto/create-category.dto.js';

@Controller('categories')
export class CategoryController {
  constructor(private readonly categoryService: CategoryService) {}

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  create(
    @Body() dto: CreateCategoryDto,
    @CurrentUser() user: SafeUser,
  ): Promise<Category> {
    return this.categoryService.create(dto, user);
  }

  @Get()
  findAll(@Query() query: CategoryQueryDto): Promise<Category[]> {
    return this.categoryService.findAll(query);
  }
}
