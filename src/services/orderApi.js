import { apiFetch } from './api'

// Public order creation — no auth token. The backend resolves business,
// table, and price entirely from sessionToken (see OrderService.create) —
// the client no longer sends businessSlug/businessId/table at all.
// clientRequestId makes retries of the same checkout attempt idempotent —
// see its lifecycle in CustomerApp.jsx.
export function createOrder({ sessionToken, clientRequestId, note, items }) {
  return apiFetch('/orders', {
    method: 'POST',
    body: JSON.stringify({ sessionToken, clientRequestId, note, items }),
  })
}
