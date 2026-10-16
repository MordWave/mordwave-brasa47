import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
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
import { BusinessLifecycleService } from './business-lifecycle.service.js';
import { AdminUpdateBusinessDto } from './dto/admin-update-business.dto.js';
import { CreateBusinessDto } from './dto/create-business.dto.js';
import { DeactivateBusinessDto } from './dto/deactivate-business.dto.js';
import { BusinessListQueryDto } from './dto/business-list-query.dto.js';
import { BusinessQueryDto } from './dto/business-query.dto.js';
import { UpdateBusinessDto } from './dto/update-business.dto.js';

// "My own business" surface plus the SUPER_ADMIN-only listing and creation. Every route requires an authenticated
// user; there is no public way to create a business.
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
    private readonly lifecycle: BusinessLifecycleService,
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

  // SUPER_ADMIN only (401 without a JWT, 403 for an ADMIN). The new business is created ACTIVE, the entity's own
  // default and the only state a SUPER_ADMIN can enter from the picker; with no products, categories or tables it
  // shows an empty public menu, and with no ADMIN assigned only a SUPER_ADMIN can manage it until user
  // provisioning exists. The audit entry belongs to the NEW business (businessId = its id) and is awaited so the
  // trail exists before the response; AuditService.record never throws. Metadata is just name and slug.
  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async create(
    @Body() dto: CreateBusinessDto,
    @CurrentUser() user: SafeUser,
    @Req() req: Request,
  ): Promise<BusinessResponse> {
    const created = await this.businessService.create(dto);
    await this.auditService.record({
      businessId: created.id,
      userId: user.id,
      userEmail: user.email,
      action: AUDIT_ACTIONS.BUSINESS_CREATED,
      entityType: AUDIT_ENTITY_TYPES.BUSINESS,
      entityId: created.id,
      metadata: { name: created.name, slug: created.slug },
      ...extractClientInfo(req),
    });
    return this.presenter.present(created);
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

  // ---- SUPER_ADMIN management of ONE business by id ---------------------------------------------------------
  // Declared after the /me routes, and :id is a ParseUUIDPipe, so "me" can never be read as an id. These never look at
  // the caller's own businessId: the target is always the path parameter. Reads and the commit of the transition come
  // first; the audit entry (best-effort, see AuditService.record) is written only for a transition that really
  // happened, attributed to the real actor and to the affected business.

  @Get(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<BusinessResponse> {
    return this.presenter.present(await this.lifecycle.findOne(id));
  }

  // Name, address, phone and hours only; works on inactive businesses too. slug/active/colours/logo are rejected (400).
  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async updateById(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminUpdateBusinessDto,
    @CurrentUser() user: SafeUser,
    @Req() req: Request,
  ): Promise<BusinessResponse> {
    const result = await this.lifecycle.update(id, dto);
    if (result.changed) {
      await this.auditService.record({
        businessId: id,
        userId: user.id,
        userEmail: user.email,
        action: AUDIT_ACTIONS.BUSINESS_UPDATED,
        entityType: AUDIT_ENTITY_TYPES.BUSINESS,
        entityId: id,
        metadata: { changes: result.changes },
        ...extractClientInfo(req),
      });
    }
    return this.presenter.present(result.business);
  }

  // Reversible suspension. 409 BUSINESS_HAS_PENDING_ORDERS while any order is still NEW; idempotent (200, no audit)
  // when already inactive. Closes the business's open table sessions in the same transaction.
  @Post(':id/deactivate')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeactivateBusinessDto,
    @CurrentUser() user: SafeUser,
    @Req() req: Request,
  ): Promise<BusinessResponse> {
    const result = await this.lifecycle.deactivate(id);
    if (result.changed) {
      await this.auditService.record({
        businessId: id,
        userId: user.id,
        userEmail: user.email,
        action: AUDIT_ACTIONS.BUSINESS_DEACTIVATED,
        entityType: AUDIT_ENTITY_TYPES.BUSINESS,
        entityId: id,
        metadata: { reason: dto.reason ?? null, closedSessions: result.closedSessions },
        ...extractClientInfo(req),
      });
    }
    return this.presenter.present(result.business);
  }

  // Only flips the flag back; sessions closed by the suspension are not reopened. Idempotent (200, no audit).
  @Post(':id/activate')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async activate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: SafeUser,
    @Req() req: Request,
  ): Promise<BusinessResponse> {
    const result = await this.lifecycle.activate(id);
    if (result.changed) {
      await this.auditService.record({
        businessId: id,
        userId: user.id,
        userEmail: user.email,
        action: AUDIT_ACTIONS.BUSINESS_REACTIVATED,
        entityType: AUDIT_ENTITY_TYPES.BUSINESS,
        entityId: id,
        metadata: {},
        ...extractClientInfo(req),
      });
    }
    return this.presenter.present(result.business);
  }
}
