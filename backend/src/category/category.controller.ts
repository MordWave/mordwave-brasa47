import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '../audit/audit-actions.const.js';
import { AuditService } from '../audit/audit.service.js';
import { Audit } from '../audit/decorators/audit.decorator.js';
import { extractClientInfo } from '../audit/request-client-info.util.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import type { SafeUser } from '../auth/safe-user.js';
import { RateLimit } from '../rate-limit/rate-limit.decorator.js';
import { UserRole } from '../user/user-role.enum.js';
import { Category } from './category.entity.js';
import { CategoryService } from './category.service.js';
import { CategoryQueryDto } from './dto/category-query.dto.js';
import { CreateCategoryDto } from './dto/create-category.dto.js';
import { ReorderCategoriesDto } from './dto/reorder-categories.dto.js';
import { UpdateCategoryDto } from './dto/update-category.dto.js';

@Controller('categories')
export class CategoryController {
  constructor(
    private readonly categoryService: CategoryService,
    private readonly auditService: AuditService,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Audit(AUDIT_ACTIONS.CATEGORY_CREATED, AUDIT_ENTITY_TYPES.CATEGORY)
  create(
    @Body() dto: CreateCategoryDto,
    @CurrentUser() user: SafeUser,
  ): Promise<Category> {
    return this.categoryService.create(dto, user);
  }

  // Must be declared before the ":id" PATCH route below, or Nest would try
  // to parse "admin" as a category id.
  @Get('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  findAllAdmin(
    @Query() query: CategoryQueryDto,
    @CurrentUser() user: SafeUser,
  ): Promise<Category[]> {
    return this.categoryService.findAllAdmin(query, user);
  }

  // PUT /categories/order — the complete order of the restaurant's categories, saved in one transaction (see CategoryService.reorder).
  // An ADMIN always reorders their own restaurant; a SUPER_ADMIN names it with ?businessId=. 409 CATEGORY_ORDER_CONFLICT when the list the
  // caller saw is no longer the real one; 400 CATEGORY_ORDER_INVALID when the ids are not exactly the restaurant's.
  @Put('order')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async reorder(
    @Query() query: CategoryQueryDto,
    @Body() dto: ReorderCategoriesDto,
    @CurrentUser() user: SafeUser,
    @Req() req: Request,
  ): Promise<Category[]> {
    const { businessId, categories, changed } = await this.categoryService.reorder(query, dto, user);
    if (changed) {
      void this.auditService.record({
        businessId,
        userId: user.id,
        userEmail: user.email,
        action: AUDIT_ACTIONS.CATEGORY_REORDERED,
        entityType: AUDIT_ENTITY_TYPES.CATEGORY,
        entityId: businessId,
        metadata: { orderedIds: dto.orderedIds },
        ...extractClientInfo(req),
      });
    }
    return categories;
  }

  @Get()
  @RateLimit('publicMenu')
  findAll(@Query() query: CategoryQueryDto): Promise<Category[]> {
    return this.categoryService.findAllPublic(query);
  }

  // Explicit call, not @Audit(...): this route covers both a plain edit and
  // a deactivation (dto.active === false), which can only be told apart at
  // runtime from the request body.
  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryDto,
    @CurrentUser() user: SafeUser,
    @Req() req: Request,
  ): Promise<Category> {
    const updated = await this.categoryService.update(id, dto, user);
    void this.auditService.record({
      businessId: updated.businessId,
      userId: user.id,
      userEmail: user.email,
      action: dto.active === false ? AUDIT_ACTIONS.CATEGORY_DEACTIVATED : AUDIT_ACTIONS.CATEGORY_UPDATED,
      entityType: AUDIT_ENTITY_TYPES.CATEGORY,
      entityId: updated.id,
      metadata: dto,
      ...extractClientInfo(req),
    });
    return updated;
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: SafeUser,
    @Req() req: Request,
  ): Promise<void> {
    const { businessId } = await this.categoryService.remove(id, user);
    void this.auditService.record({
      businessId,
      userId: user.id,
      userEmail: user.email,
      action: AUDIT_ACTIONS.CATEGORY_DELETED,
      entityType: AUDIT_ENTITY_TYPES.CATEGORY,
      entityId: id,
      metadata: {},
      ...extractClientInfo(req),
    });
  }
}
