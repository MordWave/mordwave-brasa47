import { createHash } from 'node:crypto';
import { Inject, Injectable, type ExecutionContext } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Response } from 'express';
import { RATE_LIMIT_STORAGE, type RateLimitBucket } from './rate-limit.config.js';
import { RateLimitedException } from './rate-limited.exception.js';

export interface RateLimitCheck {
  // Stable name of the counter (e.g. "ordersCreate:OrderController.create:ip").
  // Part of the storage key only — never sent to the client.
  bucketId: string;
  // Who the counter belongs to (from rate-limit.trackers.ts).
  tracker: string;
  bucket: RateLimitBucket;
}

// Thin wrapper over @nestjs/throttler's storage. ThrottlerGuard isn't used:
// it evaluates every named throttler on every route, and here some counters
// must run before authentication (IP / session) and others after it (user).
// The storage is injected behind RATE_LIMIT_STORAGE so a shared store
// (Redis / ElastiCache) can replace the in-memory one without touching the
// guard or the interceptor.
//
// In-memory storage means: counters reset on every redeploy/restart, and
// with N replicas each keeps its own counters, so the effective limit is up
// to N× the configured one.
@Injectable()
export class RateLimitService {
  constructor(@Inject(RATE_LIMIT_STORAGE) private readonly storage: ThrottlerStorage) {}

  // Counts one hit against each check, in order, and throws RateLimitedException
  // (setting Retry-After) at the first exhausted one. Order matters: callers
  // list the cheapest-to-flood-protection first (IP), so a blocked IP never
  // creates the per-session counters an attacker could spray with random tokens.
  async enforce(context: ExecutionContext, checks: RateLimitCheck[]): Promise<void> {
    for (const { bucketId, tracker, bucket } of checks) {
      // Hashed so raw session tokens / user ids never sit in the in-memory map.
      const key = createHash('sha256').update(`${bucketId}|${tracker}`).digest('hex');
      const record = await this.storage.increment(
        key,
        bucket.ttlMs,
        bucket.limit,
        bucket.ttlMs,
        bucketId,
      );
      if (record.isBlocked) {
        const res = context.switchToHttp().getResponse<Response>();
        res.header('Retry-After', String(Math.max(1, record.timeToBlockExpire)));
        throw new RateLimitedException();
      }
    }
  }
}
