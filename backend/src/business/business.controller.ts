import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
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
@Controller('businesses')
export class BusinessController {
  constructor(private readonly businessService: BusinessService) {}

  @Get('me')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  getMe(@Query() query: BusinessQueryDto, @CurrentUser() user: SafeUser): Promise<Business> {
    return this.businessService.getMe(query, user);
  }

  @Patch('me')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  updateMe(
    @Query() query: BusinessQueryDto,
    @Body() dto: UpdateBusinessDto,
    @CurrentUser() user: SafeUser,
  ): Promise<Business> {
    return this.businessService.updateMe(query, dto, user);
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
  uploadLogo(
    @Query() query: BusinessQueryDto,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: SafeUser,
  ): Promise<Business> {
    if (!file) {
      throw new BadRequestException({
        message: 'No file uploaded',
        errorCode: 'IMAGE_INVALID_FORMAT',
      });
    }
    return this.businessService.uploadLogo(query, user, file);
  }
}
