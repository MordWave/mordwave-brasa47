// Active-business resolution, framework-free. Separates WHO is authenticated from WHICH business the Admin is
// working on:
//   ADMIN        -> the business of their own session (user.businessId); nothing can change it from the frontend
//   SUPER_ADMIN  -> the business chosen explicitly, or none (never invented)
//
// THIS IS NOT AUTHORIZATION. Choosing a business here only decides what the UI asks for; the backend remains the
// absolute authority (JWT role + tenant.util.ts) and re-validates every request. Nothing here touches the JWT,
// the AuthContext user, or request headers.

export const ROLE_ADMIN = 'ADMIN'
export const ROLE_SUPER_ADMIN = 'SUPER_ADMIN'

// sessionStorage (not localStorage): survives a refresh of this tab, dies with the tab, never reaches other tabs.
export const ACTIVE_BUSINESS_STORAGE_KEY = 'brasa47-active-business'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// A business id is a UUID (what the backend's @IsUUID() accepts). Anything else is discarded.
export function normalizeBusinessId(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return UUID.test(trimmed) ? trimmed.toLowerCase() : null
}

// Only a SUPER_ADMIN can pick a business.
export const isBusinessSelectableRole = (role) => role === ROLE_SUPER_ADMIN

// Who loses the session when THEIR restaurant turns out to be suspended (403 BUSINESS_INACTIVE): every logged-in user but
// a SUPER_ADMIN — the same rule the backend applies (BusinessAccessService). A SUPER_ADMIN also receives that code for the
// one action that stays blocked even for them (opening table sessions of a suspended restaurant); that must remain an
// ordinary error message and never end their session. Takes the stored user, so no component reads a role itself.
export const suspensionEndsSession = (user) => Boolean(user) && user.role !== ROLE_SUPER_ADMIN

// The single place that knows how the two roles differ. `role` is ALWAYS the real authenticated role.
export function resolveActiveBusiness({ role, userBusinessId = null, selectedBusinessId = null } = {}) {
  if (role === ROLE_ADMIN) {
    // the selection is ignored on purpose: an ADMIN cannot switch tenant, whatever is in storage
    return { businessId: userBusinessId ?? null, requiresBusinessSelection: false, isBusinessSelectable: false }
  }
  if (role === ROLE_SUPER_ADMIN) {
    const businessId = normalizeBusinessId(selectedBusinessId)
    return { businessId, requiresBusinessSelection: businessId === null, isBusinessSelectable: true }
  }
  return { businessId: null, requiresBusinessSelection: false, isBusinessSelectable: false }
}

// A selection is bound to the identity that made it: { userId, businessId }. After a session change (another user,
// an expired session) a stored selection must never be reused, so it only counts for the SAME authenticated user.
export function normalizeSelection(value) {
  if (!value || typeof value !== 'object') return null
  const businessId = normalizeBusinessId(value.businessId)
  const userId = typeof value.userId === 'string' ? value.userId.trim() : ''
  return businessId !== null && userId !== '' ? { userId, businessId } : null
}

// The selection that applies to `userId`: the stored one only when it was made by that very user.
export function selectionFor(selection, userId) {
  const clean = normalizeSelection(selection)
  return clean !== null && typeof userId === 'string' && clean.userId === userId ? clean.businessId : null
}

export function readActiveBusiness(storage) {
  try {
    const raw = storage?.getItem(ACTIVE_BUSINESS_STORAGE_KEY)
    if (raw == null) return null
    let parsed = null
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }
    const selection = normalizeSelection(parsed)
    if (selection === null) storage.removeItem(ACTIVE_BUSINESS_STORAGE_KEY) // tampered / stale / old-format value
    return selection
  } catch {
    return null
  }
}

export function writeActiveBusiness(storage, selection) {
  try {
    if (selection === null) storage?.removeItem(ACTIVE_BUSINESS_STORAGE_KEY)
    else storage?.setItem(ACTIVE_BUSINESS_STORAGE_KEY, JSON.stringify(selection))
    return Boolean(storage)
  } catch {
    return false
  }
}
