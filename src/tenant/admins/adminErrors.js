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

// What the SUPER_ADMIN sees when the DELETION of an administrator fails (POST .../admins/:userId/delete, 9D.1). The backend
// answers with a specific status / errorCode per reason; each gets its own Spanish sentence. Besides kind and message, every
// answer says how the dialog must behave (`outcome`):
//   'retry'     nothing was deleted and trying again can work (wrong confirmation, a concurrent change, rate limit)
//   'refused'   nothing was deleted and trying again with the same account cannot work (the reason is final for now)
//   'ambiguous' the outcome is UNKNOWN (network failure, 5xx, unreadable answer): never claim it was deleted, never retry by
//               itself; the person re-reads the list to find out
//   describeRemovalError(error) -> { kind, outcome, message, refresh }   (refresh: the list on screen may be stale)
export function describeRemovalError(error) {
  const status = error?.status
  const code = error?.code
  const refused = (kind, message, refresh = true) => ({ kind, outcome: 'refused', message, refresh })
  if (typeof status !== 'number') {
    return {
      kind: 'network',
      outcome: 'ambiguous',
      refresh: false,
      message: 'No pudimos confirmar si la cuenta se eliminó: se perdió la conexión con el servidor. No la damos por eliminada. Actualiza la lista para comprobar el estado.',
    }
  }
  if (status === 400 && code === 'CONFIRMATION_MISMATCH') {
    return { kind: 'confirmation-mismatch', outcome: 'retry', refresh: false, message: 'El correo escrito no coincide con el del administrador. No se eliminó nada.' }
  }
  if (status === 400) return { kind: 'invalid', outcome: 'retry', refresh: false, message: 'Revisa el correo de confirmación e intenta nuevamente. No se eliminó nada.' }
  if (status === 401) return refused('unauthorized', 'Tu sesión expiró. Inicia sesión nuevamente. No se eliminó nada.', false)
  if (status === 403 && code === 'PASSWORD_CHANGE_REQUIRED') return refused('password-change-required', 'Debes cambiar tu contraseña antes de continuar. No se eliminó nada.', false)
  if (status === 403 && code === 'ROLE_NOT_ALLOWED') {
    return refused('role-not-allowed', 'Esta cuenta no es un administrador de restaurante y no se puede eliminar desde aquí.')
  }
  if (status === 403) return refused('forbidden', 'Tu cuenta no tiene permiso para eliminar administradores. No se eliminó nada.', false)
  if (status === 404 && code === 'ADMIN_NOT_FOUND') return refused('admin-not-found', 'Este administrador ya no existe en este restaurante. Se actualizó la lista.')
  if (status === 404) return refused('business-not-found', 'Este restaurante ya no existe.', false)
  if (status === 409 && code === 'ADMIN_STILL_ACTIVE') {
    return refused('still-active', 'Esta cuenta sigue activa. Para poder eliminarla, primero desactívala. No se eliminó nada.')
  }
  if (status === 409 && code === 'LAST_ACTIVE_ADMIN') {
    return refused('last-admin', 'Es el último administrador activo de este restaurante, así que no se puede eliminar. Crea o reactiva a otro administrador primero. No se eliminó nada.')
  }
  if (status === 409 && code === 'ADMIN_PASSWORD_ALREADY_CHANGED') {
    return refused('password-changed', 'Esta persona ya cambió su contraseña inicial, así que la cuenta se considera en uso y no se puede eliminar. Si ya no debe ingresar, déjala desactivada.')
  }
  if (status === 409 && code === 'ADMIN_HAS_ACTIVITY') {
    return refused('has-activity', 'Esta cuenta tiene actividad registrada y no se puede eliminar. Si ya no debe ingresar, déjala desactivada.')
  }
  if (status === 409 && code === 'ADMIN_HISTORY_INCOMPATIBLE') {
    return refused('history-incompatible', 'El historial de esta cuenta (por ejemplo, reactivaciones o restablecimientos de contraseña) no permite eliminarla. Si ya no debe ingresar, déjala desactivada.')
  }
  if (status === 409 && code === 'ADMIN_CONCURRENT_MODIFICATION') {
    return { kind: 'concurrent', outcome: 'retry', refresh: true, message: 'Otra acción modificó esta cuenta al mismo tiempo, así que no se eliminó nada. Revisa la lista e inténtalo de nuevo.' }
  }
  if (status === 429) {
    return { kind: 'rate-limited', outcome: 'retry', refresh: false, message: 'Demasiadas solicitudes. No se eliminó nada. Espera un momento e inténtalo nuevamente.' }
  }
  if (status >= 500) {
    return {
      kind: 'server',
      outcome: 'ambiguous',
      refresh: false,
      message: 'El servidor no respondió como esperábamos, así que no podemos confirmar si la cuenta se eliminó. No la damos por eliminada. Actualiza la lista para comprobar el estado.',
    }
  }
  return refused('unknown', 'No se eliminó nada que el servidor haya confirmado. Actualiza la lista para ver el estado actual de la cuenta.')
}
