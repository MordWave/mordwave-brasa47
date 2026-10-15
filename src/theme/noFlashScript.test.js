import assert from 'node:assert/strict'
import vm from 'node:vm'
import { test } from 'node:test'
import { STORAGE_KEY, THEME_COLORS, effectiveTheme } from './themeCore.js'
import { buildNoFlashScript } from './noFlashScript.js'

// Runs the generated inline script in a fake browser and returns what it left on <html>.
function run({ enabled, stored, systemDark, storageThrows = false, noMatchMedia = false }) {
  const attrs = {}
  const meta = { content: null, setAttribute(k, v) { if (k === 'content') this.content = v } }
  const sandbox = {
    document: {
      documentElement: { style: {}, setAttribute: (k, v) => void (attrs[k] = v) },
      querySelector: (q) => (q === 'meta[name="theme-color"]' ? meta : null),
    },
    window: {
      localStorage: storageThrows
        ? { getItem() { throw new Error('blocked') } }
        : { getItem: (k) => (k === STORAGE_KEY && stored !== undefined ? stored : null) },
      matchMedia: noMatchMedia ? undefined : () => ({ matches: systemDark }),
    },
  }
  vm.runInNewContext(buildNoFlashScript({ enabled }), sandbox)
  return { theme: attrs['data-theme'], pref: attrs['data-theme-preference'], scheme: sandbox.document.documentElement.style.colorScheme, meta: meta.content }
}

test('parity: the inline script resolves exactly like effectiveTheme() for every combination', () => {
  for (const enabled of [true, false]) {
    for (const stored of [undefined, 'system', 'light', 'dark', 'junk']) {
      for (const systemDark of [true, false]) {
        const out = run({ enabled, stored, systemDark })
        const preference = ['light', 'dark', 'system'].includes(stored) ? stored : 'system'
        const expected = effectiveTheme({ enabled, preference, systemPrefersDark: systemDark })
        const label = JSON.stringify({ enabled, stored, systemDark })
        assert.equal(out.theme, expected, label)
        assert.equal(out.pref, preference, label)
        assert.equal(out.scheme, expected, label)
        assert.equal(out.meta, THEME_COLORS[expected], label)
      }
    }
  }
})

test('robust: blocked storage or missing matchMedia still yields a valid theme', () => {
  assert.equal(run({ enabled: true, storageThrows: true, systemDark: true }).theme, 'dark')
  assert.equal(run({ enabled: true, stored: 'system', noMatchMedia: true }).theme, 'light')
  assert.equal(run({ enabled: true, stored: 'dark', noMatchMedia: true }).theme, 'dark')
})

test('the script is synchronous, self-contained and small', () => {
  const src = buildNoFlashScript({ enabled: true })
  assert.ok(src.length < 1200, `${src.length} bytes`)
  assert.doesNotMatch(src, /\bimport\b|\bawait\b|\bfetch\b|<\/script>/i)
})
