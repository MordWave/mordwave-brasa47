import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { isDarkModeEnabled } from './flag.js'
import { ThemeContext } from './themeContext.js'
import { createThemeStore } from './themeStore.js'

// localStorage can throw just by being touched (blocked cookies, some private modes).
function safeStorage() {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

// Wraps the whole app (Admin and customer menu share it): resolves light / dark / system, persists the
// choice, follows prefers-color-scheme while the preference is "system" and mirrors the result on
// <html data-theme>. It owns only STRUCTURAL theming; each restaurant's brand colours are separate.
export function ThemeProvider({ children }) {
  const [store] = useState(() =>
    createThemeStore({
      enabled: isDarkModeEnabled(import.meta.env),
      storage: safeStorage(),
      matchMedia: window.matchMedia?.bind(window),
      root: document.documentElement,
      doc: document,
      win: window,
    }),
  )

  useEffect(() => {
    store.attach()
    return () => store.detach()
  }, [store])

  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState)
  const value = useMemo(() => ({ ...state, setPreference: store.setPreference }), [state, store])

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  )
}
