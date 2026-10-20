// The public identifier of a restaurant (it travels in menu requests). Mirrors the backend rule (create-business.dto.ts):
// 3-60 characters, lowercase letters and digits in hyphen-separated groups. The frontend never invents or defaults one: a
// value that does not pass this check means "we do not know which restaurant this is", and nothing may be requested for it.
export const BUSINESS_SLUG_MIN_LENGTH = 3
export const BUSINESS_SLUG_MAX_LENGTH = 60
const BUSINESS_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function isValidBusinessSlug(value) {
  return typeof value === 'string' && value.length >= BUSINESS_SLUG_MIN_LENGTH && value.length <= BUSINESS_SLUG_MAX_LENGTH && BUSINESS_SLUG_PATTERN.test(value)
}
