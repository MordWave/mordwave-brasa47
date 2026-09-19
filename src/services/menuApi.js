import { apiFetch } from './api'

const BUSINESS_SLUG = import.meta.env.VITE_BUSINESS_SLUG ?? 'brasa-47'

// Public menu reads — no token, always scoped to this deployment's business
// via businessSlug (see backend PublicBusinessResolverService).
export function fetchPublicCategories() {
  return apiFetch(`/categories?businessSlug=${encodeURIComponent(BUSINESS_SLUG)}`)
}

export function fetchPublicProducts() {
  return apiFetch(`/products?businessSlug=${encodeURIComponent(BUSINESS_SLUG)}`)
}
