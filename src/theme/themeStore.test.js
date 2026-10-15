import assert from 'node:assert/strict'
import { test } from 'node:test'
import { STORAGE_KEY } from './themeCore.js'
import { createThemeStore } from './themeStore.js'

function setup({ enabled = true, stored, systemDark = false, storage } = {}) {
  const data = stored === undefined ? {} : { [STORAGE_KEY]: stored }
  const store = storage ?? { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => void (data[k] = v) }
  const mqlListeners = new Set()
  const mql = {
    matches: systemDark,
    addEventListener: (_t, fn) => mqlListeners.add(fn),
    removeEventListener: (_t, fn) => mqlListeners.delete(fn),
  }
  const winListeners = new Map()
  const win = {
    addEventListener: (type, fn) => winListeners.set(type, fn),
    removeEventListener: (type) => winListeners.delete(type),
  }
  const docListeners = new Map()
  const doc = {
    visibilityState: 'visible',
    querySelector: () => null,
    addEventListener: (type, fn) => docListeners.set(type, fn),
    removeEventListener: (type) => docListeners.delete(type),
  }
  const attrs = {}
  const root = { style: {}, setAttribute: (k, v) => void (attrs[k] = v) }
  const theme = createThemeStore({ enabled, storage: store, matchMedia: () => mql, root, doc, win })
  return {
    theme, data, attrs, root, mql, mqlListeners, winListeners, docListeners, doc,
    // the OS changed while the tab was hidden: the "change" event was never delivered
    silentSystemChange(dark) { mql.matches = dark },
    setSystem(dark) { mql.matches = dark; mqlListeners.forEach((fn) => fn({ matches: dark })) },
    otherTabWrites(value) { data[STORAGE_KEY] = value; winListeners.get('storage')?.({ key: STORAGE_KEY }) },
  }
}

test('first visit with no stored choice follows prefers-color-scheme', () => {
  const light = setup({ systemDark: false })
  assert.deepEqual([light.theme.getState().preference, light.theme.getState().resolvedTheme], ['system', 'light'])
  const dark = setup({ systemDark: true })
  assert.deepEqual([dark.theme.getState().preference, dark.theme.getState().resolvedTheme], ['system', 'dark'])
})

test('a stored choice beats the OS setting', () => {
  const s = setup({ stored: 'light', systemDark: true })
  assert.equal(s.theme.getState().resolvedTheme, 'light')
  const d = setup({ stored: 'dark', systemDark: false })
  assert.equal(d.theme.getState().resolvedTheme, 'dark')
})

test('setPreference persists, notifies subscribers and updates <html>', () => {
  const s = setup({ systemDark: false })
  s.theme.attach()
  let calls = 0
  const off = s.theme.subscribe(() => (calls += 1))
  s.theme.setPreference('dark')
  assert.equal(s.data[STORAGE_KEY], 'dark')
  assert.equal(s.theme.getState().resolvedTheme, 'dark')
  assert.equal(s.attrs['data-theme'], 'dark')
  assert.equal(s.attrs['data-theme-preference'], 'dark')
  assert.equal(s.root.style.colorScheme, 'dark')
  assert.equal(calls, 1)
  s.theme.setPreference('dark') // same value: no spurious re-render
  assert.equal(calls, 1)
  off()
  s.theme.setPreference('light')
  assert.equal(calls, 1, 'unsubscribed')
})

test('"system" keeps reacting to OS changes; an explicit choice ignores them', () => {
  const s = setup({ systemDark: false })
  s.theme.attach()
  s.setSystem(true)
  assert.equal(s.theme.getState().resolvedTheme, 'dark')
  assert.equal(s.attrs['data-theme'], 'dark')
  s.setSystem(false)
  assert.equal(s.theme.getState().resolvedTheme, 'light')

  s.theme.setPreference('light')
  s.setSystem(true)
  assert.equal(s.theme.getState().resolvedTheme, 'light', 'explicit light is not overridden by the OS')
  s.theme.setPreference('system')
  assert.equal(s.theme.getState().resolvedTheme, 'dark', 'back to system picks up the current OS value')
})

test('a change made in another tab (storage event) is picked up', () => {
  const s = setup({ systemDark: false })
  s.theme.attach()
  s.otherTabWrites('dark')
  assert.equal(s.theme.getState().preference, 'dark')
  assert.equal(s.attrs['data-theme'], 'dark')
  s.winListeners.get('storage')({ key: 'unrelated-key' }) // ignored
  assert.equal(s.theme.getState().preference, 'dark')
})

test('system change missed while the tab was hidden is picked up when it becomes visible again', () => {
  const s = setup({ systemDark: false })
  s.theme.attach()
  s.doc.visibilityState = 'hidden'
  s.silentSystemChange(true)
  s.docListeners.get('visibilitychange')() // still hidden: nothing to do yet
  assert.equal(s.theme.getState().resolvedTheme, 'light')
  s.doc.visibilityState = 'visible'
  s.docListeners.get('visibilitychange')()
  assert.equal(s.theme.getState().resolvedTheme, 'dark')
  assert.equal(s.attrs['data-theme'], 'dark')
  s.silentSystemChange(false)
  s.winListeners.get('pageshow')() // back/forward cache restore
  assert.equal(s.theme.getState().resolvedTheme, 'light')
})

test('rollout flag off: always light on the page, but the preference is kept for later', () => {
  const s = setup({ enabled: false, stored: 'dark', systemDark: true })
  s.theme.attach()
  assert.equal(s.theme.getState().resolvedTheme, 'light')
  assert.equal(s.attrs['data-theme'], 'light')
  assert.equal(s.theme.getState().preference, 'dark')
  s.theme.setPreference('system')
  s.setSystem(true)
  assert.equal(s.attrs['data-theme'], 'light')
  assert.equal(s.theme.getState().enabled, false)
})

test('attach / detach are idempotent and clean up listeners (StrictMode runs effects twice)', () => {
  const s = setup()
  s.theme.attach()
  s.theme.attach()
  assert.equal(s.mqlListeners.size, 1)
  assert.equal(s.winListeners.size, 2) // storage + pageshow
  assert.equal(s.docListeners.size, 1) // visibilitychange
  s.theme.detach()
  s.theme.detach()
  assert.equal(s.mqlListeners.size, 0)
  assert.equal(s.winListeners.size, 0)
  assert.equal(s.docListeners.size, 0)
})

test('works without matchMedia or with broken storage', () => {
  const noMedia = createThemeStore({ enabled: true, storage: null, matchMedia: undefined, root: null, doc: null, win: null })
  assert.equal(noMedia.getState().resolvedTheme, 'light')
  noMedia.attach()
  noMedia.setPreference('dark')
  assert.equal(noMedia.getState().resolvedTheme, 'dark')
  const broken = setup({ storage: { getItem() { throw new Error('x') }, setItem() { throw new Error('x') } }, systemDark: true })
  assert.equal(broken.theme.getState().resolvedTheme, 'dark')
  broken.theme.setPreference('light')
  assert.equal(broken.theme.getState().resolvedTheme, 'light')
})
