import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, test } from 'node:test'
import { loadModule } from '../../theme/testSupport.js'

// 9K.2 — the category bar: the shareable menu gets the scrollable, accessible bar; the table (QR) menu keeps exactly the one it had.

const CATEGORIES = [
  { id: 'c1', name: 'Hamburguesas', slug: 'hamburguesas', sortOrder: 1 },
  { id: 'c2', name: 'Pizzas', slug: 'pizzas', sortOrder: 2 },
  { id: 'c3', name: 'Bebidas', slug: 'bebidas', sortOrder: 3 },
  { id: 'c4', name: 'Acompañamientos', slug: 'acompanamientos', sortOrder: 4 },
  { id: 'c5', name: 'Postres', slug: 'postres', sortOrder: 5 },
  { id: 'c6', name: 'cafes', slug: 'cafes', sortOrder: 6 },
]
// only the first three have products: the last three are the empty test categories
const PRODUCTS = ['c1', 'c2', 'c3'].map((categoryId, i) => ({ id: `p${i}`, categoryId, name: `Producto ${i}`, description: '', price: 1000, image: null, tag: null, available: true, sortOrder: 1 }))

let r
before(async () => {
  r = await loadModule(`
    import { renderToStaticMarkup } from 'react-dom/server'
    import CategoryTabs from './components/customer/CategoryTabs.jsx'
    import MenuScreen from './components/customer/MenuScreen.jsx'
    export const tabs = (props) => renderToStaticMarkup(<CategoryTabs {...props} />)
    export const screen = (props) => renderToStaticMarkup(<MenuScreen status="ready" {...props} />)
  `)
})
const props = { categories: CATEGORIES, activeId: 'c2', onSelect() {} }
const buttons = (html) => [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0])

test('1. the table menu bar is unchanged: one <nav>, plain buttons, no wrapper, no aria-current', () => {
  const html = r.tabs(props)
  assert.ok(html.startsWith('<nav class="menu-nav" aria-label="Categorías del menú"><button class="menu-nav__item" type="button">'))
  assert.ok(html.includes('<button class="menu-nav__item menu-nav__item--active" type="button">'))
  assert.equal(buttons(html).length, 6)
  assert.ok(!/aria-current|menu-nav-wrap|menu-nav--scroller|data-menu-nav/.test(html))
})

test('2. the shareable menu bar is a sticky wrapper around a scrollable <nav>, with all six categories (empty ones included)', () => {
  const html = r.tabs({ ...props, enhanced: true })
  assert.ok(html.startsWith('<div class="menu-nav-wrap" data-menu-nav="">'))
  assert.match(html, /<nav class="menu-nav menu-nav--scroller" aria-label="Categorías del menú">/)
  assert.equal(buttons(html).length, 6)
  for (const name of ['Hamburguesas', 'Pizzas', 'Bebidas', 'Acompañamientos', 'Postres', 'cafes']) assert.ok(html.includes(`<span>${name}</span>`), name)
})

test('3. accessibility: only the active tab says aria-current, the fades start hidden and are not announced', () => {
  const html = r.tabs({ ...props, enhanced: true })
  assert.equal((html.match(/aria-current="true"/g) ?? []).length, 1)
  assert.match(html, /<button class="menu-nav__item menu-nav__item--active" type="button" aria-current="true">/)
  assert.ok(!/menu-nav-wrap--more/.test(html), 'no fade until the bar measures its own overflow')
  assert.ok(!r.tabs({ ...props, enhanced: true, activeId: null }).includes('aria-current'))
})

test('4. only the shareable menu (readOnly) gets the enhanced bar; the table menu screen keeps the original', () => {
  const shared = r.screen({ categories: CATEGORIES, products: PRODUCTS, activeCategory: 'c1', readOnly: true })
  const table = r.screen({ categories: CATEGORIES, products: PRODUCTS, activeCategory: 'c1', onSelectProduct() {} })
  assert.ok(shared.includes('menu-nav-wrap') && shared.includes('aria-current="true"'))
  assert.ok(!table.includes('menu-nav-wrap') && !table.includes('aria-current'))
  assert.ok(table.includes('<nav class="menu-nav" aria-label="Categorías del menú">'))
})

test('5. empty categories keep their tab but have no section (nothing to scroll to)', () => {
  const html = r.screen({ categories: CATEGORIES, products: PRODUCTS, activeCategory: 'c1', readOnly: true })
  assert.deepEqual([...html.matchAll(/data-category-id="([^"]+)"/g)].map((m) => m[1]), ['c1', 'c2', 'c3'])
  assert.equal(buttons(html).filter((b) => b.includes('menu-nav__item')).length, 6)
})

// ---- wiring (source-level: effects and scrolling are exercised in a real browser, see the PR) ------------------------------------------
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('6. the public page uses the scroll tracking; the table menu keeps its own and does not use the new hook or bar', () => {
  assert.match(read('../../pages/PublicMenuPage.jsx'), /useCategoryScrollSpy\(/)
  const tableMenu = read('./MenuView.jsx')
  assert.ok(!tableMenu.includes('useCategoryScrollSpy') && !tableMenu.includes('enhanced'))
  assert.ok(tableMenu.includes('IntersectionObserver'), 'the table menu keeps its own observer, untouched')
})

test('7. the bar scrolls only itself (scrollTo on the bar, never scrollIntoView); the page scroll respects reduced motion', () => {
  const tabs = read('./CategoryTabs.jsx')
  assert.ok(tabs.includes('.scrollTo(') && !tabs.includes('scrollIntoView'))
  assert.ok(tabs.includes('scrollBehavior()'))
  const hook = read('../../hooks/useCategoryScrollSpy.js')
  assert.ok(hook.includes('behavior: scrollBehavior()'))
  const nav = read('../../utils/categoryNav.js')
  assert.match(nav, /prefers-reduced-motion: reduce/)
  assert.match(nav, /prefersReducedMotion\(\) \? 'auto' : 'smooth'/)
})

test('8. the scroll tracking hands the highlight back on any scroll by the visitor, and its listeners are passive and removed', () => {
  const hook = read('../../hooks/useCategoryScrollSpy.js')
  for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown']) assert.ok(hook.includes(`'${type}'`), type)
  assert.match(hook, /addEventListener\('scroll', schedule, \{ passive: true \}\)/)
  assert.match(hook, /removeEventListener\('scroll', schedule\)/)
  assert.match(hook, /cancelAnimationFrame\(frame\)/)
})

test('9. the stylesheet keeps the bar from chaining its horizontal scroll to the page and calms the fade for reduced motion', () => {
  const css = read('../../styles/index.css')
  assert.match(css, /\.menu-nav--scroller \{[^}]*overscroll-behavior-x: contain;/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.menu-nav-wrap::before,\s*\.menu-nav-wrap::after \{\s*transition: none;/)
  assert.match(css, /\.menu-nav-wrap--more-start::before,\s*\.menu-nav-wrap--more-end::after \{\s*opacity: 1;/)
  assert.match(css, /\.menu-nav \{\s*position: sticky;/, 'the original bar rule is still there for the table menu')
})
