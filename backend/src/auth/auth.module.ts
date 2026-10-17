import { Module } from '@nestjs/common';
import { JwtModule, type JwtModuleOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from '../audit/audit-log.entity.js';
import { AuditService } from '../audit/audit.service.js';
import { Business } from '../business/business.entity.js';
import jwtConfig from '../config/jwt.config.js';
import { UserModule } from '../user/user.module.js';
import { BusinessAccessService } from './business-access.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { RolesGuard } from './guards/roles.guard.js';
import { JwtStrategy } from './strategies/jwt.strategy.js';

// Central home for auth wiring: registers PassportModule once and provides
// JwtAuthGuard/RolesGuard as shared singletons. Any module that needs to
// guard a route imports AuthModule (which re-exports PassportModule, so
// AuthModuleOptions — the piece AuthGuard() needs — resolves correctly) and
// reuses these same guard instances via @UseGuards(JwtAuthGuard, RolesGuard),
// instead of each module registering PassportModule for itself.
@Module({
  imports: [
    UserModule,
    // AuditLog + AuditService here (not an AuditModule import): AuditModule already imports AuthModule for its guards, so
    // importing it back would be circular. AuditService is stateless (it only needs the AuditLog repository).
    TypeOrmModule.forFeature([Business, AuditLog]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      inject: [jwtConfig.KEY],
      useFactory: (config: ReturnType<typeof jwtConfig>) => ({
        secret: config.secret,
        // expiresIn comes from JWT_EXPIRES_IN as a plain string (e.g. '1d');
        // jsonwebtoken's stricter template-literal type is a type-only
        // mismatch, not a runtime one, so it's cast to the option's own type.
        signOptions: {
          expiresIn: config.expiresIn,
        } as JwtModuleOptions['signOptions'],
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuditService, BusinessAccessService, JwtStrategy, JwtAuthGuard, RolesGuard],
  exports: [PassportModule, JwtAuthGuard, RolesGuard],
})
export class AuthModule {}
