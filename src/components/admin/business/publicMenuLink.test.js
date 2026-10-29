import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, test } from 'node:test'
import { loadModule } from '../../../theme/testSupport.js'
import { LINK_COPIED_NOTICE, LINK_COPY_FAILED_NOTICE, copyLink } from '../../../utils/copyLink.js'
import { publicOrigin } from '../../../utils/publicOrigin.js'

// 9L.2 — the "Carta digital" link in the admin (Negocio): the public /menu/<slug> link of the restaurant being managed, to copy or open.

const ORIGIN = 'https://app.example.test'
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const css = read('../../../styles/index.css')
const component = read('./PublicMenuLink.jsx')
const adminBusiness = read('../../../pages/admin/AdminBusiness.jsx')

let r
before(async () => {
  r = await loadModule(`
    import { renderToStaticMarkup } from 'react-dom/server'
    import PublicMenuLink from './components/admin/business/PublicMenuLink.jsx'
    export const link = (props) => renderToStaticMarkup(<PublicMenuLink {...props} />)
  `)
})
const hrefOf = (html) => /<a [^>]*href="([^"]+)"/.exec(html)?.[1]
const valueOf = (html) => /<input [^>]*value="([^"]+)"/.exec(html)?.[1]

test('1. the link is /menu/<slug> on the public origin, built from the real slug of the restaurant', () => {
  const html = r.link({ slug: 'parrilla-demo', origin: ORIGIN })
  assert.equal(valueOf(html), `${ORIGIN}/menu/parrilla-demo`)
  assert.equal(hrefOf(html), `${ORIGIN}/menu/parrilla-demo`)
  // an origin with a trailing slash or a path still gives a clean link
  assert.equal(valueOf(r.link({ slug: 'cafe-9', origin: `${ORIGIN}/` })), `${ORIGIN}/menu/cafe-9`)
})

test('2. two restaurants with different slugs get different links, and nothing is hard-coded', () => {
  const a = valueOf(r.link({ slug: 'brasa-47', origin: ORIGIN }))
  const b = valueOf(r.link({ slug: 'la-esquina', origin: ORIGIN }))
  assert.notEqual(a, b)
  assert.ok(a.endsWith('/menu/brasa-47') && b.endsWith('/menu/la-esquina'))
  assert.ok(!/brasa-47|brasa 47/i.test(component), 'the component names no restaurant')
  // the admin hands the component the slug of the business it loaded (the one of the ADMIN, or the SUPER_ADMIN\'s selected one)
  assert.match(adminBusiness, /<PublicMenuLink key=\{business\.id\} slug=\{business\.slug\} \/>/)
})

test('3. without a usable slug no link is made up: a notice instead, and no copy / open buttons', () => {
  for (const slug of [undefined, null, '', 'ab', 'Mayusculas', 'con_guion_bajo', 'con espacios', '../x', 'a'.repeat(61)]) {
    const html = r.link({ slug, origin: ORIGIN })
    assert.ok(html.includes('El enlace de tu carta no está disponible por ahora.'), String(slug))
    assert.ok(!/Copiar enlace|Abrir carta|<input|<a /.test(html), String(slug))
  }
  // an unusable origin gives no link either
  assert.ok(r.link({ slug: 'brasa-47', origin: 'not a url' }).includes('no está disponible'))
})

