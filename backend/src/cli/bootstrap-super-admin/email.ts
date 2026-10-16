import { isEmail } from 'class-validator';

const EMAIL_MAX_LENGTH = 254;

// Same normalisation the login applies (trim + lowercase), so the stored address is exactly the one the login looks up.
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

// Returns the normalised email, or null when it is not an acceptable address (same validator as LoginDto's @IsEmail).
export function validateEmail(raw: string): string | null {
  const email = normalizeEmail(raw);
  if (email === '' || email.length > EMAIL_MAX_LENGTH || /\s/.test(email) || !isEmail(email)) return null;
  return email;
}
