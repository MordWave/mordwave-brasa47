import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, test } from 'node:test'
import { loadModule } from '../../theme/testSupport.js'
import { getCategoryIcon } from '../../utils/categoryIcons.js'
import { getPublicCategoryIcon } from '../../utils/publicCategoryIcons.js'

// 9K.16 — the category dropdown of the shareable menu on phones. The bar stays for 640px and up and in the table (QR) menu.

const css = readFileSync(new URL('../../styles/index.css', import.meta.url), 'utf8')
const START = css.indexOf('/* ============ Category dropdown of the shareable menu')
const BLOCK = css.slice(START)
const source = readFileSync(new URL('./CategoryTabs.jsx', import.meta.url), 'utf8')
const CATEGORIES = [
  { id: 'c1', name: 'Hamburguesas', slug: 'hamburguesas' },
  { id: 'c2', name: 'Pizzas', slug: 'pizzas' },
  { id: 'c3', name: 'Cafés', slug: 'cafes' },
]

let r
before(async () => {
  r = await loadModule(`
    import { renderToStaticMarkup } from 'react-dom/server'
    import CategoryTabs from './components/customer/CategoryTabs.jsx'
    export const tabs = (props) => renderToStaticMarkup(<CategoryTabs {...props} />)
  `)
})
const props = { categories: CATEGORIES, activeId: 'c2', onSelect() {} }

test('1. the shareable menu renders the bar AND a closed dropdown that names the active category; nothing is listed until it opens', () => {
  const html = r.tabs({ ...props, enhanced: true })
  assert.match(html, /<button type="button" class="menu-picker__trigger" aria-expanded="false" aria-label="Categorías: Pizzas" title="Pizzas">/)
  assert.match(html, /<span class="menu-picker__current">Pizzas<\/span>/)
  assert.ok(!html.includes('menu-picker__list') && !html.includes('menu-picker__option'))
  assert.ok(html.includes('menu-nav--scroller'), 'the bar is still there (it is what 640px and up show)')
})

test('2. the table (QR) menu bar is untouched: no dropdown markup, no wrapper', () => {
  const html = r.tabs(props)
  assert.ok(!html.includes('menu-picker'))
  assert.ok(html.startsWith('<nav class="menu-nav" aria-label="Categorías del menú">'))
})

