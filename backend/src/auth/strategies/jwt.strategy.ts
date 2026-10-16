import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import jwtConfig from '../../config/jwt.config.js';
import { UserService } from '../../user/user.service.js';
import { BusinessAccessService } from '../business-access.service.js';
import { readTokenCredentialsVersion } from '../credentials-version.js';
import type { JwtPayload } from '../interfaces/jwt-payload.interface.js';
import { toSafeUser, type SafeUser } from '../safe-user.js';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    @Inject(jwtConfig.KEY)
    config: ReturnType<typeof jwtConfig>,
    private readonly userService: UserService,
    private readonly businessAccess: BusinessAccessService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.secret,
    });
  }

  // Re-checks the DB on every request instead of trusting the payload
  // alone, so a deactivated/deleted user is rejected immediately even if
  // their token hasn't expired yet. The same goes for a suspended business: an ADMIN of a business with
  // active = false gets 403 BUSINESS_INACTIVE on every authenticated route, whatever the age of their token (the
  // JWT claims are neither read for this nor changed). SUPER_ADMIN is exempt — see BusinessAccessService.
  //
  // The credentials version works the same way: the token's `cv` (absent = 0, malformed = refused) must equal the
  // user's current credentials_version, so a password change revokes every token issued before it. The comparison is
  // done BEFORE the business check so a revoked token never learns anything about the business's state.
  async validate(payload: JwtPayload): Promise<SafeUser> {
    const tokenVersion = readTokenCredentialsVersion(payload.cv);
    if (tokenVersion === null) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const user = await this.userService.findById(payload.sub);
    if (!user || !user.active || user.credentialsVersion !== tokenVersion) {
      throw new UnauthorizedException('Invalid credentials');
    }
    await this.businessAccess.assertBusinessActive(user);
    return toSafeUser(user);
  }
}
