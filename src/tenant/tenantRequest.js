// Helpers to build multi-tenant requests from the resolved active business. Pure functions (no fetch, no auth).
//
// Behaviour by role, so an ADMIN's requests stay BYTE-IDENTICAL to what they were before this module existed:
//   reads    ADMIN: path unchanged (the backend scopes by the JWT)   SUPER_ADMIN: ?businessId=<active>
//   creates  both: body gets businessId (an ADMIN's own, as before; a SUPER_ADMIN's active business)
//   updates / per-id endpoints: do NOT use these helpers (the backend derives the tenant from the record, and a
//            SUPER_ADMIN could otherwise move a product between businesses by sending businessId in an update)
// With a SUPER_ADMIN and no selection every helper throws instead of sending an unscoped, cross-tenant request.

export class NoActiveBusinessError extends Error {
  constructor() {
    super('Selecciona un negocio para continuar.')
    this.name = 'NoActiveBusinessError'
  }
}

export function appendQuery(path, params) {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
  if (entries.length === 0) return path
  const qs = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
  return `${path}${path.includes('?') ? '&' : '?'}${qs}`
}

// Admin list/read endpoints that accept ?businessId= (only effective for a SUPER_ADMIN on the backend).
export function scopePath(path, tenant) {
  if (!tenant.isBusinessSelectable) return path
  if (tenant.businessId === null) throw new NoActiveBusinessError()
  return appendQuery(path, { businessId: tenant.businessId })
}

// Create endpoints whose DTO requires businessId in the body.
export function scopeBody(payload, tenant) {
  if (tenant.businessId === null) throw new NoActiveBusinessError()
  return { ...payload, businessId: tenant.businessId }
}
