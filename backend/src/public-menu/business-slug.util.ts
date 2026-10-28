import { BUSINESS_SLUG_MAX_LENGTH, BUSINESS_SLUG_MIN_LENGTH, BUSINESS_SLUG_PATTERN } from '../business/dto/create-business.dto.js';

// Whether a value can be a business slug at all. Anything else must never reach the database.
export function isBusinessSlug(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= BUSINESS_SLUG_MIN_LENGTH &&
    value.length <= BUSINESS_SLUG_MAX_LENGTH &&
    BUSINESS_SLUG_PATTERN.test(value)
  );
}
