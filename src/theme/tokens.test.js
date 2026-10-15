import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { contrastRatio, deriveControlColors, ensureContrastOnAll } from './color.js'

const css = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8')
const tokensCss = css

// Declarations of a block starting at `selector {` (first occurrence), as { '--name': 'value' }.
function block(selector, from = 0) {
  const start = css.indexOf(`${selector} {`, from)
  assert.ok(start >= 0, `block ${selector} not found`)
  const end = css.indexOf('}', start)
  const out = {}
  for (const m of css.slice(start, end).matchAll(/(--[a-z-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim()
  return out
}
const light = block(':root')
const dark = block(':root[data-theme="dark"]')
const print = block(':root[data-theme="dark"]', css.indexOf('@media print'))
// What the dark theme really computes: the light layer is the base and the dark block overrides it. Alias tokens
// such as --dimmed-surface: var(--bg) live only in the base layer and re-resolve against the dark values.
const darkEffective = { ...light, ...dark }

const STRUCTURAL = [
  '--bg', '--surface', '--surface-elevated', '--text', '--text-muted', '--border', '--input-bg', '--hover', '--row-hover', '--overlay',
  '--danger', '--danger-hover', '--danger-tint', '--danger-border', '--shadow-danger', '--success', '--success-tint', '--warning', '--warning-tint',
  '--on-danger', '--on-success', '--on-warning', '--inverse-surface', '--inverse-text',
  '--dimmed-surface', '--dimmed-text', '--dim-media-opacity', '--shadow-rgb', '--shadow-popover', '--shadow-modal', '--shadow-card',
  '--primary-tint', '--primary-tint-strong', '--primary-text', '--primary-ui', '--accent-text',
  '--field-bg', '--surface-edge', '--success-on-inverse', '--shadow-tile', '--shadow-float',
]
const BRAND = ['--primary', '--accent', '--on-primary', '--on-accent']

test('every semantic token exists in both themes (no theme can miss one)', () => {
  for (const name of STRUCTURAL) {
    assert.ok(name in light, `light misses ${name}`)
    assert.ok(name in darkEffective, `dark misses ${name}`)
  }
})

test('layers do not mix: the dark theme never redefines brand colours', () => {
  for (const name of BRAND) assert.ok(!(name in dark), `${name} must stay a per-restaurant value`)
  for (const name of BRAND) assert.ok(name in light, `brand default ${name} missing`)
})

test('light layer is the original palette (light mode is visually unchanged), except the documented AA tweaks', () => {
  assert.equal(light['--bg'], '#F5F1E8')
  assert.equal(light['--surface'], '#FFFFFF')
  assert.equal(light['--text'], '#171714')
  assert.equal(light['--text-muted'], '#6E6A60')
  assert.equal(light['--border'], '#DED8CC')
  assert.equal(light['--primary'], '#D94A2B')
  assert.equal(light['--accent'], '#E9B44C')
  assert.equal(light['--success'], '#377855') // was #397A57: minimal darkening so success-on-tint reaches AA (4.47 -> 4.60)
  assert.equal(light['--text-secondary'], 'var(--text-muted)', 'legacy alias keeps old selectors working')
  // values that replaced literals in the Admin stylesheet must equal those literals
  assert.equal(light['--input-bg'], '#F5F1E8') // inputs were var(--bg)
  assert.equal(light['--hover'], 'rgba(23, 23, 20, 0.04)')
  assert.equal(light['--row-hover'], 'rgba(245, 241, 232, 0.55)')
  assert.equal(light['--overlay'], 'rgba(23, 23, 20, 0.45)')
  assert.equal(light['--danger-tint'], '#FBEAE4')
  assert.equal(light['--danger-border'], 'rgba(217, 74, 43, 0.25)')
  assert.equal(light['--primary-tint-strong'], 'rgba(217, 74, 43, 0.14)')
  assert.equal(light['--shadow-rgb'], '23 23 20')
  assert.equal(light['--inverse-surface'], '#171714') // toasts / cart bar were var(--text) + #fff
  assert.equal(light['--inverse-text'], '#FFFFFF')
})

test('the AA-safe brand variants for the demo brand are exactly what the utilities compute', () => {
  const control = deriveControlColors('#D94A2B')
  assert.equal(light['--primary-control'], control.control)
  assert.equal(light['--on-primary-control'], control.onControl)
  assert.ok(contrastRatio(light['--primary-control'], light['--on-primary-control']) >= 4.5)
  const lightText = ensureContrastOnAll('#D94A2B', [light['--surface'], light['--bg'], light['--primary-tint']])
  assert.equal(light['--primary-text'], lightText.color)
  const darkText = ensureContrastOnAll('#D94A2B', [dark['--bg'], dark['--surface'], dark['--surface-elevated'], dark['--input-bg'], dark['--primary-tint']])
  assert.equal(dark['--primary-text'], darkText.color)
})

test('brand-as-text (--primary-text) reaches AA on every surface it can appear on, in both themes', () => {
  for (const s of ['--surface', '--bg', '--primary-tint', '--input-bg']) assert.ok(contrastRatio(light['--primary-text'], light[s]) >= 4.5, `light on ${s}`)
  for (const s of ['--bg', '--surface', '--surface-elevated', '--input-bg', '--primary-tint']) assert.ok(contrastRatio(dark['--primary-text'], dark[s]) >= 4.5, `dark on ${s}`)
})

test('text/icons on solid status fills reach AA (toast icons, destructive buttons), both themes', () => {
  for (const [name, theme] of [['light', light], ['dark', dark]]) {
    for (const k of ['danger', 'success', 'warning']) {
      assert.ok(contrastRatio(theme[`--on-${k}`], theme[`--${k}`]) >= 4.5, `${name} --on-${k} on --${k}: ${contrastRatio(theme[`--on-${k}`], theme[`--${k}`]).toFixed(2)}`)
    }
    assert.ok(contrastRatio(theme['--inverse-text'], theme['--inverse-surface']) >= 7, `${name} inverse pair`)
  }
})

test('status pairs important for the Admin keep AA: badges, error text, notes, destructive menu item', () => {
  for (const [name, theme] of [['dark', dark]]) {
    for (const [fg, bg] of [['--danger', '--danger-tint'], ['--success', '--success-tint'], ['--warning', '--warning-tint'], ['--danger', '--surface'], ['--danger', '--surface-elevated'], ['--success', '--surface'], ['--text', '--danger-tint'], ['--text-muted', '--input-bg']]) {
      assert.ok(contrastRatio(theme[fg], theme[bg]) >= 4.5, `${name} ${fg} on ${bg}`)
    }
  }
  assert.ok(contrastRatio(light['--danger'], light['--danger-tint']) >= 4.5)
  assert.ok(contrastRatio(light['--danger'], light['--surface']) >= 4.5)
  assert.ok(contrastRatio(light['--text-muted'], light['--input-bg']) >= 4.5, 'placeholder text')
})

test('focus ring has non-text contrast (3:1) against the surfaces it sits on', () => {
  assert.equal(dark['--focus-ring'], 'var(--primary-text)')
  for (const s of ['--bg', '--surface', '--surface-elevated']) assert.ok(contrastRatio(dark['--primary-text'], dark[s]) >= 3, `dark ring on ${s}`)
  assert.equal(light['--focus-ring'], 'var(--primary)')
  assert.ok(contrastRatio(light['--primary'], light['--surface']) >= 3)
})

test('dark theme elevation uses black shadows (a dark halo is invisible on dark surfaces)', () => {
  assert.equal(dark['--shadow-rgb'], '0 0 0')
  for (const k of ['--shadow-popover', '--shadow-modal', '--shadow-card']) assert.match(dark[k], /rgb\(var\(--shadow-rgb\) \/ 0\.\d+\)/)
})

test('dark is a real dark palette: not pure black, surfaces step up, light text', () => {
  assert.notEqual(dark['--bg'].toUpperCase(), '#000000')
  const lum = (hex) => contrastRatio(hex, '#000000')
  assert.ok(lum(dark['--bg']) < lum(dark['--surface']) && lum(dark['--surface']) < lum(dark['--surface-elevated']))
  assert.ok(contrastRatio(dark['--text'], dark['--bg']) > 12)
})

test('dark text tokens reach WCAG AA (4.5:1) on every surface they can sit on', () => {
  const surfaces = ['--bg', '--surface', '--surface-elevated', '--input-bg']
  for (const s of surfaces) {
    for (const t of ['--text', '--text-muted', '--danger', '--success', '--warning']) {
      assert.ok(contrastRatio(dark[t], dark[s]) >= 4.5, `dark ${t} on ${s}: ${contrastRatio(dark[t], dark[s]).toFixed(2)}`)
    }
  }
  for (const [text, tint] of [['--danger', '--danger-tint'], ['--success', '--success-tint'], ['--warning', '--warning-tint']]) {
    assert.ok(contrastRatio(dark[text], dark[tint]) >= 4.5, `dark ${text} on ${tint}`)
  }
})

test('light text tokens reach AA on every surface and status tint (no exceptions left)', () => {
  for (const s of ['--bg', '--surface', '--surface-elevated', '--input-bg']) {
    for (const t of ['--text', '--text-muted', '--danger', '--success', '--warning']) {
      assert.ok(contrastRatio(light[t], light[s]) >= 4.5, `light ${t} on ${s}: ${contrastRatio(light[t], light[s]).toFixed(2)}`)
    }
  }
  for (const [text, tint] of [['--danger', '--danger-tint'], ['--success', '--success-tint'], ['--warning', '--warning-tint']]) {
    assert.ok(contrastRatio(light[text], light[tint]) >= 4.5, `light ${text} on ${tint}: ${contrastRatio(light[text], light[tint]).toFixed(2)}`)
  }
})

test('printing from dark restores the light structural values', () => {
  for (const [name, value] of Object.entries(print)) {
    if (name === '--text-secondary') continue
    assert.equal(value, light[name], `print ${name}`)
  }
  for (const name of STRUCTURAL) assert.equal(print[name], light[name], `print misses ${name}`)
})

test('no component stylesheet may name a surface "white" or "black" as a token', () => {
  const index = readFileSync(new URL('../styles/index.css', import.meta.url), 'utf8')
  assert.doesNotMatch(index, /--(white|black)\b/)
  assert.doesNotMatch(css, /--(white|black)\b/)
})

// ---- dimmed states: cancelled / delivered orders, inactive tables, categories and products ----------------
// They must be AA in BOTH themes for every text that can appear in them, without relying on `opacity`.
const themes = [['light', light], ['dark', darkEffective]]
// resolves "var(--x)" aliases one level
const val = (theme, name) => {
  const v = theme[name]
  const m = /^var\((--[a-z-]+)\)$/.exec(v)
  return m ? theme[m[1]] : v
}

test('dimmed text is a semantic colour that is AA on the dimmed surface and on the normal surfaces, both themes', () => {
  for (const [name, theme] of themes) {
    const text = val(theme, '--dimmed-text')
    const dimmedSurface = val(theme, '--dimmed-surface')
    for (const bg of [dimmedSurface, theme['--surface'], theme['--bg'], theme['--surface-elevated']]) {
      assert.ok(contrastRatio(text, bg) >= 4.5, `${name} dimmed text on ${bg}: ${contrastRatio(text, bg).toFixed(2)}`)
    }
    // product rows show the hover wash over a dimmed row: still AA on the page background it blends towards
    assert.ok(contrastRatio(text, theme['--bg']) >= 4.5)
  }
})

test('semantic accents that appear inside dimmed states stay AA on the dimmed surface (badges, danger buttons, notes)', () => {
  for (const [name, theme] of themes) {
    const surface = val(theme, '--dimmed-surface')
    for (const k of ['--danger', '--success', '--warning']) assert.ok(contrastRatio(theme[k], surface) >= 4.5, `${name} ${k} on dimmed surface`)
    for (const [fg, tint] of [['--danger', '--danger-tint'], ['--success', '--success-tint'], ['--warning', '--warning-tint']]) {
      assert.ok(contrastRatio(theme[fg], theme[tint]) >= 4.5, `${name} ${fg} on ${tint}`)
    }
  }
})

test('dimmed styles never use opacity on a container with text; only images are faded', () => {
  const index = readFileSync(new URL('../styles/index.css', import.meta.url), 'utf8')
  assert.doesNotMatch(index, /--dim-opacity/)
  assert.doesNotMatch(tokensCss, /--dim-opacity/)
  const body = (selector) => {
    const start = index.indexOf(`\n${selector} {`)
    assert.ok(start >= 0, `${selector} not found`)
    return index.slice(start, index.indexOf('}', start))
  }
  for (const sel of ['.order-card--delivered', '.order-card--cancelled', '.admin-tables__card--inactive', '.admin-menu__row--inactive', '.product-row--inactive']) {
    assert.doesNotMatch(body(sel), /opacity\s*:/, `${sel} must not fade its text with opacity`)
    assert.match(body(sel), /color:\s*var\(--dimmed-text\)/, `${sel} uses the dimmed text colour`)
  }
  for (const sel of ['.order-card--cancelled', '.admin-tables__card--inactive', '.admin-menu__row--inactive', '.product-row--inactive']) {
    assert.match(body(sel), /background:\s*var\(--dimmed-surface\)/, `${sel} uses the dimmed surface`)
  }
  assert.match(body('.product-row--inactive .product-row__thumb img'), /opacity:\s*var\(--dim-media-opacity\)/)
})
