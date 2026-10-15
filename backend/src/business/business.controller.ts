import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
import { extractClientInfo } from '../audit/request-client-info.util.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import type { SafeUser } from '../auth/safe-user.js';
import { UploadTimeout } from '../common/http/request-timeout.decorator.js';
import { RateLimit } from '../rate-limit/rate-limit.decorator.js';
import { UserRole } from '../user/user-role.enum.js';
import { BusinessService } from './business.service.js';
import { BusinessPresenter, type BusinessListItem, type BusinessResponse } from './business.presenter.js';
import { buildPaginated, type Paginated } from '../common/pagination.util.js';
import { IMAGE_MULTER_HARD_LIMIT_BYTES } from '../common/limits/resource-limits.const.js';
import { BusinessListQueryDto } from './dto/business-list-query.dto.js';
import { BusinessQueryDto } from './dto/business-query.dto.js';
import { UpdateBusinessDto } from './dto/update-business.dto.js';

// "My own business" surface — no business-creation endpoint here (out of
// scope for this phase; a Business still only ever comes from the seed
// script). Every route requires an authenticated ADMIN/SUPER_ADMIN.
//
// Both mutations are audited via explicit AuditService.record() calls (per
// Fase 8A.1 design), not @Audit(...) + the interceptor — business config is
// sensitive enough to warrant metadata tailored per action (uploadLogo in
// particular must never let the interceptor's generic "request body" path
// anywhere near it, since that body is multipart file data).
@Controller('businesses')
export class BusinessController {
  constructor(
    private readonly businessService: BusinessService,
    private readonly auditService: AuditService,
    private readonly presenter: BusinessPresenter,
  ) {}

  // The one deliberately GLOBAL (cross-tenant) read in this controller: it lists the businesses themselves, which is
  // what a SUPER_ADMIN's business picker needs. SUPER_ADMIN only: an ADMIN gets 403, no JWT gets 401. It does not
  // look at the caller's businessId, and `?businessId=` is rejected by the whitelist (see BusinessListQueryDto).
  // Reads are not audited in this project, so nothing is recorded here either.
  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async findAll(@Query() query: BusinessListQueryDto): Promise<Paginated<BusinessListItem>> {
    const page = await this.businessService.findAll(query);
    return buildPaginated(
      page.items.map((row) => this.presenter.presentListItem(row)),
      page.page,
      page.limit,
      page.total,
    );
  }

  @Get('me')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async getMe(
    @Query() query: BusinessQueryDto,
    @CurrentUser() user: SafeUser,
  ): Promise<BusinessResponse> {
    return this.presenter.present(await this.businessService.getMe(query, user));
  }

  @Patch('me')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async updateMe(
    @Query() query: BusinessQueryDto,
    @Body() dto: UpdateBusinessDto,
    @CurrentUser() user: SafeUser,
    @Req() req: Request,
  ): Promise<BusinessResponse> {
    const updated = await this.businessService.updateMe(query, dto, user);
    void this.auditService.record({
      businessId: updated.id,
      userId: user.id,
      userEmail: user.email,
      action: AUDIT_ACTIONS.BUSINESS_UPDATED,
      entityType: AUDIT_ENTITY_TYPES.BUSINESS,
      entityId: updated.id,
      metadata: dto,
      ...extractClientInfo(req),
    });
    return this.presenter.present(updated);
  }

  @Post('me/logo')
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
  async uploadLogo(
    @Query() query: BusinessQueryDto,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: SafeUser,
    @Req() req: Request,
  ): Promise<BusinessResponse> {
    if (!file) {
      throw new BadRequestException({
        message: 'No file uploaded',
        errorCode: 'IMAGE_INVALID_FORMAT',
      });
    }
    const updated = await this.businessService.uploadLogo(query, user, file);
    void this.auditService.record({
      businessId: updated.id,
      userId: user.id,
      userEmail: user.email,
      action: AUDIT_ACTIONS.BUSINESS_LOGO_UPDATED,
      entityType: AUDIT_ENTITY_TYPES.BUSINESS,
      entityId: updated.id,
      // Never the raw file buffer — just enough to know what was uploaded.
      metadata: { originalName: file.originalname, mimeType: file.mimetype, sizeBytes: file.size },
      ...extractClientInfo(req),
    });
    return this.presenter.present(updated);
  }
}
