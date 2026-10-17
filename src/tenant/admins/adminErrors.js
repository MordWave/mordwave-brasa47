// What the SUPER_ADMIN sees when a call to the admin-management endpoints fails. Maps the exact status / errorCode the
// published backend answers with (8D.2d-3) to a Spanish sentence; never shows the raw (English, technical) backend message.
//   describeAdminError(error) -> { kind, message, field? }
// kind: 'email-exists' | 'last-admin' | 'user-limit' | 'conflict' | 'admin-not-found' | 'business-not-found' | 'unauthorized'
//       | 'password-change-required' | 'forbidden' | 'rate-limited' | 'invalid' | 'network' | 'server'
export function describeAdminError(error) {
  const status = error?.status
  const code = error?.code
  if (typeof status !== 'number') {
    return { kind: 'network', message: 'No pudimos conectar con el servidor. Revisa tu conexión e intenta nuevamente.' }
  }
  if (status === 409 && code === 'EMAIL_ALREADY_EXISTS') {
    return { kind: 'email-exists', field: 'email', message: 'Ya existe una cuenta con ese correo electrónico.' }
  }
  if (status === 409 && code === 'LAST_ACTIVE_ADMIN') {
    return {
      kind: 'last-admin',
      message: 'No se puede desactivar al último administrador activo de este restaurante. Crea o reactiva a otro administrador primero.',
    }
  }
  if (status === 409 && code === 'BUSINESS_USER_LIMIT_REACHED') {
    const limit = Number(error.limit)
    const ceiling = Number.isFinite(limit) && limit > 0 ? `${limit} usuarios` : 'usuarios permitidos'
    return { kind: 'user-limit', message: `Este restaurante alcanzó el máximo de ${ceiling}. No se pueden crear más cuentas.` }
  }
  if (status === 409 && code === 'CREDENTIALS_CHANGED') {
    return {
      kind: 'conflict',
      message: 'Las credenciales de esta cuenta cambiaron mientras tanto (otra acción se completó antes). Se actualizó la lista; revisa y vuelve a intentarlo.',
    }
  }
  if (status === 404 && code === 'ADMIN_NOT_FOUND') {
    return { kind: 'admin-not-found', message: 'Este administrador ya no existe en este restaurante. Se actualizó la lista.' }
  }
  if (status === 404) return { kind: 'business-not-found', message: 'Este restaurante ya no existe.' }
  if (status === 401) return { kind: 'unauthorized', message: 'Tu sesión expiró. Inicia sesión nuevamente.' }
  if (status === 403 && code === 'PASSWORD_CHANGE_REQUIRED') {
    return { kind: 'password-change-required', message: 'Debes cambiar tu contraseña antes de continuar.' }
  }
  if (status === 403) return { kind: 'forbidden', message: 'Tu cuenta no tiene permiso para gestionar administradores.' }
  if (status === 429) return { kind: 'rate-limited', message: 'Demasiadas solicitudes. Espera un momento e inténtalo nuevamente.' }
  if (status === 400) return { kind: 'invalid', field: 'email', message: 'Revisa el correo electrónico e intenta nuevamente.' }
  return { kind: 'server', message: 'No se pudo completar la acción. Intenta nuevamente.' }
}

// Which failures mean the list on screen may no longer match the server (so it is re-read, never patched by hand).
export const STALE_LIST_KINDS = new Set(['admin-not-found', 'conflict', 'last-admin', 'user-limit', 'email-exists'])
