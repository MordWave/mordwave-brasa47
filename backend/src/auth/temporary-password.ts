import { randomInt } from 'node:crypto';
import { checkNewPassword } from './password-policy.js';

// Temporary passwords for ADMIN accounts created or reset by a SUPER_ADMIN. Generated with Node's CSPRNG (crypto.randomInt,
// which is unbiased — no modulo bias), 20 characters from a 56-symbol alphabet without look-alikes (no 0/O/o, 1/l/I):
// ~116 bits of entropy, shown as four dash-separated groups of five for easy dictation. 23 characters, 23 bytes: inside the
// password policy (12 characters, 72 bytes). It is only ever handed to the SUPER_ADMIN in one HTTP response; what is stored
// is its bcrypt hash, and the user must replace it (must_change_password).
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const GROUPS = 4;
const GROUP_LENGTH = 5;

export function generateTemporaryPassword(): string {
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g += 1) {
    let group = '';
    for (let i = 0; i < GROUP_LENGTH; i += 1) group += ALPHABET[randomInt(ALPHABET.length)];
    groups.push(group);
  }
  const password = groups.join('-');
  // Defence in depth: whatever is generated must satisfy the policy a user's own password must satisfy.
  if (checkNewPassword(password, '') !== null) throw new Error('Generated temporary password violates the password policy');
  return password;
}

export const TEMPORARY_PASSWORD_ALPHABET = ALPHABET;
