import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, test } from 'node:test'
import { loadModule } from '../../theme/testSupport.js'

// 9K.5 — header of the shareable menu: the restaurant's name is the title, "Carta digital" the small label above it. The table (QR) menu
// header and the admin preview keep theirs.

const CATEGORIES = [{ id: 'c1', name: 'Bebidas', slug: 'bebidas', sortOrder: 1 }]
const PRODUCTS = [{ id: 'p1', categoryId: 'c1', name: 'Limonada', description: '', price: 2500, image: null, tag: null, available: true, sortOrder: 1 }]
const LONG_NAME = 'Parrilla y Cocina Artesanal Don Anselmo de los Valles Centrales'
const LONG_WORD = 'Supercalifragilisticoespialidosoextraordinariamenteexquisitos'

let r
before(async () => {
  r = await loadModule(`
    import { renderToStaticMarkup } from 'react-dom/server'
    import MenuScreen from './components/customer/MenuScreen.jsx'
    export const screen = (props) => renderToStaticMarkup(<MenuScreen categories={[]} products={[]} {...props} headerActions={<button type="button">Acción</button>} />)
  `)
})
const shared = (props = {}) => r.screen({ readOnly: true, status: 'ready', categories: CATEGORIES, products: PRODUCTS, ...props })
const h1s = (html) => [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map((m) => m[1])
const header = (html) => html.match(/<header[\s\S]*?<\/header>/)[0]

test('1. the restaurant name (from the API, never written in the component) is the one h1; "Carta digital" is a secondary label above it', () => {
  for (const name of ['Alpha Burgers', 'Beta Pizza', 'Café Ñandú']) {
    const html = shared({ businessName: name })
    assert.deepEqual(h1s(html), [name])
    const head = header(html)
    assert.ok(head.startsWith('<header class="menu__header menu__header--public">'))
    assert.match(head, /<p class="menu__eyebrow">Carta digital<\/p><h1 class="menu__title">/)
    assert.ok(!/<h[2-6]/.test(head) && !head.includes('Menú'), 'the label is a paragraph, and "Menú" is no longer the title')
  }
})

test('2. reading order is label, title, actions (the grid, not the DOM, puts the actions on the first row on phones)', () => {
  const head = header(shared({ businessName: 'Alpha Burgers' }))
  assert.ok(head.indexOf('Carta digital') < head.indexOf('<h1') && head.indexOf('<h1') < head.indexOf('menu__header-actions'))
  assert.match(head, /<div class="menu__header-actions"><button type="button">Acción<\/button><\/div><\/header>$/)
})

test('3. while the name is unknown (loading, error) the title is the neutral "Menú": no restaurant is invented', () => {
  for (const props of [{ status: 'loading' }, { status: 'error', error: 'No pudimos cargar el menú.' }]) {
    const html = r.screen({ readOnly: true, ...props })
    assert.deepEqual(h1s(html), ['Menú'])
    assert.ok(header(html).includes('Carta digital'))
    assert.ok(!html.includes('Nuestro restaurante'), 'no placeholder restaurant name either')
  }
  assert.deepEqual(h1s(shared({ businessName: '' })), ['Menú'])
  assert.deepEqual(h1s(shared({ businessName: undefined })), ['Menú'])
  // a loaded menu without products still names the restaurant
  assert.deepEqual(h1s(r.screen({ readOnly: true, status: 'ready', businessName: 'Alpha Burgers' })), ['Alpha Burgers'])
})

test('4. there is exactly one h1 in every state of the shareable menu', () => {
  const states = [
    shared({ businessName: 'Alpha Burgers' }),
    r.screen({ readOnly: true, status: 'loading' }),
    r.screen({ readOnly: true, status: 'error', error: 'x' }),
    r.screen({ readOnly: true, status: 'ready', businessName: 'Alpha Burgers' }),
  ]
  for (const html of states) assert.equal((html.match(/<h1[ >]/g) ?? []).length, 1)
})

test('5. a long name and an extremely long word are rendered whole (wrapped by CSS, never cut); hostile names are escaped', () => {
  for (const name of [LONG_NAME, LONG_WORD, `${LONG_NAME} ${LONG_WORD}`]) {
    assert.deepEqual(h1s(shared({ businessName: name })), [name])
  }
  const hostile = h1s(shared({ businessName: '<img src=x onerror=alert(1)> & "Co."' }))
  assert.deepEqual(hostile, ['&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Co.&quot;'])
})

test('6. the table (QR) menu header is exactly what it was: business name as the small label, "Menú" as the title, same wrapper', () => {
  const html = r.screen({ status: 'ready', categories: CATEGORIES, products: PRODUCTS, businessName: 'Alpha Burgers', onSelectProduct() {} })
  assert.ok(
    header(html).startsWith(
      '<header class="menu__header"><div class="menu__header-text"><p class="menu__eyebrow">Alpha Burgers</p><h1 class="menu__title">Menú</h1></div><div class="menu__header-actions">',
    ),
  )
  assert.ok(!html.includes('menu__header--public') && !html.includes('Carta digital'))
  // no name yet: still the QR menu's own placeholder
  assert.ok(header(r.screen({ status: 'loading' })).includes('<p class="menu__eyebrow">Nuestro restaurante</p>'))
})

// ---- wiring and stylesheet (the layout itself is verified in a real browser at 320, 375 and 1280 px, see the PR) ---------------------------
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const rule = (css, selector) => {
  const start = css.indexOf(`${selector} {`)
  assert.ok(start >= 0, `${selector} rule exists`)
  return css.slice(start, css.indexOf('}', start))
}

test('7. no restaurant is written in the components, and the page keeps passing the API name to the screen', () => {
  for (const file of ['./MenuScreen.jsx', '../../pages/PublicMenuPage.jsx']) assert.ok(!/brasa/i.test(read(file)), file)
  assert.match(read('../../pages/PublicMenuPage.jsx'), /businessName=\{business\?\.name\}/)
})

test('8. the stylesheet: label and actions share the first row on phones, one compact row from 640px, the name wraps and is never truncated', () => {
  const css = read('../../styles/index.css')
  const header = rule(css, '.menu__header--public')
  assert.match(header, /grid-template-columns: minmax\(0, 1fr\) auto;/)
  assert.match(header, /'label actions'\s*'title title';/)
  const title = rule(css, '.menu__header--public .menu__title')
  assert.match(title, /font-size: 30px;/)
  assert.match(title, /overflow-wrap: anywhere;/)
  assert.match(title, /min-width: 0;/)
  for (const forbidden of ['text-overflow', 'line-clamp', 'white-space: nowrap', 'overflow: hidden']) assert.ok(!title.includes(forbidden), forbidden)
  const wide = css.slice(css.indexOf('@media (min-width: 640px) {\n  .menu__header--public'))
  assert.match(wide, /'label actions'\s*'title actions';/)
  assert.match(wide, /\.menu__header--public \.menu__title \{\s*font-size: 28px;/)
})

test('9. the original header rules (table menu, admin preview) are untouched', () => {
  const css = read('../../styles/index.css')
  assert.match(rule(css, '.menu__header'), /display: flex;\s*align-items: flex-end;\s*justify-content: space-between;\s*gap: 12px;\s*padding: 20px 20px 14px;/)
  assert.match(rule(css, '.menu__title'), /font-size: 26px;\s*margin-top: 2px;/)
})
