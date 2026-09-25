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
import { UserRole } from '../user/user-role.enum.js';
import { BusinessService } from './business.service.js';
import { Business } from './business.entity.js';
import { BusinessQueryDto } from './dto/business-query.dto.js';
import { UpdateBusinessDto } from './dto/update-business.dto.js';

// Pure infrastructure-level ceiling, same as ProductController's own — the
// real 10 MB business rule is enforced inside ImageStorageService.
const MULTER_HARD_LIMIT_BYTES = 20 * 1024 * 1024;

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
  ) {}

  @Get('me')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  getMe(@Query() query: BusinessQueryDto, @CurrentUser() user: SafeUser): Promise<Business> {
    return this.businessService.getMe(query, user);
  }

  @Patch('me')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async updateMe(
    @Query() query: BusinessQueryDto,
    @Body() dto: UpdateBusinessDto,
    @CurrentUser() user: SafeUser,
    @Req() req: Request,
  ): Promise<Business> {
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
    return updated;
  }

  @Post('me/logo')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MULTER_HARD_LIMIT_BYTES },
    }),
  )
  async uploadLogo(
    @Query() query: BusinessQueryDto,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: SafeUser,
    @Req() req: Request,
  ): Promise<Business> {
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
    return updated;
  }
}
