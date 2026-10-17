import { type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { ALLOW_PASSWORD_CHANGE_REQUIRED_KEY } from '../decorators/allow-password-change-required.decorator.js';
import type { SafeUser } from '../safe-user.js';

export const PASSWORD_CHANGE_REQUIRED_ERROR_CODE = 'PASSWORD_CHANGE_REQUIRED';

// The single place where authenticated requests are accepted (every protected route uses it; a test enumerates them).
// After Passport has authenticated the request — JwtStrategy.validate has loaded the user FROM THE DATABASE and applied
// the active-user, credentials-version and business checks — it enforces the forced password change:
//
//   a user whose must_change_password is not exactly false may only reach handlers marked with
//   @AllowPasswordChangeRequired(); every other route answers 403 PASSWORD_CHANGE_REQUIRED.
//
// Deny by default and fail closed: the flag is read from the user's row (never from the JWT, the body or the query),
// and anything other than a real `false` is treated as "must change". The exceptions come from route METADATA, not from
// comparing paths, so letter case, trailing slashes or future routes cannot slip through. It runs before RolesGuard,
// so no role (SUPER_ADMIN included) bypasses it.
//
// Precedence when several things apply to the same request: authentication problems first (401, or 403
// BUSINESS_INACTIVE for an ADMIN of a suspended business — both raised while authenticating), then
// PASSWORD_CHANGE_REQUIRED, then the route's own role check.
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    const authenticated = (await super.canActivate(context)) as boolean;
    if (!authenticated) return false;

    const allowed = this.reflector.get<boolean | undefined>(ALLOW_PASSWORD_CHANGE_REQUIRED_KEY, context.getHandler()) === true;
    if (allowed) return true;

    const { user } = context.switchToHttp().getRequest<{ user?: SafeUser }>();
    if (user?.mustChangePassword !== false) {
      throw new ForbiddenException({
        message: 'You must change your password before using this resource',
        errorCode: PASSWORD_CHANGE_REQUIRED_ERROR_CODE,
      });
    }
    return true;
  }
}
