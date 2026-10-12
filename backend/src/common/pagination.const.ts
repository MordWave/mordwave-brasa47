// Single source of truth for pagination ceilings. These are plain literals
// (not DI-injected config) on purpose: class-validator's @Max()/@Min()
// decorators are evaluated when a DTO class is defined, long before Nest's
// container exists, so they can only consume compile-time constants.
export const PAGINATION_DEFAULT_PAGE = 1;
export const PAGINATION_DEFAULT_LIMIT = 20;
export const PAGINATION_MAX_LIMIT = 100;

// Live admin boards (e.g. the NEW order queue) are a capped snapshot rather
// than a paginated list — their default is deliberately larger than a
// regular page, but they share the same hard ceiling.
export const LIVE_QUEUE_DEFAULT_LIMIT = 50;
