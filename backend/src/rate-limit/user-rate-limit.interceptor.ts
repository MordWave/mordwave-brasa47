import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Observable } from 'rxjs';
import {
  RATE_LIMIT_CONFIG,
  type RateLimitConfig,
  type RateLimitPolicyName,
} from './rate-limit.config.js';
import { RATE_LIMIT_POLICY_KEY, RATE_LIMIT_SKIP_KEY } from './rate-limit.decorator.js';
import { routeKey } from './rate-limit.guard.js';
import { RateLimitService, type RateLimitCheck } from './rate-limit.service.js';
import { userTracker } from './rate-limit.trackers.js';

// Per-user counters (the authenticated-user ceiling and per-route user
// buckets such as uploads).
//
// Why an interceptor and not another guard: Nest runs ALL global guards
// before ANY route-level guard, so a global guard can never see the user
// that JwtAuthGuard (declared per route) resolves. Global interceptors run
// after every guard has passed, so req.user is — by construction — the
// user Passport verified from a signed, unexpired JWT. Nothing here decodes
// a token itself: with no req.user (public routes, rejected requests) the
// per-user ceiling simply doesn't apply, and the global per-IP ceiling
// still does.
//
// Also runs before the route's own interceptors, i.e. before multer
// buffers an upload, so a user over their upload limit is rejected
// without the file being read.
@Injectable()
export class UserRateLimitInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimit: RateLimitService,
    @Inject(RATE_LIMIT_CONFIG) private readonly config: RateLimitConfig,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();

    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(RATE_LIMIT_SKIP_KEY, targets)) {
      return next.handle();
    }

    const req = context.switchToHttp().getRequest<Request & { user?: { id?: unknown } }>();
    const policyName = this.reflector.getAllAndOverride<RateLimitPolicyName | undefined>(
      RATE_LIMIT_POLICY_KEY,
      targets,
    );
    const policy = policyName ? this.config.policies[policyName] : undefined;
    const authenticated = typeof req.user?.id === 'string';

    const checks: RateLimitCheck[] = [];
    if (authenticated) {
      checks.push({
        bucketId: 'authenticated:user',
        tracker: userTracker(req),
        bucket: this.config.authenticatedUser,
      });
    }
    if (policy?.user) {
      checks.push({
        bucketId: `${policyName}:${routeKey(context)}:user`,
        tracker: userTracker(req),
        bucket: policy.user,
      });
    }

    await this.rateLimit.enforce(context, checks);
    return next.handle();
  }
}
