import { ApiError } from './api'

// Messages keyed by the backend's structured errorCode — takes priority over
// the generic per-status fallback below, since these can use real data
// (count) instead of a generic sentence.
const MESSAGES_BY_CODE = {
  CATEGORY_HAS_ACTIVE_PRODUCTS: (count) => {
    const n = Number(count) || 0
    const noun = n === 1 ? 'producto activo' : 'productos activos'
    const verb = n === 1 ? 'Desactívalo o muévelo' : 'Desactívalos o muévelos'
    return `No puedes desactivar esta categoría porque todavía tiene ${n} ${noun}. ${verb} primero.`
  },
  CATEGORY_HAS_PRODUCTS: (count) => {
    const n = Number(count) || 0
    const noun = n === 1 ? 'producto' : 'productos'
    const verb = n === 1 ? 'Elimínalo o muévelo' : 'Elimínalos o muévelos'
    return `No puedes eliminar esta categoría porque todavía tiene ${n} ${noun}. ${verb} primero.`
  },
}

const MESSAGES_BY_STATUS = {
  400: 'Revisa los datos del formulario e intenta nuevamente.',
  401: 'Email o contraseña incorrectos.',
  403: 'No tienes permisos para realizar esta acción.',
  404: 'No se encontró el registro solicitado.',
  409: 'No se pudo completar la acción porque hay datos relacionados. Revisa e intenta nuevamente.',
  429: 'Hiciste demasiados intentos. Espera un momento y vuelve a intentarlo.',
}

// Never shows the backend's raw `message` (technical, in English, and
// sometimes carrying internal ids) — always maps to a Spanish sentence a
// non-technical admin can act on. The raw message stays on the ApiError
// itself (error.message) for console/debug purposes only.
export function translateApiError(error) {
  if (!(error instanceof ApiError)) {
    return 'Ocurrió un error inesperado. Intenta nuevamente.'
  }

  if (error.code && MESSAGES_BY_CODE[error.code]) {
    return MESSAGES_BY_CODE[error.code](error.count ?? 0)
  }

  return MESSAGES_BY_STATUS[error.status] ?? 'No se pudo completar la acción. Intenta nuevamente.'
}
