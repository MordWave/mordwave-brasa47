import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useAuth } from '../context/AuthContext'
import { BusinessContext } from './businessContext.js'
import { isBusinessSelectableRole, resolveActiveBusiness } from './tenantCore.js'
import { scopeBody as buildBody, scopePath as buildPath } from './tenantRequest.js'
import { createTenantStore } from './tenantStore.js'

// sessionStorage can throw just by being touched (blocked storage, some private modes).
function safeSessionStorage() {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

// Which business the Admin works on, kept apart from who is authenticated. Sits INSIDE <AuthProvider> and only READS
// the authenticated user's REAL role and businessId (never the Dev Tools "Ver como" role). It never writes to
// AuthContext, never touches the JWT or any header, and choosing a business grants nothing: the backend validates
// every request on its own.
//   ADMIN        businessId = their session's business; selection is ignored; nothing is persisted
//   SUPER_ADMIN  businessId = the explicit selection (kept in sessionStorage) or null => requiresBusinessSelection
export function BusinessContextProvider({ children }) {
  const { user, isAuthenticated } = useAuth()
  const [store] = useState(() => createTenantStore({ storage: safeSessionStorage() }))
  const { selectedBusinessId } = useSyncExternalStore(store.subscribe, store.getState, store.getState)
  const role = user?.role ?? null
  const userBusinessId = user?.businessId ?? null

  // logout (or an expired session) always drops the selection: the next login starts without one
  useEffect(() => {
    if (!isAuthenticated) store.clear()
  }, [isAuthenticated, store])

  const resolved = resolveActiveBusiness({ role, userBusinessId, selectedBusinessId })
  const { businessId, requiresBusinessSelection, isBusinessSelectable } = resolved

  // Only a SUPER_ADMIN can choose; for anyone else this is a no-op (an ADMIN cannot switch tenant from the UI).
  const setActiveBusiness = useCallback((id) => (isBusinessSelectableRole(role) ? store.select(id) : false), [role, store])
  const clearActiveBusiness = useCallback(() => store.clear(), [store])
  // identity changes only when the resolved business does, so effects depending on them don't refetch needlessly
  const scopePath = useCallback((path) => buildPath(path, { businessId, isBusinessSelectable }), [businessId, isBusinessSelectable])
  const scopeBody = useCallback((payload) => buildBody(payload, { businessId, isBusinessSelectable }), [businessId, isBusinessSelectable])

  const value = useMemo(
    () => ({ businessId, requiresBusinessSelection, isBusinessSelectable, setActiveBusiness, clearActiveBusiness, scopePath, scopeBody }),
    [businessId, requiresBusinessSelection, isBusinessSelectable, setActiveBusiness, clearActiveBusiness, scopePath, scopeBody],
  )

  return <BusinessContext.Provider value={value}>{children}</BusinessContext.Provider>
}