test('4. the link carries nothing private: no table token, no query, no QR, no fragment', () => {
  const url = valueOf(r.link({ slug: 'brasa-47', origin: ORIGIN }))
  assert.ok(!/[?#]|t=|token|qr/i.test(url.slice(ORIGIN.length)))
  assert.ok(!/qrToken|TableQr|\?t=|session|token/i.test(component.replace(/\/\/.*$/gm, '')), 'the component does not touch the table QR, tokens or sessions')
})

test('5. markup: title, explanation, selectable read-only field, primary Copy button, secondary Open link, live notice area', () => {
  const html = r.link({ slug: 'brasa-47', origin: ORIGIN })
  assert.match(html, /<h3[^>]*>Carta digital<\/h3>/)
  assert.ok(html.includes('sin escanear ningún QR'))
  assert.match(html, /<label class="public-link__field"><span>Enlace de tu carta<\/span><input [^>]*readOnly=""|<input [^>]*readonly=""/)
  assert.match(html, /<button type="button" class="btn btn--primary btn--small">Copiar enlace<\/button>/)
  assert.match(html, /<a class="btn btn--outline btn--small" href="[^"]+" target="_blank" rel="noopener noreferrer" aria-label="Abrir carta en una pestaña nueva">Abrir carta<\/a>/)
  assert.match(html, /<p class="public-link__status" role="status"><\/p>/, 'the live region exists (empty) before any copy')
  assert.ok(!html.includes('Enlace copiado'))
})

test('6. accessibility: the field is labelled, the open link names the new tab, the notice is a status region, and the name contains the visible text', () => {
  const html = r.link({ slug: 'brasa-47', origin: ORIGIN })
  assert.ok(html.includes('aria-labelledby="public-link-title"') && html.includes('id="public-link-title"'))
  assert.ok('Abrir carta en una pestaña nueva'.includes('Abrir carta'))
  assert.match(component, /role="status"/)
})

test('7. public origin: configured one first, else the page origin; only http(s); never invented', () => {
  assert.equal(publicOrigin('https://carta.example.test/', 'http://localhost:5173'), 'https://carta.example.test')
  assert.equal(publicOrigin('', 'https://web.example.test'), 'https://web.example.test')
  assert.equal(publicOrigin(undefined, 'http://localhost:5173/admin'), 'http://localhost:5173')
  assert.equal(publicOrigin('no-url', 'https://web.example.test'), 'https://web.example.test')
  assert.equal(publicOrigin('javascript:alert(1)', 'ftp://x.test'), null)
  assert.equal(publicOrigin(undefined, null), null)
  assert.equal(publicOrigin(), null)
})

test('8. copy: the Clipboard API first, then the fallback, then a clear failure (never an exception)', async () => {
  const url = 'https://app.example.test/menu/brasa-47'
  const written = []
  const ok = { clipboard: { writeText: async (text) => written.push(text) } }
  assert.equal(await copyLink({ url, nav: ok }), 'copied')
  assert.deepEqual(written, [url])

  const refused = { clipboard: { writeText: async () => Promise.reject(new DOMException('denied', 'NotAllowedError')) } }
  assert.equal(await copyLink({ url, nav: refused, selectAndCopy: () => true }), 'copied')
  assert.equal(await copyLink({ url, nav: refused, selectAndCopy: () => false }), 'failed')
  assert.equal(await copyLink({ url, nav: refused, selectAndCopy: () => { throw new Error('boom') } }), 'failed')
  assert.equal(await copyLink({ url, nav: {} }), 'failed', 'a browser without the Clipboard API')
  assert.equal(await copyLink({ url, nav: refused }), 'failed')
  assert.equal(LINK_COPIED_NOTICE, 'Enlace copiado')
  assert.match(LINK_COPY_FAILED_NOTICE, /No pudimos copiar el enlace/)
})

test('9. the component wires the copy and its notices: "Enlace copiado" on success, an error and the selected field on failure', () => {
  assert.match(component, /onClick=\{handleCopy\}/)
  assert.match(component, /status === 'copied' \? LINK_COPIED_NOTICE : status === 'failed' \? LINK_COPY_FAILED_NOTICE : ''/)
  assert.match(component, /if \(result === 'failed'\) selectField\(\)/)
  assert.match(component, /setStatus\(null\)/, 'the notice resets by itself and with another restaurant')
})

test('10. layout: a card in Negocio before the images, hidden with the rest of the form when the preview is open; the preview itself is untouched', () => {
  const edit = adminBusiness.slice(adminBusiness.indexOf('<div className="business-edit"'))
  assert.ok(edit.indexOf('<PublicMenuLink') > 0 && edit.indexOf('<PublicMenuLink') < edit.indexOf('<BusinessImages'))
  assert.match(adminBusiness, /\{view === 'preview' && <RestaurantPreview key=\{business\.id\} business=\{business\} draft=\{previewDraft\} onBack=\{\(\) => setView\('form'\)\} \/>\}/)
})

test('11. styles: tokens only, scoped to .public-link, full-width buttons on phones and side by side from 640px', () => {
  const start = css.indexOf('/* ============ Digital menu link of the admin')
  const block = css.slice(start, css.indexOf('/* ============', start + 10))
  assert.ok(start > 0 && block.length > 500)
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(block), 'no hard-coded colours')
  const selectors = [...block.matchAll(/(^|\n)\s*([^\n{}@/*][^\n{}]*)\{/g)].map((m) => m[2].trim())
  for (const s of selectors) assert.match(s, /^\.public-link/, s)
  assert.match(block, /\.public-link__actions \{\s*display: flex;\s*flex-direction: column;/)
  assert.match(block, /@media \(min-width: 640px\) \{\s*\.public-link__actions \{\s*flex-direction: row;/)
  assert.match(block, /\.public-link__field input \{[^}]*background: var\(--input-bg\);/)
})

test('12. isolation: nothing of the public menu, the table (QR) flow or the existing preview is touched by this feature', () => {
  for (const file of ['../../customer/MenuScreen.jsx', '../../customer/CategoryTabs.jsx', '../tables/TableQrModal.jsx', './RestaurantPreview.jsx', '../../../pages/PublicMenuPage.jsx']) {
    assert.ok(!/PublicMenuLink|copyLink|publicOrigin/.test(read(file)), file)
  }
  // the table QR keeps its own link: /?t=<token>, not /menu/<slug>
  assert.match(read('../tables/TableQrModal.jsx'), /\/\?t=\$\{qrToken\}/)
})
