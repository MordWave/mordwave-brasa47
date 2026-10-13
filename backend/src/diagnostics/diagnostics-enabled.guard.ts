import { Inject, Injectable, NotFoundException, type CanActivate } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import securityConfig from '../config/security.config.js';

// Must run BEFORE the auth guards: while ENABLE_IP_DIAGNOSTICS is off the
// route has to look like it doesn't exist (404) to everyone — including an
// unauthenticated caller, who must not even learn that it's gated by auth.
@Injectable()
export class DiagnosticsEnabledGuard implements CanActivate {
  constructor(
    @Inject(securityConfig.KEY)
    private readonly security: ConfigType<typeof securityConfig>,
  ) {}

  canActivate(): boolean {
    if (!this.security.ipDiagnosticsEnabled) {
      throw new NotFoundException();
    }
    return true;
  }
}
