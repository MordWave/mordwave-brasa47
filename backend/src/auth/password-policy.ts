// Password rules for POST /auth/change-password. Same numbers as the SUPER_ADMIN bootstrap CLI (a test keeps them in
// sync; the CLI is a standalone tool and deliberately imports nothing from the backend).
export const PASSWORD_MIN_LENGTH = 12;
// bcrypt ignores everything after 72 BYTES, so the ceiling is in UTF-8 bytes, not characters.
export const PASSWORD_MAX_BYTES = 72;
export const PASSWORD_BCRYPT_COST = 12;

export type PasswordPolicyViolation = 'PASSWORD_REQUIRED' | 'PASSWORD_TOO_SHORT' | 'PASSWORD_TOO_LONG' | 'PASSWORD_EQUALS_EMAIL';

// First violated rule, or null when the password is acceptable. Never echoes the password. Length is counted in Unicode
// code points; whitespace is not trimmed (the exact string typed is what gets hashed).
export function checkNewPassword(password: string, email: string): PasswordPolicyViolation | null {
  if (password.trim() === '') return 'PASSWORD_REQUIRED';
  if (Array.from(password).length < PASSWORD_MIN_LENGTH) return 'PASSWORD_TOO_SHORT';
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) return 'PASSWORD_TOO_LONG';
  if (password.trim().toLowerCase() === email.trim().toLowerCase()) return 'PASSWORD_EQUALS_EMAIL';
  return null;
}

export const PASSWORD_VIOLATION_MESSAGES: Record<PasswordPolicyViolation, string> = {
  PASSWORD_REQUIRED: 'The new password must not be empty',
  PASSWORD_TOO_SHORT: `The new password must have at least ${PASSWORD_MIN_LENGTH} characters`,
  PASSWORD_TOO_LONG: `The new password must be at most ${PASSWORD_MAX_BYTES} bytes (UTF-8)`,
  PASSWORD_EQUALS_EMAIL: 'The new password must not be the email address',
};
