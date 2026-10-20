import { applyDecorators, Body, Controller, Get, Header, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { extractClientInfo } from '../audit/request-client-info.util.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import type { SafeUser } from '../auth/safe-user.js';
import { RateLimit } from '../rate-limit/rate-limit.decorator.js';
import { UserRole } from '../user/user-role.enum.js';
import { type AdminDeletionResult, type AdminView, type AdminWithTemporaryPassword, BusinessAdminService } from './business-admin.service.js';
import { CreateBusinessAdminDto } from './dto/create-business-admin.dto.js';
import { DeleteBusinessAdminDto } from './dto/delete-business-admin.dto.js';

// Nothing here may be stored by a browser or an intermediary: some responses carry a temporary password, the rest list
// people's email addresses.
const NoStore = () => applyDecorators(Header('Cache-Control', 'no-store'), Header('Pragma', 'no-cache'));

// Management of a business's ADMIN accounts — SUPER_ADMIN ONLY, at class level: an ADMIN gets 403 on every route, even for
// their own business, and a restricted (must-change-password) SUPER_ADMIN is stopped by JwtAuthGuard first. The role is
// judged from the user the JWT strategy loaded (@CurrentUser), never from anything the client sends.
@Controller('businesses/:businessId/admins')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class BusinessAdminController {
  constructor(private readonly admins: BusinessAdminService) {}

  @Get()
  @NoStore()
  list(@Param('businessId', ParseUUIDPipe) businessId: string): Promise<AdminView[]> {
    return this.admins.list(businessId);
  }

  // 201. The ONLY place (besides reset-password) where a password appears: `temporaryPassword`, once, never stored in
  // clear, never logged, never audited.
  @Post()
  @NoStore()
  @RateLimit('adminProvisioning')
  create(
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Body() dto: CreateBusinessAdminDto,
    @CurrentUser() actor: SafeUser,
    @Req() req: Request,
  ): Promise<AdminWithTemporaryPassword> {
    return this.admins.create(businessId, dto, actor, extractClientInfo(req));
  }

  @Post(':userId/deactivate')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @RateLimit('adminStatus')
  async deactivate(
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() actor: SafeUser,
    @Req() req: Request,
  ): Promise<AdminView> {
    return (await this.admins.setActive(businessId, userId, false, actor, extractClientInfo(req))).user;
  }

  @Post(':userId/activate')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @RateLimit('adminStatus')
  async activate(
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() actor: SafeUser,
    @Req() req: Request,
  ): Promise<AdminView> {
    return (await this.admins.setActive(businessId, userId, true, actor, extractClientInfo(req))).user;
  }

  @Post(':userId/reset-password')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @RateLimit('adminProvisioning')
  resetPassword(
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() actor: SafeUser,
    @Req() req: Request,
  ): Promise<AdminWithTemporaryPassword> {
    return this.admins.resetPassword(businessId, userId, actor, extractClientInfo(req));
  }

  // Definitive deletion of a deactivated, never-used ADMIN (see BusinessAdminService.remove for the whole criterion).
  // POST, not DELETE: the exact-email confirmation travels in the body. 200 also when a retry finds the deletion already
  // done (alreadyDeleted: true).
  @Post(':userId/delete')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @RateLimit('adminProvisioning')
  remove(
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: DeleteBusinessAdminDto,
    @CurrentUser() actor: SafeUser,
    @Req() req: Request,
  ): Promise<AdminDeletionResult> {
    return this.admins.remove(businessId, userId, dto.confirmEmail, actor, extractClientInfo(req));
  }
}
