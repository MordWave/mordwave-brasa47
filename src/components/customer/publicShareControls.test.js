import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, test } from 'node:test'
import { loadModule } from '../../theme/testSupport.js'
import { brandingStyleVars } from '../../theme/brandStyle.js'
import { contrastRatio } from '../../theme/color.js'
import { surfacesFor } from '../../theme/surfaces.js'

// 9K.8 — the header controls of the shareable menu: Share as the main action (restaurant colours, outline, icon + text, icon-only under
// 360px) and the quieter theme selector, left of it. The table (QR) menu keeps its own controls.

const CATEGORIES = [{ id: 'c1', name: 'Bebidas', slug: 'bebidas', sortOrder: 1 }]
const PRODUCTS = [{ id: 'p1', categoryId: 'c1', name: 'Limonada', description: '', price: 2500, image: null, tag: null, available: true, sortOrder: 1 }]
const BUSINESS = { name: 'Alpha Burgers', slug: 'alpha-burgers', logoUrl: null, coverUrl: null, primaryColor: '#AA3300', accentColor: null }

let r
before(async () => {
  r = await loadModule(`
    import { renderToStaticMarkup } from 'react-dom/server'
    import { PublicMenuView } from './pages/PublicMenuPage.jsx'
    import { ThemeContext } from './theme/themeContext.js'
    const theme = (preference) => ({ resolvedTheme: preference === 'dark' ? 'dark' : 'light', preference, systemTheme: 'light', enabled: true, setPreference() {} })
    export const view = (props, preference = 'system') => renderToStaticMarkup(<ThemeContext.Provider value={theme(preference)}><PublicMenuView {...props} /></ThemeContext.Provider>)
  `)
})
const ready = (extra = {}, preference) => r.view({ status: 'ready', business: BUSINESS, categories: CATEGORIES, products: PRODUCTS, activeCategory: 'c1', onShare() {}, ...extra }, preference)
const actions = (html) => html.match(/<div class="menu__header-actions">([\s\S]*?)<\/header>/)[1]
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const css = read('../../styles/index.css')
const rule = (selector, from = 0) => {
  const start = css.indexOf(`${selector} {`, from)
  assert.ok(start >= 0, `${selector} rule exists`)
  return css.slice(start, css.indexOf('}', start))
}

test('1. Share is a primary button with an icon and the text "Compartir": that text is its accessible name', () => {
  const html = actions(ready())
  const button = html.match(/<button type="button" class="([^"]*)">([\s\S]*?)<\/button>/)
  assert.ok(button, 'there is a plain button')
  assert.match(button[1], /\bbtn btn--primary public-menu__share\b/)
  assert.ok(!button[1].includes('btn--small'))
  assert.match(button[2], /^<svg[^>]*aria-hidden="true"[\s\S]*<\/svg><span class="public-menu__share-label">Compartir<\/span>$/)
  assert.ok(!/aria-label/.test(button[0]), 'no aria-label needed: the text names the button, with or without the icon-only mode')
})

test('2. the icon is 16px, drawn like the theme selector icons, and decorative', () => {
  const svg = actions(ready()).match(/<svg[^>]*>/)[0]
  assert.match(svg, /width="16"/)
  assert.match(svg, /height="16"/)
  assert.match(svg, /stroke-width="2"/)
  assert.match(svg, /stroke-linecap="round"/)
  assert.match(svg, /aria-hidden="true"/)
})

test('3. keyboard and visual order agree: the theme selector (one tab stop, arrow keys) comes first, Share last at the right margin', () => {
  const html = actions(ready())
  assert.ok(html.indexOf('theme-toggle') < html.indexOf('public-menu__share'))
  assert.equal((html.match(/<button/g) ?? []).length, 4, 'three theme options + Share')
  assert.ok(html.trim().endsWith('</button></div>') || html.includes('Compartir</span></button></div>'), 'Share is the last control')
})

