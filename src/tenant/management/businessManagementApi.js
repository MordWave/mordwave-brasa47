import { apiFetch } from '../../services/api'
import { normalizeBusinessId } from '../tenantCore.js'

// The four SUPER_ADMIN management endpoints (8D.2c-2b). They are addressed BY UUID in the path, so they work on any
// business — including a suspended one that cannot be selected as the active business — and are deliberately NOT built
// with the tenant helpers (scopePath / scopeBody): the target is the id, never the active-business context, and no
// ?businessId= is ever sent. An id that is not a UUID is refused before any request.
function businessPath(id, suffix = '') {
  const clean = normalizeBusinessId(id)
  if (clean === null) throw new TypeError('Identificador de negocio inválido')
  return `/businesses/${clean}${suffix}`
}

export function createBusinessManagementApi({ getToken }) {
  const call = (path, options = {}) => apiFetch(path, { token: getToken(), ...options })
  return {
    fetchBusiness: (id) => call(businessPath(id)),
    updateBusiness: (id, patch) => call(businessPath(id), { method: 'PATCH', body: JSON.stringify(patch) }),
    deactivateBusiness: (id, reason) => call(businessPath(id, '/deactivate'), { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) }),
    activateBusiness: (id) => call(businessPath(id, '/activate'), { method: 'POST', body: JSON.stringify({}) }),
  }
}
