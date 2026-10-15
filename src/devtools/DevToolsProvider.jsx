import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useAuth } from '../context/AuthContext'
import { DevToolsContext } from './devToolsContext.js'
import { effectiveViewRole, isSimulating } from './viewAsCore.js'
import { createViewAsStore } from './viewAsStore.js'

// sessionStorage can throw just by being touched (blocked storage, some private modes).
function safeSessionStorage() {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

// Developer tools state. Sits INSIDE <AuthProvider> and only READS the authenticated user's role:
//   realRole           the authenticated user's role (from AuthContext, untouched)
//   viewAsRole         the role being previewed, or null for "Real"
//   effectiveViewRole  viewAsRole ?? realRole: for VISUAL decisions only, never for authorization or requests
// It never writes to AuthContext, never touches the token, and nothing here is sent to the backend.
// With `enabled` false (VITE_DEV_TOOLS_ENABLED not set) the store is inert and viewAsRole is always null.
export function DevToolsProvider({ enabled = false, children }) {
  const { user, isAuthenticated } = useAuth()
  const [store] = useState(() => createViewAsStore({ enabled, storage: enabled ? safeSessionStorage() : null }))
  const { viewAsRole } = useSyncExternalStore(store.subscribe, store.getState, store.getState)
  const realRole = user?.role ?? null

  // logout (or an expired session) always drops the preview, so the next login starts on "Real"
  useEffect(() => {
    if (!isAuthenticated) store.reset()
  }, [isAuthenticated, store])

  const value = useMemo(
    () => ({
      enabled,
      roles: store.knownRoles,
      realRole,
      viewAsRole,
      effectiveViewRole: effectiveViewRole(realRole, viewAsRole),
      isSimulating: isSimulating(realRole, viewAsRole),
      setViewAs: store.setViewAs,
      resetViewAs: store.reset,
    }),
    [enabled, store, realRole, viewAsRole],
  )

  return <DevToolsContext.Provider value={value}>{children}</DevToolsContext.Provider>
}
