import {
  DARK_QUERY,
  STORAGE_KEY,
  applyThemeToDocument,
  effectiveTheme,
  normalizePreference,
  readStoredPreference,
  writeStoredPreference,
} from './themeCore.js'

// Tiny external store (works with useSyncExternalStore). All browser objects are injected:
//   enabled      rollout flag (false => always light, preference still tracked)
//   storage      localStorage-like
//   matchMedia   window.matchMedia
//   root, doc    document.documentElement, document
//   win          window (for the cross-tab "storage" event)
export function createThemeStore({ enabled, storage, matchMedia, root, doc, win }) {
  const mql = typeof matchMedia === 'function' ? matchMedia(DARK_QUERY) : null
  const listeners = new Set()
  let attached = false

  const compute = (preference, systemPrefersDark) => ({
    enabled: Boolean(enabled),
    preference,
    systemTheme: systemPrefersDark ? 'dark' : 'light',
    resolvedTheme: effectiveTheme({ enabled, preference, systemPrefersDark }),
  })

  let state = compute(readStoredPreference(storage), Boolean(mql?.matches))

  const publish = (next) => {
    const changed = next.preference !== state.preference || next.resolvedTheme !== state.resolvedTheme || next.systemTheme !== state.systemTheme
    state = changed ? next : state
    if (root) applyThemeToDocument({ root, doc }, state)
    if (changed) listeners.forEach((fn) => fn())
  }

  const onSystemChange = (event) => publish(compute(state.preference, Boolean(event?.matches ?? mql?.matches)))
  const resync = () => publish(compute(readStoredPreference(storage), Boolean(mql?.matches)))
  const onStorage = (event) => {
    if (event.key !== null && event.key !== STORAGE_KEY) return
    resync()
  }
  // Background tabs (notably on mobile) may not receive the prefers-color-scheme "change" event while hidden, and
  // another tab may have changed the preference: re-read everything when the page comes back.
  const onVisible = () => {
    if (doc?.visibilityState !== 'hidden') resync()
  }

  return {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    setPreference(preference) {
      const pref = normalizePreference(preference)
      writeStoredPreference(storage, pref)
      publish(compute(pref, Boolean(mql?.matches)))
    },
    // Idempotent so React StrictMode's double effect run is harmless.
    attach() {
      if (attached) return
      attached = true
      publish(state) // make sure the DOM matches (the inline script already did, this keeps it authoritative)
      mql?.addEventListener?.('change', onSystemChange)
      win?.addEventListener?.('storage', onStorage)
      win?.addEventListener?.('pageshow', resync)
      doc?.addEventListener?.('visibilitychange', onVisible)
    },
    detach() {
      if (!attached) return
      attached = false
      mql?.removeEventListener?.('change', onSystemChange)
      win?.removeEventListener?.('storage', onStorage)
      win?.removeEventListener?.('pageshow', resync)
      doc?.removeEventListener?.('visibilitychange', onVisible)
    },
  }
}
