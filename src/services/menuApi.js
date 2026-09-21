import { apiFetch } from './api'

// Falls back to this only when no businessSlug is available at all (e.g.
// exercising these functions outside the real QR flow during development)
// — the real customer flow always passes the slug it got from
// POST /table-sessions/join, never this fixed default.
const DEFAULT_BUSINESS_SLUG = import.meta.env.VITE_BUSINESS_SLUG ?? 'brasa-47'

// Public menu reads — no token, scoped to whichever business the caller
// resolved (see backend PublicBusinessResolverService).
export function fetchPublicCategories(businessSlug = DEFAULT_BUSINESS_SLUG) {
  return apiFetch(`/categories?businessSlug=${encodeURIComponent(businessSlug)}`)
}

export function fetchPublicProducts(businessSlug = DEFAULT_BUSINESS_SLUG) {
  return apiFetch(`/products?businessSlug=${encodeURIComponent(businessSlug)}`)
}
