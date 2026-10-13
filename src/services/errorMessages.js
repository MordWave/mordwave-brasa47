import { ApiError } from './api'

// The numeric ceiling comes from the error body; a missing/garbled value
// falls back to wording without a number instead of printing "undefined".
// e.g. "500 productos" / "productos permitidos".
function limitedCount(limit, noun, adjective) {
  const n = Number(limit)
  return Number.isFinite(n) && n > 0 ? `${n} ${noun}` : `${noun} ${adjective}`
}

// Messages keyed by the backend's structured errorCode — takes priority over
// the generic per-status fallback below, since these can use real data from
// the error body (count, productName) instead of a generic sentence. Each
// handler receives the full ApiError so it can pick whatever field it needs.
const MESSAGES_BY_CODE = {
  CATEGORY_HAS_ACTIVE_PRODUCTS: (error) => {
    const n = Number(error.count) || 0
    const noun = n === 1 ? 'producto activo' : 'productos activos'
    const verb = n === 1 ? 'Desactívalo o muévelo' : 'Desactívalos o muévelos'
    return `No puedes desactivar esta categoría porque todavía tiene ${n} ${noun}. ${verb} primero.`
  },
  CATEGORY_HAS_PRODUCTS: (error) => {
    const n = Number(error.count) || 0
    const noun = n === 1 ? 'producto' : 'productos'
    const verb = n === 1 ? 'Elimínalo o muévelo' : 'Elimínalos o muévelos'
    return `No puedes eliminar esta categoría porque todavía tiene ${n} ${noun}. ${verb} primero.`
  },
  BUSINESS_PRODUCT_LIMIT_REACHED: (error) =>
    `Alcanzaste el máximo de ${limitedCount(error.limit, 'productos', 'permitidos')} de tu negocio. Elimina alguno que ya no uses para poder crear uno nuevo.`,
  BUSINESS_CATEGORY_LIMIT_REACHED: (error) =>
    `Alcanzaste el máximo de ${limitedCount(error.limit, 'categorías', 'permitidas')} de tu negocio. Elimina alguna que ya no uses para poder crear una nueva.`,
  BUSINESS_TABLE_LIMIT_REACHED: (error) =>
    `Alcanzaste el máximo de ${limitedCount(error.limit, 'mesas', 'permitidas')} de tu negocio. Elimina alguna que ya no uses para poder crear una nueva.`,
  BUSINESS_USER_LIMIT_REACHED: (error) =>
    `Alcanzaste el máximo de ${limitedCount(error.limit, 'usuarios', 'permitidos')} de tu negocio.`,
  // 429 from the backend's rate limiter (any route). Deliberately generic:
  // the response says nothing about which limit was hit.
  RATE_LIMITED: () => 'Demasiadas solicitudes. Espera un momento e inténtalo nuevamente.',
  PAYLOAD_TOO_LARGE: () => 'El contenido enviado es demasiado grande.',
  REQUEST_TIMEOUT: () => 'La solicitud tardó demasiado. Inténtalo nuevamente.',
  TEMPORARILY_UNAVAILABLE: () =>
    'El servicio no está disponible temporalmente. Inténtalo nuevamente en unos instantes.',
  IMAGE_TOO_LARGE: () => 'La imagen es demasiado pesada. El tamaño máximo permitido es 10 MB.',
  IMAGE_INVALID_FORMAT: () =>
    'El archivo no es una imagen válida. Usa JPEG, PNG o WebP.',
  IMAGE_PROCESSING_FAILED: () =>
    'No se pudo procesar esta imagen. Intenta con otra foto.',
  IMAGE_UPLOAD_FAILED: () => 'No se pudo subir la imagen. Intenta nuevamente.',
  BUSINESS_NOT_FOUND: () => 'No pudimos cargar el menú. Intenta nuevamente más tarde.',
  PRODUCT_UNAVAILABLE: (error) =>
    error.productName
      ? `${error.productName} ya no está disponible.`
      : 'Uno de los productos de tu pedido ya no está disponible. Revisa tu carrito e intenta nuevamente.',
  PRODUCT_NOT_FOUND: (error) =>
    error.productName
      ? `${error.productName} ya no existe en el menú.`
      : 'Uno de los productos de tu pedido ya no existe en el menú. Revisa tu carrito e intenta nuevamente.',
  TABLE_HAS_OPEN_SESSION: () => 'Cierra la sesión de esta mesa antes de desactivarla.',
  TABLE_SESSION_ALREADY_OPEN: () => 'Esta mesa ya tiene una sesión activa.',
  TABLE_INACTIVE: () => 'No puedes abrir una sesión en una mesa inactiva.',
  TABLE_SESSION_NOT_OPEN: () => 'Esta mesa no tiene una sesión activa para cerrar.',
  // Customer-facing — covers an invalid QR, an inactive/deleted table, and
  // a closed session identically (the backend deliberately never reveals
  // which one applies). CustomerApp treats this specially when it comes
  // back from POST /orders mid-session (table closed between two polls),
  // not just as a generic form error — see its own handling.
  TABLE_SESSION_UNAVAILABLE: () =>
    'Esta mesa no tiene una sesión activa. Solicita al personal que habilite la mesa.',
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
    return MESSAGES_BY_CODE[error.code](error)
  }

  return MESSAGES_BY_STATUS[error.status] ?? 'No se pudo completar la acción. Intenta nuevamente.'
}
