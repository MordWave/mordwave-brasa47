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
import { UserRole } from '../user/user-role.enum.js';
import { CreateTableDto } from './dto/create-table.dto.js';
import { TableQueryDto } from './dto/table-query.dto.js';
import { UpdateTableDto } from './dto/update-table.dto.js';
import { AdminTableSummary, PublicTable, TableQrResult, TableService } from './table.service.js';
import { PublicTableSession, TableSessionService } from './table-session.service.js';

@Controller('tables')
export class TableController {
  constructor(
    private readonly tableService: TableService,
    private readonly tableSessionService: TableSessionService,
    private readonly auditService: AuditService,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Audit(AUDIT_ACTIONS.TABLE_CREATED, AUDIT_ENTITY_TYPES.TABLE)
  create(
    @Body() dto: CreateTableDto,
    @CurrentUser() user: SafeUser,
  ): Promise<PublicTable> {
    return this.tableService.create(dto, user);
  }

  @Get('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  findAllAdmin(
    @Query() query: TableQueryDto,
    @CurrentUser() user: SafeUser,
  ): Promise<AdminTableSummary[]> {
    return this.tableService.findAllAdmin(query, user);
  }

  // Explicit call, not @Audit(...): this route covers both a plain edit and
  // a deactivation (dto.active === false), which can only be told apart at
  // runtime from the request body.
  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTableDto,
    @CurrentUser() user: SafeUser,
    @Req() req: Request,
  ): Promise<PublicTable> {
    const updated = await this.tableService.update(id, dto, user);
    void this.auditService.record({
      businessId: updated.businessId,
      userId: user.id,
      userEmail: user.email,
      action: dto.active === false ? AUDIT_ACTIONS.TABLE_DEACTIVATED : AUDIT_ACTIONS.TABLE_UPDATED,
      entityType: AUDIT_ENTITY_TYPES.TABLE,
      entityId: updated.id,
      metadata: dto,
      ...extractClientInfo(req),
    });
    return updated;
  }

  @Post(':id/sessions')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Audit(AUDIT_ACTIONS.TABLE_SESSION_OPENED, AUDIT_ENTITY_TYPES.TABLE_SESSION)
  openSession(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: SafeUser,
  ): Promise<PublicTableSession> {
    return this.tableSessionService.open(id, user);
  }

  @Patch(':id/sessions/current')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Audit(AUDIT_ACTIONS.TABLE_SESSION_CLOSED, AUDIT_ENTITY_TYPES.TABLE_SESSION)
  closeSession(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: SafeUser,
  ): Promise<PublicTableSession> {
    return this.tableSessionService.close(id, user);
  }

  @Get(':id/qr')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  getQr(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: SafeUser,
  ): Promise<TableQrResult> {
    return this.tableService.getQr(id, user);
  }

  @Post(':id/qr/rotate')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  rotateQr(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: SafeUser,
  ): Promise<TableQrResult> {
    return this.tableService.rotateQr(id, user);
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
    const { businessId } = await this.tableService.remove(id, user);
    void this.auditService.record({
      businessId,
      userId: user.id,
      userEmail: user.email,
      action: AUDIT_ACTIONS.TABLE_DELETED,
      entityType: AUDIT_ENTITY_TYPES.TABLE,
      entityId: id,
      metadata: {},
      ...extractClientInfo(req),
    });
  }
}
