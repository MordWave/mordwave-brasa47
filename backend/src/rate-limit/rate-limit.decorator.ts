import { SetMetadata } from '@nestjs/common';
import type { RateLimitPolicyName } from './rate-limit.config.js';

export const RATE_LIMIT_POLICY_KEY = 'rateLimit:policy';
export const RATE_LIMIT_SKIP_KEY = 'rateLimit:skip';

// Opts a route into one of the named policies in rate-limit.config.ts (on
// top of the global per-IP / per-user ceilings that apply everywhere).
export const RateLimit = (policy: RateLimitPolicyName) =>
  SetMetadata(RATE_LIMIT_POLICY_KEY, policy);

// Exempts a route from every rate limit (only /health, so platform health
// checks can never be starved by abuse counters).
export const SkipRateLimit = () => SetMetadata(RATE_LIMIT_SKIP_KEY, true);
