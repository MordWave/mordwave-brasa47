import { apiFetch } from '../../services/api'

// POST /businesses (SUPER_ADMIN only on the server). NOT built with the tenant helpers (scopePath / scopeBody): there is
// no business yet, so no ?businessId= and no businessId in the body. The body is exactly what buildCreatePayload produced.
export function createBusinessCreateApi({ getToken }) {
  return {
    createBusiness: (payload) => apiFetch('/businesses', { token: getToken(), method: 'POST', body: JSON.stringify(payload) }),
  }
}
