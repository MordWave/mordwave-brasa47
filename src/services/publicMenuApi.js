import { apiFetch } from './api'
import { isValidBusinessSlug } from '../utils/businessSlug.js'
import { MissingBusinessSlugError } from './menuApi.js'

// GET /public/menu/:slug — the whole read-only menu of ONE restaurant in a single request: { business, categories, products }.
// No default restaurant: without a valid slug nothing is requested.
export async function fetchPublicMenu(slug) {
  if (!isValidBusinessSlug(slug)) throw new MissingBusinessSlugError()
  return apiFetch(`/public/menu/${encodeURIComponent(slug)}`)
}
