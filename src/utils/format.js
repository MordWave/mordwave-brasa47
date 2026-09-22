export function formatPrice(value) {
  return `$${Math.round(value).toLocaleString('es-CL')}`
}

// order.items[].added entries are {name, price} snapshots from the backend
// (Fase 7 Bloque 2). A plain string is only possible for data created
// before that migration ran against Supabase — handled here so the kitchen
// view never shows "[object Object]" during that window, without a
// permanent legacy layer.
export function formatAddOn(addOn) {
  if (typeof addOn === 'string') return `+ ${addOn}`
  const price = addOn?.price
  return `+ ${addOn?.name ?? ''}${price ? ` (${formatPrice(price)})` : ''}`
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
