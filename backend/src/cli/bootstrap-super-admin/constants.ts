// bcrypt cost of every password hash in this project: the seed and the login's timing-equalising dummy hash use 12 too
// (a test keeps the three in sync). The bootstrap CLI hashes with exactly this cost.
export const BCRYPT_COST = 12;

// bcrypt only looks at the first 72 BYTES of a password; a longer one would be silently truncated, so it is refused.
export const PASSWORD_MAX_BYTES = 72;
export const PASSWORD_MIN_LENGTH = 12;

// The only role this tool can create.
export const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';