test('3. it is a custom disclosure, not a native <select> (every option carries its icon) and it is navigation, not a filter', () => {
  assert.ok(!/<select|<option/.test(source.replace(/^\s*\/\/.*$/gm, '')))
  assert.match(source, /onClick=\{\(\) => choose\(cat\.id\)\}/)
  assert.match(source, /const choose = \(id\) => \{\s*onSelect\(id\)\s*close\(true\)/)
  // trigger and options share one icon resolver
  assert.ok((source.match(/getPublicCategoryIcon\(/g) ?? []).length >= 2)
})

test('4. the scroll-spy is reused, not copied: the dropdown only calls onSelect and never scrolls or listens to scrolling itself', () => {
  const dropdown = source.slice(source.indexOf('function CategoryDropdown'), source.indexOf('function ScrollableCategoryTabs') === -1 ? undefined : source.indexOf('// The bar of the shareable menu'))
  assert.ok(!/useCategoryScrollSpy|scrollIntoView|scrollTo\(|'scroll'|requestAnimationFrame/.test(dropdown))
  assert.ok(!/useCategoryScrollSpy/.test(source))
})

test('5. keyboard and focus: Escape closes and gives the focus back, arrows/Home/End move between options, Tab out or a tap outside closes', () => {
  for (const needle of ["event.key === 'Escape'", 'ArrowDown', 'ArrowUp', 'Home', 'End', "'focusin'", "'pointerdown'", 'aria-expanded={open}', 'aria-current={cat.id === active.id']) assert.ok(source.includes(needle), needle)
  assert.match(source, /preventScroll: true/)
  assert.match(css, /\.menu-picker__trigger:focus-visible,\s*\.menu-picker__option:focus-visible \{\s*outline: 2px solid var\(--primary-ui\);/)
})

test('6. only phones see it: hidden by default, shown (and the bar hidden) only under 640px', () => {
  assert.match(BLOCK, /\.menu-picker \{\s*display: none;\s*\}/)
  const media = BLOCK.slice(BLOCK.indexOf('@media (max-width: 639.98px) {'))
  assert.match(media, /\.menu-nav--scroller,\s*\.menu-nav-wrap::before,\s*\.menu-nav-wrap::after \{\s*display: none;/)
  assert.match(media, /\.menu-picker \{\s*display: block;/)
  // the rule that hides the bar exists only inside that media query
  const outside = BLOCK.slice(0, BLOCK.indexOf('@media (max-width: 639.98px) {'))
  assert.ok(!/menu-nav--scroller/.test(outside))
})

test('7. opening it moves nothing: the list is absolutely positioned under the sticky wrapper and scrolls inside when it is tall', () => {
  assert.match(BLOCK, /\.menu-picker__list \{\s*position: absolute;[\s\S]*?overflow-y: auto;/)
  assert.match(source, /setMaxHeight\(Math\.max\(120, Math\.floor\(window\.innerHeight - root\.current\.getBoundingClientRect\(\)\.bottom - 12\)\)\)/)
})

test('8. the section offset matches the sticky height of the dropdown row, for the public menu only', () => {
  assert.match(BLOCK, /\.public-menu \.menu-section \{\s*scroll-margin-top: 58px;/)
  assert.match(css, /\.menu-section \{\s*scroll-margin-top: 52px;/)
})

test('9. every selector of the new block belongs to the dropdown, the enhanced bar wrapper or the public menu', () => {
  const selectors = [...BLOCK.matchAll(/(^|\n)\s*([^\n{}@/*][^\n{}]*)\{/g)].map((m) => m[2].trim()).join(',').split(',').map((s) => s.trim()).filter((x) => x && !x.startsWith('@media'))
  assert.ok(selectors.length >= 12)
  for (const s of selectors) assert.match(s, /^(\.menu-picker|\.menu-nav--scroller|\.menu-nav-wrap::(before|after)|\.public-menu \.menu-section)/, s)
})

// ---- icons, width and accessibility -------------------------------------------------------------------------------------------------------------------------

const icons = readFileSync(new URL('./Icons.jsx', import.meta.url), 'utf8')
const iconNames = [...icons.slice(0, icons.indexOf('export function CategoryIcon')).matchAll(/^ {2}(\w+): \(/gm)].map((m) => m[1])

test('10. icons: known categories keep the icon of the shared mapping; others get a fitting one; the rest a neutral one, never the burger', () => {
  for (const slug of ['especialidades', 'hamburguesas', 'pizzas', 'acompanamientos', 'bebidas', 'postres']) assert.equal(getPublicCategoryIcon({ slug, name: slug }), getCategoryIcon(slug), slug)
  const icon = (slug, name) => getPublicCategoryIcon({ slug, name })
  assert.equal(icon('cafes', 'Cafés'), 'coffee')
  assert.equal(icon('cafe-y-te', 'Café y té'), 'coffee')
  assert.equal(icon('cervezas', 'Cervezas'), 'beer')
  assert.equal(icon('vinos', 'Vinos'), 'wine')
  assert.equal(icon('ensaladas', 'Ensaladas'), 'bowl')
  assert.equal(icon('pastas', 'Pastas'), 'bowl')
  assert.equal(icon('pizzas-familiares', 'Pizzas familiares'), 'pizza')
  // custom categories: neutral, not a burger
  for (const [slug, name] of [['entradas', 'Entradas'], ['menu-infantil', 'Menú infantil'], ['zzz', 'Cosas raras'], [undefined, undefined]]) assert.equal(icon(slug, name), 'dish', String(slug))
})

test('11. every icon name the dropdown can return is drawn in Icons.jsx (no silent burger fallback inside CategoryIcon)', () => {
  const stems = ['coffee', 'beer', 'wine', 'bowl', 'dish', 'burger', 'pizza', 'fries', 'drink', 'dessert', 'star']
  for (const name of stems) assert.ok(iconNames.includes(name), name)
  for (const name of ['cafes', 'cervezas', 'vinos', 'pastas', 'entradas', 'menu-infantil', 'zzz', 'hamburguesas', 'pizzas', 'bebidas', 'postres', 'acompanamientos', 'especialidades']) assert.ok(iconNames.includes(getPublicCategoryIcon({ slug: name, name })), name)
})

test('12. the shared mapping and the table (QR) menu are untouched: the old fallback stays, the QR files do not know the new resolver or icons', () => {
  const shared = readFileSync(new URL('../../utils/categoryIcons.js', import.meta.url), 'utf8')
  assert.match(shared, /return ICON_BY_SLUG\[slug\] \?\? 'burger'/)
  assert.ok(!/coffee|beer|wine|bowl|dish/.test(shared))
  assert.equal(getCategoryIcon('cafes'), 'burger', 'the QR menu keeps its fallback')
  for (const file of ['MenuView.jsx', 'MenuScreen.jsx']) assert.ok(!/publicCategoryIcons/.test(readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')), file)
  // the plain (QR) bar still uses the shared mapping
  assert.match(source, /<CategoryIcon name=\{getCategoryIcon\(category\.slug\)\} size=\{15\} \/>/)
})

test('13. width: it fills a small phone but stops at 420px (trigger and list), inside the full-width sticky wrapper', () => {
  assert.match(BLOCK, /\.menu-picker__trigger \{[^}]*width: 100%;\s*max-width: 420px;/)
  assert.match(BLOCK, /\.menu-picker__list \{[^}]*left: 20px;\s*right: 20px;\s*max-width: 420px;/)
  assert.match(BLOCK, /\.menu-picker \{\s*display: block;\s*padding: 6px 20px;/)
})

test('14. accessibility: the accessible name has the full category name even when it is cut visually; one Tab stop inside the list; no extra ARIA roles', () => {
  const long = 'Menú infantil especial para los más pequeños de la casa'
  const html = r.tabs({ categories: [{ id: 'c1', name: long, slug: 'infantil' }], activeId: 'c1', onSelect() {}, enhanced: true })
  assert.ok(html.includes(`aria-label="Categorías: ${long}"`) && html.includes(`title="${long}"`))
  assert.match(BLOCK, /\.menu-picker__current \{[^}]*text-overflow: ellipsis;/)
  assert.match(source, /tabIndex=\{cat\.id === \(tabStop \?\? active\.id\) \? 0 : -1\}/)
  assert.match(source, /onFocus=\{\(\) => setTabStop\(cat\.id\)\}/)
  assert.ok(!/role=/.test(source.replace(/^\s*\/\/.*$/gm, '')), 'plain button/list/nav semantics, no role attributes')
})

test('15. robustness: no categories renders nothing instead of throwing; it closes when the window grows past 640px', () => {
  assert.doesNotThrow(() => r.tabs({ categories: [], activeId: null, onSelect() {}, enhanced: true }))
  assert.match(source, /if \(!active\) return null/)
  assert.match(source, /window\.matchMedia\('\(min-width: 640px\)'\)/)
})
