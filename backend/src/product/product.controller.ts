import {
  BadRequestException,
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
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { memoryStorage } from 'multer';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '../audit/audit-actions.const.js';
import { AuditService } from '../audit/audit.service.js';
import { Audit } from '../audit/decorators/audit.decorator.js';
import { extractClientInfo } from '../audit/request-client-info.util.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import type { SafeUser } from '../auth/safe-user.js';
import type { Paginated } from '../common/pagination.util.js';
import { UserRole } from '../user/user-role.enum.js';
import { IMAGE_MULTER_HARD_LIMIT_BYTES } from '../common/limits/resource-limits.const.js';
import { CreateProductDto } from './dto/create-product.dto.js';
import { ProductAdminQueryDto } from './dto/product-admin-query.dto.js';
import { ProductQueryDto } from './dto/product-query.dto.js';
import { ProductSummaryQueryDto } from './dto/product-summary-query.dto.js';
import { UpdateProductDto } from './dto/update-product.dto.js';
import { ProductPresenter, type ProductResponse } from './product.presenter.js';
import { UploadTimeout } from '../common/http/request-timeout.decorator.js';
import { RateLimit } from '../rate-limit/rate-limit.decorator.js';
import { ProductService, type ProductAdminSummary } from './product.service.js';

@Controller('products')
export class ProductController {
  constructor(
    private readonly productService: ProductService,
    private readonly auditService: AuditService,
    private readonly presenter: ProductPresenter,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Audit(AUDIT_ACTIONS.PRODUCT_CREATED, AUDIT_ENTITY_TYPES.PRODUCT)
  async create(
    @Body() dto: CreateProductDto,
    @CurrentUser() user: SafeUser,
  ): Promise<ProductResponse> {
    return this.presenter.present(await this.productService.create(dto, user));
  }

  // Must be declared before the ":id" route below, or Nest would try to
  // parse "admin" as a product id.
  @Get('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async findAllAdmin(
    @Query() query: ProductAdminQueryDto,
    @CurrentUser() user: SafeUser,
  ): Promise<Paginated<ProductResponse>> {
    return this.presenter.presentPage(await this.productService.findAllAdmin(query, user));
  }

  @Get('admin/summary')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  getAdminSummary(
    @Query() query: ProductSummaryQueryDto,
    @CurrentUser() user: SafeUser,
  ): Promise<ProductAdminSummary> {
    return this.productService.getAdminSummary(query, user);
  }

  @Get()
  @RateLimit('publicMenu')
  async findAll(@Query() query: ProductQueryDto): Promise<ProductResponse[]> {
    return this.presenter.presentMany(await this.productService.findAllPublic(query));
  }

  @Get(':id')
  @RateLimit('publicMenu')
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ProductQueryDto,
  ): Promise<ProductResponse> {
    return this.presenter.present(await this.productService.findOnePublic(id, query));
  }

  // Not @Audit(...): this one route covers both a plain edit and a
  // deactivation (dto.active === false) — which action name applies can
  // only be known from the request body at runtime, so it's logged
  // explicitly here instead of via the generic decorator/interceptor.
  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
    @CurrentUser() user: SafeUser,
    @Req() req: Request,
  ): Promise<ProductResponse> {
    const updated = await this.productService.update(id, dto, user);
    void this.auditService.record({
      businessId: updated.businessId,
      userId: user.id,
      userEmail: user.email,
      action: dto.active === false ? AUDIT_ACTIONS.PRODUCT_DEACTIVATED : AUDIT_ACTIONS.PRODUCT_UPDATED,
      entityType: AUDIT_ENTITY_TYPES.PRODUCT,
      entityId: updated.id,
      metadata: dto,
      ...extractClientInfo(req),
    });
    return this.presenter.present(updated);
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
    const { businessId } = await this.productService.remove(id, user);
    void this.auditService.record({
      businessId,
      userId: user.id,
      userEmail: user.email,
      action: AUDIT_ACTIONS.PRODUCT_DELETED,
      entityType: AUDIT_ENTITY_TYPES.PRODUCT,
      entityId: id,
      metadata: {},
      ...extractClientInfo(req),
    });
  }

  @Post(':id/image')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @RateLimit('upload')
  @UploadTimeout()
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: IMAGE_MULTER_HARD_LIMIT_BYTES },
    }),
  )
  async uploadImage(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: SafeUser,
  ): Promise<ProductResponse> {
    if (!file) {
      throw new BadRequestException({
        message: 'No file uploaded',
        errorCode: 'IMAGE_INVALID_FORMAT',
      });
    }
    return this.presenter.present(await this.productService.attachImage(id, user, file));
  }

  @Delete(':id/image')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async removeImage(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: SafeUser,
  ): Promise<ProductResponse> {
    return this.presenter.present(await this.productService.removeImage(id, user));
  }
}
