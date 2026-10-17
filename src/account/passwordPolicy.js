// Visual validation of the password-change form. It mirrors the backend policy (POST /auth/change-password) so the user
// gets feedback before sending, but it is ONLY a convenience: the backend decides, and its answer is always shown.
//   - at least 12 characters (Unicode code points, like the backend), at most 72 BYTES in UTF-8 (the bcrypt limit),
//   - not the e-mail address, different from the current password, confirmation equal to the new password.
export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_MAX_BYTES = 72

export const utf8Length = (value) => new TextEncoder().encode(value).length
const codePoints = (value) => Array.from(value).length

// -> { currentPassword?, newPassword?, confirmation? }: a message per invalid field; {} when the form can be sent.
export function validatePasswordChange({ currentPassword = '', newPassword = '', confirmation = '' } = {}, email = '') {
  const errors = {}
  if (currentPassword === '') errors.currentPassword = 'Escribe tu contraseña actual.'

  if (newPassword.trim() === '') errors.newPassword = 'Escribe una nueva contraseña.'
  else if (codePoints(newPassword) < PASSWORD_MIN_LENGTH) errors.newPassword = `Debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`
  else if (utf8Length(newPassword) > PASSWORD_MAX_BYTES) errors.newPassword = `Es demasiado larga: el máximo son ${PASSWORD_MAX_BYTES} bytes (los caracteres con tilde o emoji ocupan más de uno).`
  else if (typeof email === 'string' && email !== '' && newPassword.trim().toLowerCase() === email.trim().toLowerCase()) errors.newPassword = 'No puede ser igual a tu correo electrónico.'
  else if (currentPassword !== '' && newPassword === currentPassword) errors.newPassword = 'Debe ser distinta de tu contraseña actual.'

  if (!errors.newPassword && confirmation !== newPassword) errors.confirmation = 'La confirmación no coincide con la nueva contraseña.'
  return errors
}
