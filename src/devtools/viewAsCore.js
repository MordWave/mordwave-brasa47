// "Ver como": pure, framework-free logic for the developer-only visual role preview.
//
// THIS IS NOT AUTHORIZATION. The preview role only ever feeds visual decisions in the frontend. It is never
// written to the AuthContext, the token, request headers, or the backend: the server keeps seeing the real user.

// Mirrors `UserRole` in backend/src/user/user-role.enum.ts (a test keeps both lists identical). Only roles that
// really exist are listed: no MANAGER / WAITER / KITCHEN until they have an interface and permissions.
export const KNOWN_ROLES = ['ADMIN', 'SUPER_ADMIN']

// sessionStorage (not localStorage): survives a refresh of this tab, dies with the tab, never reaches other tabs.
export const VIEW_AS_STORAGE_KEY = 'brasa47-dev-view-as'

// Anything that is not exactly a known role means "Real" (null).
export function normalizeViewAs(value, knownRoles = KNOWN_ROLES) {
  return typeof value === 'string' && knownRoles.includes(value) ? value : null
}

export function readViewAs(storage, knownRoles = KNOWN_ROLES) {
  try {
    const raw = storage?.getItem(VIEW_AS_STORAGE_KEY)
    const role = normalizeViewAs(raw, knownRoles)
    if (raw != null && role === null) storage.removeItem(VIEW_AS_STORAGE_KEY) // tampered / stale value: back to Real
    return role
  } catch {
    return null
  }
}

export function writeViewAs(storage, role) {
  try {
    if (role === null) storage?.removeItem(VIEW_AS_STORAGE_KEY)
    else storage?.setItem(VIEW_AS_STORAGE_KEY, role)
    return Boolean(storage)
  } catch {
    return false
  }
}

// The role used ONLY for visual decisions. `realRole` is always the authenticated user's own role.
export function effectiveViewRole(realRole, viewAsRole) {
  return viewAsRole ?? realRole ?? null
}

// Picking your own role is the same as "Real": nothing is being simulated, so no banner.
export function isSimulating(realRole, viewAsRole) {
  return viewAsRole !== null && viewAsRole !== undefined && viewAsRole !== realRole
}
