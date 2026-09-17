import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import jwtConfig from '../../config/jwt.config.js';
import { UserService } from '../../user/user.service.js';
import type { JwtPayload } from '../interfaces/jwt-payload.interface.js';
import { toSafeUser, type SafeUser } from '../safe-user.js';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    @Inject(jwtConfig.KEY)
    config: ReturnType<typeof jwtConfig>,
    private readonly userService: UserService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.secret,
    });
  }

  // Re-checks the DB on every request instead of trusting the payload
  // alone, so a deactivated/deleted user is rejected immediately even if
  // their token hasn't expired yet.
  async validate(payload: JwtPayload): Promise<SafeUser> {
    const user = await this.userService.findById(payload.sub);
    if (!user || !user.active) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return toSafeUser(user);
  }
}
