import { registerAs } from '@nestjs/config';
import {
  BUSINESS_LIMIT_ENV_VARS,
  BUSINESS_LIMIT_MAX_CONFIGURABLE,
  BUSINESS_LIMITED_RESOURCES,
  DEFAULT_BUSINESS_LIMITS,
  type BusinessLimitedResource,
} from '../common/limits/resource-limits.const.js';

export interface ResourceLimitsConfig {
  business: Record<BusinessLimitedResource, number>;
}

// Unset/blank -> the default. Anything else must be a plain positive integer
// within bounds, otherwise the app refuses to start: silently falling back
// (or accepting "0"/"abc"/"1e9") would turn a typo into either a lockout or
// an effectively missing ceiling.
export function parseLimit(envVar: string, raw: string | undefined, defaultValue: number): number {
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const trimmed = raw.trim();
  const value = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  if (!Number.isSafeInteger(value) || value < 1 || value > BUSINESS_LIMIT_MAX_CONFIGURABLE) {
    throw new Error(
      `${envVar} must be an integer between 1 and ${BUSINESS_LIMIT_MAX_CONFIGURABLE} (got "${raw}")`,
    );
  }
  return value;
}

export function loadResourceLimits(env: NodeJS.ProcessEnv = process.env): ResourceLimitsConfig {
  const business = {} as Record<BusinessLimitedResource, number>;
  for (const resource of BUSINESS_LIMITED_RESOURCES) {
    const envVar = BUSINESS_LIMIT_ENV_VARS[resource];
    business[resource] = parseLimit(envVar, env[envVar], DEFAULT_BUSINESS_LIMITS[resource]);
  }
  return { business };
}

export default registerAs('resourceLimits', (): ResourceLimitsConfig => loadResourceLimits());
