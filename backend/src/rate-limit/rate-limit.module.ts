import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerStorageService } from '@nestjs/throttler';
import {
  DEFAULT_RATE_LIMITS,
  RATE_LIMIT_CONFIG,
  RATE_LIMIT_STORAGE,
} from './rate-limit.config.js';
import { RateLimitGuard } from './rate-limit.guard.js';
import { RateLimitService } from './rate-limit.service.js';
import { UserRateLimitInterceptor } from './user-rate-limit.interceptor.js';

// The one place rate limiting is wired. Import it once (AppModule); every
// route is then covered by the global per-IP ceiling, and opts into extra
// counters with @RateLimit('<policy>') — see rate-limit.config.ts.
//
// Storage is in-memory (ThrottlerStorageService), per process:
//  - counters reset on every redeploy/restart;
//  - with several replicas each one counts separately, so the effective
//    limit can be up to (replicas × configured limit);
//  - a shared store (Redis / ElastiCache) is planned for the AWS phase: it
//    only needs another provider for RATE_LIMIT_STORAGE implementing
//    ThrottlerStorage.
@Module({
  providers: [
    { provide: RATE_LIMIT_CONFIG, useValue: DEFAULT_RATE_LIMITS },
    { provide: RATE_LIMIT_STORAGE, useClass: ThrottlerStorageService },
    RateLimitService,
    // Runs before every route-level guard (IP + session counters).
    { provide: APP_GUARD, useClass: RateLimitGuard },
    // Runs after every guard (per-user counters, req.user already verified).
    { provide: APP_INTERCEPTOR, useClass: UserRateLimitInterceptor },
  ],
})
export class RateLimitModule {}
