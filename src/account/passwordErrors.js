import { SUSPENDED_MESSAGE } from '../context/suspension.js'

// What the user reads when POST /auth/change-password fails. Maps the exact status / errorCode the published backend
// answers with (8D.2d-2b) to a Spanish sentence; never shows the raw (English, technical) backend message.
//   describePasswordError(error) -> { kind, message, field? }   `field` ties the message to one input of the form.
// A wrong CURRENT password is a 403 CURRENT_PASSWORD_INCORRECT (never a 401), so the session is NOT closed by it.
export function describePasswordError(error) {
  const status = error?.status
  const code = error?.code
  if (typeof status !== 'number') {
    return { kind: 'network', message: 'No pudimos conectar con el servidor. Revisa tu conexión e intenta nuevamente.' }
  }
  if (status === 403 && code === 'CURRENT_PASSWORD_INCORRECT') {
    return { kind: 'current-password', field: 'currentPassword', message: 'La contraseña actual no es correcta.' }
  }
  if (status === 400 && code === 'PASSWORD_UNCHANGED') {
    return { kind: 'unchanged', field: 'newPassword', message: 'La nueva contraseña debe ser distinta de la actual.' }
  }
  if (status === 400 && code === 'PASSWORD_TOO_SHORT') return { kind: 'policy', field: 'newPassword', message: 'La nueva contraseña debe tener al menos 12 caracteres.' }
  if (status === 400 && code === 'PASSWORD_TOO_LONG') return { kind: 'policy', field: 'newPassword', message: 'La nueva contraseña es demasiado larga (máximo 72 bytes).' }
  if (status === 400 && code === 'PASSWORD_EQUALS_EMAIL') return { kind: 'policy', field: 'newPassword', message: 'La nueva contraseña no puede ser igual a tu correo electrónico.' }
  if (status === 400 && code === 'PASSWORD_REQUIRED') return { kind: 'policy', field: 'newPassword', message: 'Escribe una nueva contraseña.' }
  if (status === 400) return { kind: 'invalid', message: 'Revisa los datos del formulario e intenta nuevamente.' }
  if (status === 409 && code === 'CREDENTIALS_CHANGED') {
    return { kind: 'conflict', message: 'Otro cambio de contraseña ocurrió al mismo tiempo en tu cuenta. Inicia sesión nuevamente con la contraseña más reciente.' }
  }
  if (status === 429) return { kind: 'rate-limited', message: 'Hiciste demasiados intentos. Espera un minuto e inténtalo nuevamente.' }
  if (status === 401) return { kind: 'unauthorized', message: 'Tu sesión expiró. Inicia sesión nuevamente.' }
  if (status === 403 && code === 'BUSINESS_INACTIVE') return { kind: 'suspended', message: SUSPENDED_MESSAGE }
  if (status === 403) return { kind: 'forbidden', message: 'Tu cuenta no tiene permiso para realizar esta acción.' }
  return { kind: 'server', message: 'No se pudo cambiar la contraseña. Intenta nuevamente.' }
}
