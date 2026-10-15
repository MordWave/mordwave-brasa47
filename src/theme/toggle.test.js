import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, test } from 'node:test'
import { THEME_OPTIONS, nextOptionIndex } from './toggleModel.js'
import { loadRenderer } from './testSupport.js'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
let render
before(async () => {
  render = (await loadRenderer()).renderToggle
})

test('the selector offers Sistema / Claro / Oscuro, in that order', () => {
  assert.deepEqual(THEME_OPTIONS.map((o) => [o.value, o.label]), [['system', 'Sistema'], ['light', 'Claro'], ['dark', 'Oscuro']])
})

test('keyboard: arrows select and wrap, Home/End jump, other keys are ignored', () => {
  assert.equal(nextOptionIndex('system', 'ArrowRight'), 1)
  assert.equal(nextOptionIndex('dark', 'ArrowRight'), 0)
  assert.equal(nextOptionIndex('system', 'ArrowLeft'), 2)
  assert.equal(nextOptionIndex('light', 'ArrowDown'), 2)
  assert.equal(nextOptionIndex('light', 'ArrowUp'), 0)
  assert.equal(nextOptionIndex('light', 'Home'), 0)
  assert.equal(nextOptionIndex('light', 'End'), 2)
  assert.equal(nextOptionIndex('light', 'Tab'), null)
  assert.equal(nextOptionIndex('light', 'Enter'), null)
  assert.equal(nextOptionIndex('garbage', 'ArrowRight'), 1) // unknown value behaves like the first option
})

test('rollout flag off: the selector renders nothing (production unchanged)', () => {
  assert.equal(render({ enabled: false, preference: 'system', resolvedTheme: 'light' }), '')
  assert.equal(render({ enabled: false, preference: 'dark', resolvedTheme: 'light' }, { variant: 'compact' }), '')
})

test('rendered selector is an accessible radio group with exactly one selected option', () => {
  for (const preference of ['system', 'light', 'dark']) {
    const html = render({ enabled: true, preference, resolvedTheme: 'light' })
    assert.match(html, /role="radiogroup"/)
    assert.match(html, /aria-label="Tema de la aplicación"/)
    assert.equal((html.match(/role="radio"/g) ?? []).length, 3)
    assert.equal((html.match(/aria-checked="true"/g) ?? []).length, 1)
    const selected = html.match(/<button[^>]*aria-checked="true"[^>]*>/)[0]
    const label = THEME_OPTIONS.find((o) => o.value === preference).label
    assert.ok(selected.includes(`aria-label="${label}"`), `${preference} -> ${selected}`)
    assert.ok(selected.includes('tabindex="0"'), 'roving tabindex: only the selected option is tabbable')
    assert.equal((html.match(/tabindex="-1"/g) ?? []).length, 2)
  }
})

test('every option is named for screen readers, also in the icon-only compact variant', () => {
  const compact = render({ enabled: true, preference: 'system', resolvedTheme: 'light' }, { variant: 'compact' })
  for (const o of THEME_OPTIONS) assert.ok(compact.includes(`aria-label="${o.label}"`))
  assert.doesNotMatch(compact, /theme-toggle__label/, 'compact shows icons only')
  const segmented = render({ enabled: true, preference: 'system', resolvedTheme: 'light' })
  assert.equal((segmented.match(/theme-toggle__label/g) ?? []).length, 3)
  assert.match(segmented, /theme-toggle--segmented/)
  assert.match(compact, /theme-toggle--compact/)
})

test('placement: Admin header and login mount it; no floating preview dock remains anywhere', () => {
  assert.match(read('../pages/admin/AdminPanel.jsx'), /<ThemeToggle \/>/)
  assert.match(read('../pages/admin/AdminLogin.jsx'), /<ThemeToggle \/>/)
  assert.doesNotMatch(read('./ThemeProvider.jsx'), /theme-dock|ThemeToggle/)
  assert.doesNotMatch(read('../styles/theme-toggle.css'), /theme-dock/)
  assert.doesNotMatch(read('./flag.js'), /isPreviewDockEnabled/)
  // customer menu (8B.3): compact selector inside the menu header, nowhere else (hero / cart / modals stay clean)
  assert.match(read('../components/customer/MenuView.jsx'), /<header className="menu__header">[\s\S]*<ThemeToggle variant="compact" \/>[\s\S]*<\/header>/)
  for (const f of ['../pages/CustomerApp.jsx', '../components/customer/HomeScreen.jsx', '../components/customer/CartBar.jsx', '../components/customer/OrderSuccessModal.jsx']) {
    assert.doesNotMatch(read(f), /ThemeToggle/, f)
  }
})

test('App.jsx marks the surface on <html> so portalled overlays get the Admin tokens', () => {
  const app = read('../App.jsx')
  assert.match(app, /useLayoutEffect/)
  assert.match(app, /setAttribute\('data-app', isAdmin \? 'admin' : 'customer'\)/)
})
