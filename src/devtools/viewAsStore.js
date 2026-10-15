import { normalizeViewAs, readViewAs, writeViewAs, KNOWN_ROLES } from './viewAsCore.js'

// Small external store for the preview role (same pattern as theme/themeStore.js, consumed with
// useSyncExternalStore). It knows nothing about authentication: DevToolsProvider feeds it logout events.
//   enabled     false => completely inert: never reads or writes storage, ignores every call
//   storage     sessionStorage (or a stub in tests)
export function createViewAsStore({ enabled, storage, knownRoles = KNOWN_ROLES }) {
  let state = { viewAsRole: enabled ? readViewAs(storage, knownRoles) : null }
  const listeners = new Set()

  const publish = (viewAsRole) => {
    if (viewAsRole === state.viewAsRole) return
    state = { viewAsRole }
    listeners.forEach((fn) => fn())
  }

  return {
    enabled,
    knownRoles,
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    // null (or anything that is not a known role) = Real
    setViewAs(role) {
      if (!enabled) return
      const next = normalizeViewAs(role, knownRoles)
      writeViewAs(storage, next)
      publish(next)
    },
    reset() {
      if (!enabled) return
      writeViewAs(storage, null)
      publish(null)
    },
  }
}
