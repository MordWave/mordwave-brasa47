import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, test } from 'node:test'
import { loadModule } from '../../theme/testSupport.js'

// 9K.11 — legible cards in the shareable menu: one column with the photo on the left up to 719px (9K.14: it was 639px), the current grid
// from 720px. Every new
// rule is scoped to the read-only tile; the table (QR) menu keeps its own tile, "+" button included.

const css = readFileSync(new URL('../../styles/index.css', import.meta.url), 'utf8')
const START = css.indexOf('/* ---- Legible cards of the shareable menu (9K.11)')
const NEW_BLOCK = css.slice(START, css.indexOf('/* ============', START) === -1 ? undefined : css.indexOf('/* ============', START))
const rules = (block) => [...block.matchAll(/(^|\n)(\s*)([^\n{}@/*][^\n{}]*)\{([^}]*)\}/g)].map((m) => ({ selector: m[3].trim(), body: m[4] }))
const find = (block, selector) => {
  const found = rules(block).filter((r) => r.selector === selector)
  assert.ok(found.length, `${selector} rule exists`)
  return found.map((r) => r.body).join('\n')
}
const media = (query) => {
  const at = NEW_BLOCK.indexOf(`@media (${query}) {`)
  assert.ok(at >= 0, `@media (${query}) exists`)
  let depth = 0
  for (let i = NEW_BLOCK.indexOf('{', at); i < NEW_BLOCK.length; i += 1) {
    if (NEW_BLOCK[i] === '{') depth += 1
    if (NEW_BLOCK[i] === '}' && --depth === 0) return NEW_BLOCK.slice(NEW_BLOCK.indexOf('{', at) + 1, i)
  }
  throw new Error('unbalanced media block')
}

const PRODUCT = { id: 'p1', categoryId: 'c1', name: 'Clásica Brasa', description: 'Con queso', price: 6900, image: null, tag: 'Recomendado', available: true, sortOrder: 1 }
let r
before(async () => {
  r = await loadModule(`
    import { renderToStaticMarkup } from 'react-dom/server'
    import ProductTile from './components/customer/ProductTile.jsx'
    export const tile = (props) => renderToStaticMarkup(<ProductTile {...props} />)
  `)
})

test('1. the new block exists and EVERY selector in it is scoped to the read-only tile or the public menu', () => {
  assert.ok(START > 0 && NEW_BLOCK.length > 500)
  const all = [...rules(NEW_BLOCK), ...rules(media('min-width: 720px')), ...rules(media('max-width: 719.98px')), ...rules(media('max-width: 359.98px'))]
  assert.ok(all.length >= 15)
  for (const { selector } of all) assert.match(selector, /^(\.product-tile--readonly\b|\.public-menu \.product-grid$)/, selector)
})

test('2. the shared tile rules (used by the table menu) are exactly the ones they were: names cut in one line, descriptions in one', () => {
  const name = css.slice(css.indexOf('.product-tile__name {'), css.indexOf('}', css.indexOf('.product-tile__name {')))
  assert.match(name, /font-size: 14px;[\s\S]*overflow: hidden;\s*text-overflow: ellipsis;\s*white-space: nowrap;/)
  const desc = css.slice(css.indexOf('.product-tile__desc {'), css.indexOf('}', css.indexOf('.product-tile__desc {')))
  assert.match(desc, /font-size: 11\.5px;[\s\S]*-webkit-line-clamp: 1;/)
  assert.match(css, /\.product-grid \{\s*display: grid;\s*grid-template-columns: repeat\(2, 1fr\);\s*gap: 12px;\s*\}/)
  const media = css.slice(css.indexOf('.product-tile__media {'), css.indexOf('}', css.indexOf('.product-tile__media {')))
  assert.match(media, /aspect-ratio: 1 \/ 1;/)
  const footer = css.slice(css.indexOf('.product-tile__footer {'), css.indexOf('}', css.indexOf('.product-tile__footer {')))
  assert.match(footer, /margin-top: auto;/)
})

test('3. the markup of both tiles is untouched: the shareable one is a read-only <article>, the table one a button with "+"', () => {
  const shared = r.tile({ product: PRODUCT, onSelect() {}, readOnly: true })
  assert.match(shared, /^<article class="product-tile product-tile--readonly">/)
  assert.ok(!/<button|product-tile__add/.test(shared))
  assert.match(shared, /<h3 class="product-tile__name">Clásica Brasa<\/h3><p class="product-tile__desc">Con queso<\/p><div class="product-tile__footer"><span class="product-tile__price">\$6\.900<\/span><\/div>/)
  const table = r.tile({ product: PRODUCT, onSelect() {} })
  assert.match(table, /^<button class="product-tile" type="button">/)
  assert.ok(table.includes('<span class="product-tile__add" aria-hidden="true">+</span>'))
  assert.ok(!table.includes('product-tile--readonly'))
})

test('4. names are never cut: they wrap, long words break, and nothing in the new rules truncates or clamps a name', () => {
  const names = [...rules(NEW_BLOCK), ...rules(media('min-width: 720px')), ...rules(media('max-width: 719.98px'))].filter((x) => x.selector === '.product-tile--readonly .product-tile__name')
  assert.ok(names.length >= 3)
  const joined = names.map((x) => x.body).join('\n')
  assert.match(joined, /white-space: normal;/)
  assert.match(joined, /overflow: visible;/)
  assert.match(joined, /overflow-wrap: anywhere;/)
  assert.ok(!/line-clamp|nowrap|overflow: hidden|text-overflow: ellipsis/.test(joined))
})

test('5. descriptions: up to three lines, long words break; 13px on every screen size', () => {
  const base = find(NEW_BLOCK.slice(0, NEW_BLOCK.indexOf('@media')), '.product-tile--readonly .product-tile__desc')
  assert.match(base, /-webkit-line-clamp: 3;/)
  assert.match(base, /overflow-wrap: anywhere;/)
  for (const query of ['min-width: 720px', 'max-width: 719.98px']) assert.match(find(media(query), '.product-tile--readonly .product-tile__desc'), /font-size: 13px;[\s\S]*line-height: 1\.4;/)
})

test('6. up to 719px: one column and a horizontal card (photo left, text right); square photo 112px (92px under 360px) that never grows with the text; cover, never stretched', () => {
  const phone = media('max-width: 719.98px')
  assert.match(find(phone, '.public-menu .product-grid'), /grid-template-columns: 1fr;[\s\S]*gap: 12px;/)
  assert.match(find(phone, '.product-tile--readonly'), /flex-direction: row;/)
  const photo = find(phone, '.product-tile--readonly .product-tile__media')
  assert.match(photo, /flex: none;\s*align-self: flex-start;\s*width: 112px;\s*height: 112px;/)
  assert.ok(!/min-height|aspect-ratio/.test(photo), 'the photo box never grows with the text')
  assert.match(find(NEW_BLOCK.slice(NEW_BLOCK.indexOf('@media (max-width: 359.98px)')), '.product-tile--readonly .product-tile__media'), /width: 92px;\s*height: 92px;/)
  // the shared image rule (object-fit: cover, full size of its box) is untouched, so a photo is cropped, not deformed
  const img = css.slice(css.indexOf('.product-tile__media img {'), css.indexOf('}', css.indexOf('.product-tile__media img {')))
  assert.match(img, /width: 100%;\s*height: 100%;\s*object-fit: cover;/)
  assert.ok(!/object-fit/.test(NEW_BLOCK.replace(/\/\*[\s\S]*?\*\//g, '')), 'no rule of the block changes how the photo is fitted')
})

test('7. the price stays at the end of the card and is easy to read: 17px on phones, 18px on wide screens', () => {
  assert.match(find(media('max-width: 719.98px'), '.product-tile--readonly .product-tile__price'), /font-size: 17px;/)
  assert.match(find(media('min-width: 720px'), '.product-tile--readonly .product-tile__price'), /font-size: 18px;/)
  assert.ok(!/\.product-tile__footer[^{]*\{[^}]*margin-top/.test(NEW_BLOCK), 'the shared margin-top: auto of the footer is not overridden')
})

test('8. wide screens keep the grid: no change of columns, gap or photo size from 720px', () => {
  const wide = media('min-width: 720px')
  assert.ok(!/grid-template-columns|\.product-grid|aspect-ratio|flex-direction/.test(wide))
  assert.ok(!/\.product-grid/.test(NEW_BLOCK.slice(0, NEW_BLOCK.indexOf('@media (max-width: 719.98px)'))))
})

test('9. the tag stays inside the photo box and wraps instead of being cut (it never overlaps the text)', () => {
  const tag = find(media('max-width: 719.98px'), '.product-tile--readonly .product-tile__tag')
  assert.match(tag, /max-width: calc\(100% - 16px\);/)
  assert.match(tag, /white-space: normal;/)
  assert.ok(!/text-overflow|nowrap/.test(tag))
  const small = find(NEW_BLOCK.slice(NEW_BLOCK.indexOf('@media (max-width: 359.98px)')), '.product-tile--readonly .product-tile__tag')
  assert.match(small, /font-size: 9px;[\s\S]*letter-spacing: 0;/)
  assert.match(small, /max-width: calc\(100% - 10px\);/)
  // the tag lives inside .product-tile__media (overflow: hidden), which is a separate column from the text on phones
  assert.match(r.tile({ product: PRODUCT, onSelect() {}, readOnly: true }), /<div class="product-tile__media">[\s\S]*<span class="product-tile__tag">Recomendado<\/span><\/div><div class="product-tile__body">/)
})

test('10. the breakpoints agree: phones and small tablets up to 719.98px, wide from 720px, small phones up to 359.98px (no gap, no overlap)', () => {
  assert.equal((NEW_BLOCK.match(/@media \(min-width: 720px\)/g) ?? []).length, 1)
  assert.equal((NEW_BLOCK.match(/@media \(max-width: 719\.98px\)/g) ?? []).length, 1)
  assert.equal((NEW_BLOCK.match(/@media \(max-width: 359\.98px\)/g) ?? []).length, 1)
  // the same 359.98px / 360px limit as the header's icon-only Share
  assert.match(css, /@media \(max-width: 359\.98px\) \{\s*\.public-menu__share \{/)
})

test('11. the table menu cannot be reached by the new rules: its tile has no .product-tile--readonly and no .public-menu ancestor', () => {
  const menuView = readFileSync(new URL('./MenuView.jsx', import.meta.url), 'utf8')
  assert.ok(!/product-tile--readonly|public-menu|readOnly/.test(menuView))
  const menuScreen = readFileSync(new URL('./MenuScreen.jsx', import.meta.url), 'utf8')
  assert.match(menuScreen, /<ProductTile key=\{product\.id\} product=\{product\} onSelect=\{onSelectProduct\} readOnly=\{readOnly\} \/>/)
  const page = readFileSync(new URL('../../pages/PublicMenuPage.jsx', import.meta.url), 'utf8')
  assert.match(page, /className="customer-app public-menu"/)
})

test('12. 9K.14: the cards switch to the grid at 720px, the same width where the app already goes to three columns; the header keeps its 640px query', () => {
  // no query of the cards block is left at 640px / 639.98px: the 640-719px band no longer gets two columns of 292px+ photos
  assert.ok(!/640px|639\.98px/.test(NEW_BLOCK.replace(/\/\*[\s\S]*?\*\//g, '')))
  // the app's own grid rule (3 columns from 720px, 4 from 980px) is unchanged and agrees with the cards breakpoint
  assert.match(css, /@media \(min-width: 720px\) \{\s*\.menu \{[\s\S]*?\.product-grid \{\s*grid-template-columns: repeat\(3, 1fr\);\s*gap: 16px;/)
  assert.match(css, /@media \(min-width: 980px\) \{\s*\.product-grid \{\s*grid-template-columns: repeat\(4, 1fr\);/)
  // the single column of the phone block (specificity .public-menu .product-grid) beats the base two columns, and stops at 719.98px
  assert.match(css, /\.product-grid \{\s*display: grid;\s*grid-template-columns: repeat\(2, 1fr\);\s*gap: 12px;/)
  // the header / Share / theme selector breakpoints are not touched
  assert.match(css, /@media \(min-width: 640px\) \{\s*\.menu__header--public \{/)
  assert.match(css, /@media \(max-width: 359\.98px\) \{\s*\.public-menu__share \{/)
})
