import { apiFetch } from '../../services/api'
import { appendQuery } from '../tenantRequest.js'
import { BUSINESS_PAGE_SIZE } from './businessListStore.js'

// GET /businesses: the SUPER_ADMIN-only GLOBAL listing (every tenant). It is deliberately NOT built with the tenant
// helpers (scopePath): it lists the businesses themselves and the backend rejects ?businessId= on it. Only the
// selector gate (mounted for a real SUPER_ADMIN) ever calls it; an ADMIN's session never reaches this code.
//   active: 'all' (no filter) | 'true' | 'false'
export function fetchBusinessPage({ token, page, limit = BUSINESS_PAGE_SIZE, search = '', active = 'all' }) {
  const params = { page, limit, search }
  if (active === 'true' || active === 'false') params.active = active
  return apiFetch(appendQuery('/businesses', params), { token })
}
