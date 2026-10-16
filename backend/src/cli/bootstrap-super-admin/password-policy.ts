import { PASSWORD_MAX_BYTES, PASSWORD_MIN_LENGTH } from './constants.js';

// Rules for the SUPER_ADMIN password. Returns the list of problems (empty = acceptable); the messages never include the
// password itself. Length is counted in characters (code points), the ceiling in UTF-8 BYTES because bcrypt truncates at 72.
export function validateBootstrapPassword(password: string, email: string): string[] {
  const problems: string[] = [];
  if (password.trim() === '') {
    problems.push('La contraseña no puede estar vacía.');
    return problems;
  }
  // characters = Unicode code points (a deliberate choice: the bcrypt limit is checked separately, in bytes)
  if (Array.from(password).length < PASSWORD_MIN_LENGTH) {
    problems.push(`Debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`);
  }
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    problems.push(`Debe ocupar como máximo ${PASSWORD_MAX_BYTES} bytes (límite de bcrypt).`);
  }
  if (email !== '' && password.trim().toLowerCase() === email.trim().toLowerCase()) {
    problems.push('No puede ser igual al correo electrónico.');
  }
  return problems;
}
