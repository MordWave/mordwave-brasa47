import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  RATE_LIMIT_CONFIG,
  type RateLimitConfig,
  type RateLimitPolicyName,
} from './rate-limit.config.js';
import { RATE_LIMIT_POLICY_KEY, RATE_LIMIT_SKIP_KEY } from './rate-limit.decorator.js';
import { RateLimitService, type RateLimitCheck } from './rate-limit.service.js';
import { ipTracker, sessionTracker } from './rate-limit.trackers.js';

export function routeKey(context: ExecutionContext): string {
  return `${context.getClass().name}.${context.getHandler().name}`;
}

// Registered as APP_GUARD, so it runs BEFORE any route-level guard — in
// particular before JwtAuthGuard. That is why it only evaluates counters
// whose tracker exists without authentication:
//   1. the global per-IP ceiling,
//   2. the route policy's per-IP bucket,
//   3. the route policy's per-session bucket (body.sessionToken).
// Per-user counters need a verified req.user and live in
// UserRateLimitInterceptor, which runs after the auth guards.
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimit: RateLimitService,
    @Inject(RATE_LIMIT_CONFIG) private readonly config: RateLimitConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(RATE_LIMIT_SKIP_KEY, targets)) {
      return true;
    }

    const policyName = this.reflector.getAllAndOverride<RateLimitPolicyName | undefined>(
      RATE_LIMIT_POLICY_KEY,
      targets,
    );
    const policy = policyName ? this.config.policies[policyName] : undefined;
    const req = context.switchToHttp().getRequest<Request>();
    const route = routeKey(context);
    const ip = ipTracker(req);

    // IP counters first: once an IP is blocked, no per-session counter is
    // created for it, so spraying random sessionTokens from one address can't
    // grow the in-memory store.
    const checks: RateLimitCheck[] = [];
    if (!policy?.skipGlobalIp) {
      checks.push({ bucketId: 'global:ip', tracker: ip, bucket: this.config.globalIp });
    }
    if (policy?.ip) {
      checks.push({ bucketId: `${policyName}:${route}:ip`, tracker: ip, bucket: policy.ip });
    }
    if (policy?.session) {
      checks.push({
        bucketId: `${policyName}:${route}:session`,
        tracker: sessionTracker(req),
        bucket: policy.session,
      });
    }

    await this.rateLimit.enforce(context, checks);
    return true;
  }
}
