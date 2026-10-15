import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  STORAGE_KEY,
  THEME_COLORS,
  applyThemeToDocument,
  effectiveTheme,
  normalizePreference,
  readStoredPreference,
  resolveTheme,
  writeStoredPreference,
} from './themeCore.js'
import { DARK_MODE_ENABLED, isDarkModeEnabled } from './flag.js'

const memoryStorage = (initial = {}) => {
  const data = { ...initial }
  return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => void (data[k] = String(v)) }
}
const throwingStorage = () => ({
  getItem() {
    throw new Error('SecurityError')
  },
  setItem() {
    throw new Error('QuotaExceeded')
  },
})

test('normalizePreference falls back to system for anything unexpected', () => {
  for (const ok of ['system', 'light', 'dark']) assert.equal(normalizePreference(ok), ok)
  for (const bad of [undefined, null, '', 'DARK', 'auto', 1, {}]) assert.equal(normalizePreference(bad), 'system')
})

test('resolveTheme: explicit choice wins; system follows the OS', () => {
  assert.equal(resolveTheme('light', true), 'light')
  assert.equal(resolveTheme('dark', false), 'dark')
  assert.equal(resolveTheme('system', true), 'dark')
  assert.equal(resolveTheme('system', false), 'light')
  assert.equal(resolveTheme('garbage', true), 'dark') // treated as system
})

test('first visit (nothing stored) means system', () => {
  assert.equal(readStoredPreference(memoryStorage()), 'system')
})

test('storage round trip, and a corrupted value is ignored', () => {
  const s = memoryStorage()
  assert.equal(writeStoredPreference(s, 'dark'), true)
  assert.equal(s.data[STORAGE_KEY], 'dark')
  assert.equal(readStoredPreference(s), 'dark')
  s.data[STORAGE_KEY] = '{"hacked":true}'
  assert.equal(readStoredPreference(s), 'system')
})

test('unavailable or throwing storage never breaks anything', () => {
  assert.equal(readStoredPreference(throwingStorage()), 'system')
  assert.equal(writeStoredPreference(throwingStorage(), 'dark'), false)
  assert.equal(readStoredPreference(null), 'system')
  assert.equal(writeStoredPreference(null, 'dark'), false)
})

test('effectiveTheme: the rollout flag forces light but does not erase the preference', () => {
  assert.equal(effectiveTheme({ enabled: false, preference: 'dark', systemPrefersDark: true }), 'light')
  assert.equal(effectiveTheme({ enabled: true, preference: 'dark', systemPrefersDark: false }), 'dark')
  assert.equal(effectiveTheme({ enabled: true, preference: 'system', systemPrefersDark: true }), 'dark')
})

test('rollout flag: off by default in code, preview only through the env switch', () => {
  assert.equal(DARK_MODE_ENABLED, false, 'must stay false until 8B.2 and 8B.3 are done')
  assert.equal(isDarkModeEnabled({}), false)
  assert.equal(isDarkModeEnabled(undefined), false)
  assert.equal(isDarkModeEnabled({ VITE_DARK_MODE_PREVIEW: '1' }), true)
  assert.equal(isDarkModeEnabled({ VITE_DARK_MODE_PREVIEW: 'true' }), false)
})

test('applyThemeToDocument writes data-theme, preference, color-scheme and the browser theme-color', () => {
  const attrs = {}
  const root = { style: {}, setAttribute: (k, v) => void (attrs[k] = v) }
  const meta = { content: null, setAttribute(k, v) { this[k] = v } }
  const doc = { querySelector: (q) => (q === 'meta[name="theme-color"]' ? meta : null) }
  applyThemeToDocument({ root, doc }, { resolvedTheme: 'dark', preference: 'system' })
  assert.deepEqual(attrs, { 'data-theme': 'dark', 'data-theme-preference': 'system' })
  assert.equal(root.style.colorScheme, 'dark')
  assert.equal(meta.content, THEME_COLORS.dark)
  applyThemeToDocument({ root, doc }, { resolvedTheme: 'light', preference: 'light' })
  assert.equal(attrs['data-theme'], 'light')
  assert.equal(meta.content, THEME_COLORS.light)
  // no meta tag / no doc: still fine
  applyThemeToDocument({ root, doc: { querySelector: () => null } }, { resolvedTheme: 'dark', preference: 'dark' })
  applyThemeToDocument({ root }, { resolvedTheme: 'dark', preference: 'dark' })
})
