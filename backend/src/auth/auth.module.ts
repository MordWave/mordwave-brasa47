import { Module } from '@nestjs/common';
import { JwtModule, type JwtModuleOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import jwtConfig from '../config/jwt.config.js';
import { UserModule } from '../user/user.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtStrategy } from './strategies/jwt.strategy.js';

@Module({
  imports: [
    UserModule,
    PassportModule,
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
  providers: [AuthService, JwtStrategy],
})
export class AuthModule {}
