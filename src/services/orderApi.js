import { apiFetch } from './api'

const BUSINESS_SLUG = import.meta.env.VITE_BUSINESS_SLUG ?? 'brasa-47'

// Public order creation — no token, always scoped to this deployment's
// business via businessSlug (see backend PublicBusinessResolverService).
// clientRequestId makes retries of the same checkout attempt idempotent —
// see its lifecycle in CustomerApp.jsx.
export function createOrder({ clientRequestId, table, note, items }) {
  return apiFetch('/orders', {
    method: 'POST',
    body: JSON.stringify({ businessSlug: BUSINESS_SLUG, clientRequestId, table, note, items }),
  })
}
