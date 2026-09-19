export function formatPrice(value) {
  return `$${Math.round(value).toLocaleString('es-CL')}`
}

// "Cafes y Postres" (example: accented input gets normalized) -> "cafes-y-postres"
export function slugify(text) {
  return text
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents left behind by NFD normalization
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
