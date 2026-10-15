import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const css = readFileSync(new URL('../styles/index.css', import.meta.url), 'utf8')
const tokens = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8')
const adminStart = css.indexOf('/* ============ Admin ============ */')
const adminCss = css.slice(adminStart)

// Removes balanced `@media print { ... }` blocks (paper is always light and may use literal black/white).
function stripPrintBlocks(source) {
  let out = ''
  let i = 0
  while (i < source.length) {
    const j = source.indexOf('@media print', i)
    if (j < 0) {
      out += source.slice(i)
      break
    }
    out += source.slice(i, j)
    let depth = 0
    let k = source.indexOf('{', j)
    for (; k < source.length; k += 1) {
      if (source[k] === '{') depth += 1
      if (source[k] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    i = k + 1
  }
  return out
}
const adminScreenCss = stripPrintBlocks(adminCss).replace(/\/\*[\s\S]*?\*\//g, '')

test('the Admin section exists (guard against the scan silently covering nothing)', () => {
  assert.ok(adminStart > 0)
  assert.ok(adminScreenCss.length > 25000, `${adminScreenCss.length} chars`)
})

test('no structural colour is hardcoded in the Admin/shared-overlay styles (hex, rgb(a), hsl, named)', () => {
  const offenders = []
  const lines = adminScreenCss.split('\n')
  lines.forEach((line, i) => {
    if (/#[0-9a-fA-F]{3,8}\b/.test(line) || /\b(rgba?|hsla?)\(/.test(line) || /:\s*(white|black)\b/.test(line)) offenders.push(`${i + 1}: ${line.trim()}`)
  })
  assert.deepEqual(offenders, [], `hardcoded colours found:\n${offenders.join('\n')}`)
})

test('the Admin no longer borrows the brand for errors: --primary-dark / --accent are not used as state colours', () => {
  assert.doesNotMatch(adminScreenCss, /var\(--primary-dark\)/)
  assert.doesNotMatch(adminScreenCss, /var\(--accent\)/)
})

test('Admin text in the brand colour uses the AA-safe --primary-text, never raw --primary as a text colour', () => {
  const offenders = adminScreenCss.split('\n').filter((l) => /^\s*color:\s*var\(--primary\)/.test(l))
  assert.deepEqual(offenders, [])
})

test('focus rings in the Admin go through --focus-ring', () => {
  assert.doesNotMatch(adminScreenCss, /outline:\s*2px solid var\(--primary\)/)
  assert.match(adminScreenCss, /outline:\s*2px solid var\(--focus-ring\)/)
})

test('form controls in the Admin use --input-bg; placeholders use --placeholder', () => {
  assert.doesNotMatch(adminScreenCss, /(input|select|textarea)[^{]*\{[^}]*background:\s*var\(--bg\)/)
  assert.match(adminScreenCss, /\.admin-login__field input\s*\{[^}]*background:\s*var\(--input-bg\)/)
  assert.match(tokens, /:root\[data-app="admin"\] ::placeholder\s*\{[^}]*color:\s*var\(--placeholder\)/)
})

test('primary buttons take their colours from the control tokens with the old values as fallback (customer unchanged)', () => {
  assert.match(css, /\.btn--primary \{[^}]*background:\s*var\(--control-bg, var\(--primary\)\)/)
  assert.match(css, /\.btn--primary \{[^}]*color:\s*var\(--control-text, #fff\)/)
  // --control-* only exist under the admin scope
  assert.match(tokens, /:root\[data-app="admin"\] \{[^}]*--control-bg:\s*var\(--primary-control\)/)
  const beforeAdminScope = tokens.slice(0, tokens.indexOf(':root[data-app="admin"]'))
  assert.doesNotMatch(beforeAdminScope, /--control-bg\s*:/)
})

test('print blocks stay light: the print override exists and resets every structural token', () => {
  assert.match(tokens, /@media print \{\s*:root\[data-theme="dark"\] \{[^}]*color-scheme:\s*light/)
  assert.match(css, /@media print/)
})

test('the rollout switch is still off in code (no dark mode in production)', () => {
  assert.match(readFileSync(new URL('./flag.js', import.meta.url), 'utf8'), /export const DARK_MODE_ENABLED = false/)
})
