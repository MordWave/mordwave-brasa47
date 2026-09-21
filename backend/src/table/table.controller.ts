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
  UseGuards,
} from '@nestjs/common';
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
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
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

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTableDto,
    @CurrentUser() user: SafeUser,
  ): Promise<PublicTable> {
    return this.tableService.update(id, dto, user);
  }

  @Post(':id/sessions')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  openSession(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: SafeUser,
  ): Promise<PublicTableSession> {
    return this.tableSessionService.open(id, user);
  }

  @Patch(':id/sessions/current')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
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
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: SafeUser,
  ): Promise<void> {
    return this.tableService.remove(id, user);
  }
}
