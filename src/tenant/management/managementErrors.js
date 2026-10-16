// What the SUPER_ADMIN sees when a management call fails. Maps the exact status / errorCode the published backend
// answers with (8D.2c-2b) to a Spanish sentence; never shows the raw (English, technical) backend message.
//   describeManagementError(error) -> { kind, message, count? }
// kind: 'pending-orders' | 'not-found' | 'unauthorized' | 'forbidden' | 'invalid' | 'network' | 'server'
export const PENDING_ORDERS_CODE = 'BUSINESS_HAS_PENDING_ORDERS'

function pendingPhrase(count) {
  return count === 1 ? '1 pedido pendiente' : `${count} pedidos pendientes`
}

export function describeManagementError(error) {
  const status = error?.status
  const code = error?.code
  if (typeof status !== 'number') {
    return { kind: 'network', message: 'No pudimos conectar con el servidor. Revisa tu conexión e intenta nuevamente.' }
  }
  if (status === 409 && code === PENDING_ORDERS_CODE) {
    const count = Number.isInteger(error.count) && error.count > 0 ? error.count : null
    const lead = count === null ? 'Este restaurante tiene pedidos pendientes' : `Este restaurante tiene ${pendingPhrase(count)}`
    return {
      kind: 'pending-orders',
      count,
      message: `${lead}. Resuélvelos (entrégalos o cancélalos) antes de suspenderlo.`,
    }
  }
  if (status === 404) return { kind: 'not-found', message: 'Este restaurante ya no existe. Actualiza la lista.' }
  if (status === 401) return { kind: 'unauthorized', message: 'Tu sesión expiró. Inicia sesión nuevamente.' }
  if (status === 403) return { kind: 'forbidden', message: 'Tu cuenta no tiene permiso para realizar esta acción.' }
  if (status === 400) return { kind: 'invalid', message: 'Revisa los datos del formulario e intenta nuevamente.' }
  return { kind: 'server', message: 'No se pudo completar la acción. Intenta nuevamente.' }
}
