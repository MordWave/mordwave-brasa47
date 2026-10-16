import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '../audit/audit-actions.const.js';
import { AuditService } from '../audit/audit.service.js';
import { extractClientInfo } from '../audit/request-client-info.util.js';
import { RateLimit } from '../rate-limit/rate-limit.decorator.js';
import { AuthService, type LoginResult } from './auth.service.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import type { SafeUser } from './safe-user.js';
import { UserRole } from '../user/user-role.enum.js';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly auditService: AuditService,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @RateLimit('login')
  login(@Body() dto: LoginDto): Promise<LoginResult> {
    return this.authService.login(dto);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: SafeUser): SafeUser {
    return user;
  }

  // The user changes their OWN password. Any authenticated role may (ADMIN, SUPER_ADMIN); there is no role check and
  // no way to name another user. Every attempt, failed ones included, is charged to the changePassword rate limits.
  // Audited (success only) for an ADMIN, scoped to their business, with EMPTY metadata: no password, hash or token is
  // ever recorded. A SUPER_ADMIN has no business to scope an audit row to (audit_logs.business_id is NOT NULL), so
  // their change is NOT audited — the platform-level audit trail is still pending (it needs a schema change).
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @RateLimit('changePassword')
  async changePassword(
    @CurrentUser() user: SafeUser,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ): Promise<LoginResult> {
    const result = await this.authService.changePassword(user.id, dto);
    if (result.user.role === UserRole.ADMIN && result.user.businessId) {
      await this.auditService.record({
        businessId: result.user.businessId,
        userId: result.user.id,
        userEmail: result.user.email,
        action: AUDIT_ACTIONS.USER_PASSWORD_CHANGED,
        entityType: AUDIT_ENTITY_TYPES.USER,
        entityId: result.user.id,
        metadata: {},
        ...extractClientInfo(req),
      });
    }
    return result;
  }
}
