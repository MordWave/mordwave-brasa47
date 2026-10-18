// What the SUPER_ADMIN sees when creating a business fails. Maps the exact status / errorCode the published backend answers
// with to a Spanish sentence; never shows the raw (English, technical) backend message.
//   describeCreateError(error) -> { kind, message, ambiguous }
// kind: 'slug-taken' | 'invalid' | 'unauthorized' | 'forbidden' | 'rate-limited' | 'network' | 'server' | 'bad-response'
//
// A 409 on the slug is shown as "taken" but may be the echo of OUR OWN earlier request: browsers re-send a POST by
// themselves when the connection resets before any answer (observed in 9B.1), so the first copy can have created the
// business and the second one gets the 409. That is why the 409 text also points at the list, and why closing the dialog
// after it refreshes the list (see creationStore).
//
// `ambiguous` is true when the request may have reached the server and created the business even though the answer is an
// error (no HTTP answer at all, a 5xx, or a "success" whose body is not a business). The form never reports those as a
// success and never as a plain failure either: it says it cannot confirm, and the list is refreshed when it closes.
export const SLUG_TAKEN_CODE = 'BUSINESS_SLUG_TAKEN'

export function describeCreateError(error, { slugAmbiguouslyTried = false } = {}) {
  if (error?.kind === 'bad-response') {
    return {
      kind: 'bad-response',
      ambiguous: true,
      message: 'El servidor respondió algo inesperado y no podemos confirmar si el negocio se creó. Revisa la lista de negocios antes de intentarlo de nuevo.',
    }
  }
  const status = error?.status
  if (typeof status !== 'number') {
    return {
      kind: 'network',
      ambiguous: true,
      message: 'No pudimos conectar con el servidor, así que no sabemos si el negocio se creó. Revisa tu conexión y la lista de negocios antes de intentarlo de nuevo.',
    }
  }
  if (status === 409 && error.code === SLUG_TAKEN_CODE) {
    return {
      kind: 'slug-taken',
      ambiguous: false,
      message: slugAmbiguouslyTried
        ? 'Este identificador ya existe. Es posible que el intento anterior sí haya creado el negocio: búscalo en la lista antes de crear otro.'
        : 'Este identificador ya está en uso. Prueba con uno distinto. Si acabas de intentar crear este mismo negocio, búscalo en la lista antes de crear otro.',
    }
  }
  if (status === 429) return { kind: 'rate-limited', ambiguous: false, message: 'Demasiadas solicitudes. Espera un momento e inténtalo nuevamente.' }
  if (status === 401) return { kind: 'unauthorized', ambiguous: false, message: 'Tu sesión expiró. Inicia sesión nuevamente.' }
  if (status === 403) return { kind: 'forbidden', ambiguous: false, message: 'Tu cuenta no tiene permiso para crear negocios.' }
  if (status === 400) return { kind: 'invalid', ambiguous: false, message: 'El servidor rechazó algunos datos. Revisa el formulario e intenta nuevamente.' }
  if (status >= 500) {
    return {
      kind: 'server',
      ambiguous: true,
      message: 'El servidor tuvo un problema y no podemos confirmar si el negocio se creó. Revisa la lista de negocios antes de intentarlo de nuevo.',
    }
  }
  return { kind: 'server', ambiguous: false, message: 'No se pudo crear el negocio. Intenta nuevamente.' }
}