test('4. the theme selector keeps its three options with names and states, whatever the preference', () => {
  for (const preference of ['system', 'light', 'dark']) {
    const html = actions(ready({}, preference))
    assert.match(html, /role="radiogroup" aria-label="Tema de la aplicación"/)
    const radios = [...html.matchAll(/<button[^>]*role="radio"[^>]*>/g)].map((m) => m[0])
    assert.equal(radios.length, 3)
    assert.deepEqual(radios.map((b) => b.match(/aria-label="([^"]+)"/)[1]), ['Sistema', 'Claro', 'Oscuro'])
    assert.equal(radios.filter((b) => b.includes('aria-checked="true"')).length, 1)
    assert.ok(radios.find((b) => b.includes('aria-checked="true"')).includes(`theme-toggle__option--selected`))
    assert.equal(radios.filter((b) => b.includes('tabindex="0"')).length, 1, 'roving tabindex: one tab stop')
  }
})

test('5. Share exists only for a loaded menu; while loading or on error the selector stays on its own, at the right', () => {
  for (const props of [{ status: 'loading' }, { status: 'error', error: 'x' }, { onShare: undefined }]) {
    const html = actions(ready(props))
    assert.ok(!html.includes('public-menu__share'))
    assert.ok(html.includes('role="radiogroup"'))
  }
})

test('6. the table (QR) menu header keeps its own controls: selector, then the table name; no Share, no new classes', () => {
  const menuView = read('./MenuView.jsx')
  assert.match(menuView, /<ThemeToggle variant="compact" \/>\s*<span className="menu__mesa">\{tableName\}<\/span>/)
  assert.ok(!/public-menu__share|ShareIcon|btn--primary/.test(menuView))
  const toggleCss = read('../../styles/theme-toggle.css')
  const compact = toggleCss.slice(toggleCss.indexOf('.theme-toggle--compact {'))
  assert.match(compact, /^\.theme-toggle--compact \{\s*padding: 2px;\s*background: transparent;\s*border-color: transparent;/)
})

test('7. the new rules are scoped to the public menu: the selector is only restyled under .menu__header--public', () => {
  const themeCss = read('../../styles/theme-toggle.css')
  assert.ok(!/public/.test(themeCss), 'the shared selector stylesheet is untouched')
  const scoped = [...css.matchAll(/(^|\n)([^\n{}@]*theme-toggle[^\n{]*)\{/g)].map((m) => m[2].trim()).filter((s) => !s.startsWith('.menu__header--public'))
  assert.deepEqual(scoped, [], 'no theme-toggle rule outside the public header in index.css')
  assert.match(css, /\.menu__header--public \.theme-toggle__option--selected,\s*\.menu__header--public \.theme-toggle__option--selected:hover \{\s*background: transparent;\s*color: var\(--text\);\s*box-shadow: inset 0 0 0 1px var\(--text-secondary\);/)
})

test('8. Share button CSS: restaurant colours, 1px --primary-ui outline, 40px, no fixed opacity, no outline removed', () => {
  const share = rule('.public-menu__share')
  assert.match(share, /min-height: 40px;/)
  assert.match(share, /border: 1px solid var\(--primary-ui\);/)
  assert.match(share, /width: auto;/)
  assert.ok(!/opacity|outline: none|outline: 0/.test(share))
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgb\(/.test(share), 'colours come only from variables')
  const themeBlock = css.slice(css.indexOf('.menu__header--public .theme-toggle__option {'), css.indexOf('/* ============ Category section'))
  assert.ok(!/opacity|outline: none|outline: 0/.test(themeBlock), 'no fixed opacities on the selector, focus outline kept')
  // the global rules still give keyboard focus a ring (brand-aware) to the share button and the selector options
  assert.match(css, /:root\[data-app="customer"\] :focus-visible \{\s*outline: 2px solid var\(--focus-ring\);/)
  assert.match(read('../../styles/theme-toggle.css'), /\.theme-toggle__option:focus-visible \{\s*outline: 2px solid var\(--focus-ring\);/)
})

test('9. under 360px Share is the icon alone in a 40x40 target and its text stays (visually hidden) as the accessible name', () => {
  const start = css.indexOf('@media (max-width: 359.98px) {\n  .public-menu__share {')
  assert.ok(start >= 0)
  const block = css.slice(start, css.indexOf('/* Theme selector of the public header'))
  assert.match(block, /\.public-menu__share \{\s*width: 40px;\s*padding: 0;\s*\}/)
  const label = block.slice(block.indexOf('.public-menu__share-label'))
  assert.match(label, /position: absolute;[\s\S]*clip: rect\(0 0 0 0\);/)
  assert.ok(!/display: none|visibility: hidden/.test(block), 'never display:none: that would remove the accessible name')
})

test('10. the label column keeps "CARTA DIGITAL" to two lines at most, and the selector gets a taller hit area without moving anything', () => {
  assert.match(rule('.menu__header--public'), /grid-template-columns: minmax\(min-content, 1fr\) auto;/)
  assert.match(rule('.menu__header--public .menu__eyebrow'), /overflow-wrap: normal;/)
  const hit = rule('.menu__header--public .theme-toggle__option::after')
  assert.match(hit, /position: absolute;[\s\S]*top: -6px;[\s\S]*bottom: -6px;/)
})

// Contrast with the real colour functions, for the six restaurant colours the design must survive, in both themes.
const BRANDS = { vino: '#791A3E', 'amarillo claro': '#F2C94C', 'verde claro': '#2ECC71', azul: '#1E6FEB', 'casi negro': '#1A1A1A', 'blanco roto': '#F5F1E8' }

test('11. every restaurant colour: text and icon on the button are AA, and the outline tells the button from the page (>= 3:1)', () => {
  for (const [name, hex] of Object.entries(BRANDS)) {
    for (const theme of ['light', 'dark']) {
      const vars = brandingStyleVars({ primaryColor: hex }, theme)
      const page = surfacesFor(theme).bg
      assert.ok(contrastRatio(vars['--primary-control'], vars['--on-primary-control']) >= 4.5, `${name}/${theme}: text and icon (currentColor) on the button`)
      assert.ok(contrastRatio(vars['--primary-ui'], page) >= 3, `${name}/${theme}: outline against the page`)
    }
  }
})

test('12. the theme selector colours: inactive options (secondary text) are AA on the page, the selected ring is >= 3:1, in both themes', () => {
  const tokens = read('../../styles/tokens.css')
  const value = (selector, name) => {
    const start = tokens.indexOf(`${selector} {`)
    return tokens.slice(start, tokens.indexOf('}', start)).match(new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`))[1]
  }
  for (const [selector, theme] of [[':root', 'light'], [':root[data-theme="dark"]', 'dark']]) {
    const secondary = value(selector, '--text-muted') // --text-secondary is an alias of --text-muted
    const text = value(selector, '--text')
    const bg = surfacesFor(theme).bg
    assert.ok(contrastRatio(secondary, bg) >= 4.5, `${theme}: inactive icons`)
    assert.ok(contrastRatio(text, bg) >= 4.5, `${theme}: selected icon`)
  }
  assert.match(tokens, /--text-secondary: var\(--text-muted\);/)
})
