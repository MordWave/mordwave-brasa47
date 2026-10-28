import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, test } from 'node:test'
import { loadModule } from '../theme/testSupport.js'
import { isPublicMenuPath, parsePublicMenuPath, publicMenuPath, publicMenuUrl } from '../utils/publicMenuRoute.js'

// 9J.1 — the shareable, read-only menu at /menu/<slug>: the link, the page and its states. Real components rendered to static markup.

const LOGO = 'https://api.example.test/media/businesses/11111111-1111-4111-8111-111111111111/logo/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp'
const PHOTO = 'https://api.example.test/media/businesses/11111111-1111-4111-8111-111111111111/products/22222222-2222-4222-8222-222222222222/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp'
const CATEGORIES = [
  { id: 'c1', name: 'Bebidas', slug: 'bebidas', sortOrder: 1 },
  { id: 'c2', name: 'Burgers', slug: 'burgers', sortOrder: 2 },
]
const PRODUCTS = [
  { id: 'p1', categoryId: 'c1', name: 'Limonada', description: 'Menta y jengibre', price: 2500, image: null, tag: null, available: true, sortOrder: 1 },
  { id: 'p2', categoryId: 'c2', name: 'Clásica', description: 'Con queso', price: 6900, image: PHOTO, tag: 'Más pedido', available: true, sortOrder: 1 },
  { id: 'p3', categoryId: 'c2', name: 'Agotada', description: 'Hoy no', price: 12345, image: null, tag: null, available: false, sortOrder: 2 },
]
const BUSINESS = { name: 'Alpha Burgers', slug: 'alpha-burgers', logoUrl: LOGO, coverUrl: null, primaryColor: '#AA3300', accentColor: null }

// ---- the link ---------------------------------------------------------------------------------------------------------------------------
test('1. /menu/<slug> is recognised, with or without a trailing slash; the slug is validated like everywhere else', () => {
  assert.equal(parsePublicMenuPath('/menu/alpha-burgers'), 'alpha-burgers')
  assert.equal(parsePublicMenuPath('/menu/alpha-burgers/'), 'alpha-burgers')
  assert.equal(parsePublicMenuPath('/menu/brasa-47'), 'brasa-47')
  for (const bad of ['/menu', '/menu/', '/menu/AB', '/menu/Alpha-Burgers', '/menu/a/b', '/menu//x', '/menu/%E0%A4%A', '/menu/alpha_burgers', '/menu/' + 'a'.repeat(61), '/admin', '/', '/menus/alpha-burgers', '/x/menu/alpha-burgers']) {
    assert.equal(parsePublicMenuPath(bad), null, bad)
  }
})

test('2. any /menu path is a menu path (so an invalid link shows "not found" instead of the table flow); other paths are not', () => {
  for (const p of ['/menu', '/menu/', '/menu/x', '/menu/alpha-burgers']) assert.equal(isPublicMenuPath(p), true, p)
  for (const p of ['/', '/admin', '/menus', '/menuX', '/x/menu', '/?t=TOKEN_FICTICIO']) assert.equal(isPublicMenuPath(p), false, p)
})

test('3. the link to share is built on the origin of the page and encodes the slug; an invalid slug gives no link', () => {
  assert.equal(publicMenuPath('alpha-burgers'), '/menu/alpha-burgers')
  assert.equal(publicMenuUrl('https://menu.example.test', 'alpha-burgers'), 'https://menu.example.test/menu/alpha-burgers')
  assert.equal(publicMenuUrl('https://menu.example.test/', 'brasa-47'), 'https://menu.example.test/menu/brasa-47')
  for (const bad of ['', 'AB', 'a b', '../x', null, undefined, 5]) {
    assert.equal(publicMenuPath(bad), null)
    assert.equal(publicMenuUrl('https://menu.example.test', bad), null)
  }
  assert.equal(publicMenuUrl('not an origin', 'alpha-burgers'), null)
})

// ---- the page ---------------------------------------------------------------------------------------------------------------------------
let r
before(async () => {
  r = await loadModule(`
    import { renderToStaticMarkup } from 'react-dom/server'
    import ProductTile from './components/customer/ProductTile.jsx'
    import { PublicMenuView, isRestaurantNotFound, NOT_FOUND_TITLE } from './pages/PublicMenuPage.jsx'
    import { ThemeContext } from './theme/themeContext.js'
    const theme = { resolvedTheme: 'light', preference: 'light', systemTheme: 'light', enabled: true, setPreference() {} }
    export const view = (props) => renderToStaticMarkup(<ThemeContext.Provider value={theme}><PublicMenuView {...props} /></ThemeContext.Provider>)
    export const tile = (props) => renderToStaticMarkup(<ProductTile {...props} />)
    export { isRestaurantNotFound, NOT_FOUND_TITLE }
  `)
})
const ready = (extra = {}) => r.view({ status: 'ready', business: BUSINESS, categories: CATEGORIES, products: PRODUCTS, activeCategory: 'c1', onShare() {}, ...extra })
const imgSrcs = (html) => [...html.matchAll(/<img[^>]*\ssrc="([^"]*)"/g)].map((m) => m[1])

