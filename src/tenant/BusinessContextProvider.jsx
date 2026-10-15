import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useAuth } from '../context/AuthContext'
import { BusinessContext } from './businessContext.js'
import { isBusinessSelectableRole, resolveActiveBusiness, selectionFor } from './tenantCore.js'
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
// the authenticated user's REAL id, role and businessId (never the Dev Tools "Ver como" role). It never writes to
// AuthContext, never touches the JWT or any header, and choosing a business grants nothing: the backend validates
// every request on its own.
//   ADMIN        businessId = their session's business; selection is ignored; nothing is persisted; always ready
//   SUPER_ADMIN  businessId = the explicit selection (kept in sessionStorage, bound to THIS user) or null =>
//                requiresBusinessSelection. A selection is not "ready" until the selector gate has checked that the
//                business still exists and is active (confirmActiveBusiness); no administrative data is loaded before.
export function BusinessContextProvider({ children }) {
  const { user, isAuthenticated } = useAuth()
  const [store] = useState(() => createTenantStore({ storage: safeSessionStorage() }))
  const { selection } = useSyncExternalStore(store.subscribe, store.getState, store.getState)
  // which (user, business) pair the selector gate has verified; not persisted: a refresh validates again
  const [validated, setValidated] = useState(null)
  const userId = user?.id ?? null
  const role = user?.role ?? null
  const userBusinessId = user?.businessId ?? null
  const selectedBusinessId = selectionFor(selection, userId)

  // logout (or an expired session) always drops the selection; so does a different authenticated identity
  useEffect(() => {
    if (!isAuthenticated) {
      store.clear()
      setValidated(null)
    } else if (selection !== null && selectedBusinessId === null) {
      store.clear() // a selection made by someone else is never reused
    }
  }, [isAuthenticated, selection, selectedBusinessId, store])

  const resolved = resolveActiveBusiness({ role, userBusinessId, selectedBusinessId })
  const { businessId, requiresBusinessSelection, isBusinessSelectable } = resolved
  const isBusinessReady = isBusinessSelectable
    ? businessId !== null && validated?.userId === userId && validated?.businessId === businessId
    : businessId !== null

  // Only a SUPER_ADMIN can choose; for anyone else this is a no-op (an ADMIN cannot switch tenant from the UI).
  const setActiveBusiness = useCallback(
    (id) => (isBusinessSelectableRole(role) && userId ? store.select({ userId, businessId: id }) : false),
    [role, userId, store],
  )
  const clearActiveBusiness = useCallback(() => {
    store.clear()
    setValidated(null)
  }, [store])
  // Called by the selector gate once it has verified the business (exists, active). No-op unless it IS the selection.
  const confirmActiveBusiness = useCallback(
    (id) => {
      if (isBusinessSelectable && userId && id === businessId) setValidated({ userId, businessId: id })
    },
    [isBusinessSelectable, userId, businessId],
  )
  // identity changes only when the resolved business does, so effects depending on them don't refetch needlessly
  const scopePath = useCallback((path) => buildPath(path, { businessId, isBusinessSelectable }), [businessId, isBusinessSelectable])
  const scopeBody = useCallback((payload) => buildBody(payload, { businessId, isBusinessSelectable }), [businessId, isBusinessSelectable])

  const value = useMemo(
    () => ({
      businessId,
      requiresBusinessSelection,
      isBusinessSelectable,
      isBusinessReady,
      setActiveBusiness,
      clearActiveBusiness,
      confirmActiveBusiness,
      scopePath,
      scopeBody,
    }),
    [businessId, requiresBusinessSelection, isBusinessSelectable, isBusinessReady, setActiveBusiness, clearActiveBusiness, confirmActiveBusiness, scopePath, scopeBody],
  )

  return <BusinessContext.Provider value={value}>{children}</BusinessContext.Provider>
}
