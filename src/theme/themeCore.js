// Pure theme logic (no React, no globals): everything takes its environment as arguments so it can be unit
// tested with plain fakes. The inline anti-flash script (noFlashScript.js) embeds the same constants.

export const THEME_PREFERENCES = ['system', 'light', 'dark']
export const STORAGE_KEY = 'brasa47-theme' // one key: Admin and the customer menu share the preference in a browser
export const DARK_QUERY = '(prefers-color-scheme: dark)'

// Browser UI colour (address bar / PWA chrome): follows the page background token of each theme.
export const THEME_COLORS = { light: '#F5F1E8', dark: '#14120F' }

export function normalizePreference(value) {
  return THEME_PREFERENCES.includes(value) ? value : 'system'
}

// storage may be missing or throw (private mode, blocked cookies): never let that break the app.
export function readStoredPreference(storage) {
  try {
    return normalizePreference(storage?.getItem(STORAGE_KEY))
  } catch {
    return 'system'
  }
}

export function writeStoredPreference(storage, preference) {
  if (!storage) return false
  try {
    storage.setItem(STORAGE_KEY, normalizePreference(preference))
    return true
  } catch {
    return false
  }
}

export function resolveTheme(preference, systemPrefersDark) {
  const pref = normalizePreference(preference)
  if (pref === 'system') return systemPrefersDark ? 'dark' : 'light'
  return pref
}

// When the rollout flag is off the resolved theme is always light (see flag.js).
export function effectiveTheme({ enabled, preference, systemPrefersDark }) {
  return enabled ? resolveTheme(preference, systemPrefersDark) : 'light'
}

// Writes the resolved theme where CSS and the browser read it.
export function applyThemeToDocument({ root, doc }, { resolvedTheme, preference }) {
  root.setAttribute('data-theme', resolvedTheme)
  root.setAttribute('data-theme-preference', normalizePreference(preference))
  if (root.style) root.style.colorScheme = resolvedTheme
  const meta = doc?.querySelector?.('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', THEME_COLORS[resolvedTheme] ?? THEME_COLORS.light)
}
