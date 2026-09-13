export function formatPrice(value) {
  return `$${Math.round(value).toLocaleString('es-CL')}`
}