test('4. the loaded menu shows the restaurant, its categories in order and each product with name, description and price in CLP', () => {
  const html = ready()
  assert.match(html, /Alpha Burgers/)
  assert.ok(html.indexOf('data-category-id="c1"') < html.indexOf('data-category-id="c2"'), 'categories keep their order')
  for (const text of ['Limonada', 'Menta y jengibre', 'Clásica', 'Con queso', 'Más pedido']) assert.ok(html.includes(text), text)
  for (const price of ['$2.500', '$6.900', '$12.345']) assert.ok(html.includes(price), price)
  // grouped: each product sits inside the section of its category
  const burgers = html.slice(html.indexOf('data-category-id="c2"'))
  assert.ok(burgers.includes('Clásica') && burgers.includes('Agotada') && !burgers.includes('Limonada'))
  assert.match(html, /<h1[^>]*>Menú<\/h1>/)
})

test('5. the menu is read-only: no add-to-cart affordance, no product buttons, tiles are plain cards', () => {
  const html = ready()
  assert.equal((html.match(/<article class="product-tile/g) ?? []).length, 3)
  assert.ok(!/product-tile__add/.test(html), 'no "+" affordance')
  assert.ok(!/<button[^>]*product-tile/.test(html), 'no product button')
  assert.ok(!/Agregar|Carrito|Pedir|Checkout/i.test(html))
  assert.ok(html.includes('No disponible hoy'), 'an unavailable product says so')
})

test('6. the table menu is untouched: its tile is still a button with the add affordance', () => {
  const html = r.tile({ product: PRODUCTS[0], onSelect() {} })
  assert.match(html, /<button class="product-tile"[^>]*type="button"/)
  assert.ok(html.includes('product-tile__add'))
  assert.ok(!html.includes('product-tile--readonly'))
})

test('7. images: only real photos are drawn, a missing one shows the placeholder, only plain http(s) URLs reach an <img>', () => {
  const html = ready()
  assert.deepEqual(imgSrcs(html).filter((s) => s.includes('/products/')), [PHOTO])
  assert.equal((html.match(/Sin foto/g) ?? []).length, 2)
  assert.ok(imgSrcs(html).includes(LOGO))
  const hostile = r.view({
    status: 'ready',
    business: { ...BUSINESS, logoUrl: 'javascript:alert(1)', coverUrl: 'data:image/png;base64,AAAA' },
    categories: CATEGORIES,
    products: PRODUCTS,
  })
  assert.ok(!/javascript:|data:image/.test(hostile))
  assert.ok(!hostile.includes('public-menu__brand'), 'no brand block without a valid logo or cover')
})

test('8. states: loading, retryable error, empty menu and not found', () => {
  assert.match(r.view({ status: 'loading' }), /Cargando el menú/)
  const error = r.view({ status: 'error', error: 'No pudimos cargar el menú.', onRetry() {} })
  assert.match(error, /No pudimos cargar el menú\./)
  assert.match(error, /Reintentar/)
  const empty = r.view({ status: 'ready', business: BUSINESS, categories: CATEGORIES, products: [] })
  assert.match(empty, /Todavía no hay productos publicados/)
  const none = r.view({ status: 'not-found' })
  assert.ok(none.includes(r.NOT_FOUND_TITLE))
  assert.ok(!/Compartir|Reintentar|product-tile/.test(none))
})

test('9. the share button only exists once the menu is ready', () => {
  assert.match(ready(), /Compartir/)
  assert.ok(!/Compartir/.test(r.view({ status: 'loading' })))
  assert.ok(!/Compartir/.test(r.view({ status: 'error', error: 'x' })))
  assert.ok(!/Compartir/.test(ready({ onShare: undefined })))
})

test('10. a restaurant that does not exist (or a link that names none) is a final "not found"; other failures can be retried', () => {
  assert.equal(r.isRestaurantNotFound({ status: 404 }), true)
  assert.equal(r.isRestaurantNotFound({ code: 'BUSINESS_NOT_FOUND' }), true)
  assert.equal(r.isRestaurantNotFound({ code: 'BUSINESS_SLUG_MISSING' }), true)
  for (const e of [{ status: 500 }, { status: 429 }, new Error('network'), null, undefined]) assert.equal(r.isRestaurantNotFound(e), false)
})

// ---- wiring -----------------------------------------------------------------------------------------------------------------------------
test('11. /menu/<slug> is routed to the public page BEFORE the table flow, without any session or cart provider', () => {
  const app = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8')
  assert.ok(app.indexOf('<PublicMenuPage') < app.indexOf('<CustomerApp'))
  const page = readFileSync(new URL('./PublicMenuPage.jsx', import.meta.url), 'utf8')
  for (const forbidden of ['CartProvider', 'cartStore', 'orderApi', 'tableSessionApi', 'AuthContext', 'qrSession', 'localStorage', 'sessionStorage']) {
    assert.ok(!page.includes(forbidden), `PublicMenuPage must not use ${forbidden}`)
  }
  const api = readFileSync(new URL('../services/publicMenuApi.js', import.meta.url), 'utf8')
  assert.match(api, /\/public\/menu\//)
  assert.ok(!/method:|POST|PATCH|DELETE|token/i.test(api), 'a read-only, unauthenticated GET')
})

test('12. the public menu request is only made for a valid slug (nothing is requested for an unknown restaurant)', async () => {
  const { fetchPublicMenu } = await loadModule(`export { fetchPublicMenu } from './services/publicMenuApi.js'`)
  for (const bad of ['', 'AB', '../x', null, undefined]) {
    await assert.rejects(() => fetchPublicMenu(bad), (e) => e.code === 'BUSINESS_SLUG_MISSING')
  }
})
