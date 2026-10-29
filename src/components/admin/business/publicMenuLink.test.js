import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, test } from 'node:test'
import { loadModule } from '../../../theme/testSupport.js'
import { LINK_COPIED_NOTICE, LINK_COPY_FAILED_NOTICE, copyLink } from '../../../utils/copyLink.js'
import { publicOrigin } from '../../../utils/publicOrigin.js'

// 9L.2 / 9L.2b — the "Ver enlace" dialog in the admin (Mesas tab, section "Carta digital pública"): the public /menu/<slug> link of the restaurant being managed, to copy or open.

const ORIGIN = 'https://app.example.test'
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const css = read('../../../styles/index.css')
const component = read('./PublicMenuLink.jsx')
const adminBusiness = read('../../../pages/admin/AdminBusiness.jsx')
const adminMenu = read('../../../pages/admin/AdminMenu.jsx')
const adminTables = read('../../../pages/admin/AdminTables.jsx')
const adminPanel = read('../../../pages/admin/AdminPanel.jsx')
const dialog = read('./PublicMenuLinkDialog.jsx')

let r
before(async () => {
  r = await loadModule(`
    import { renderToStaticMarkup } from 'react-dom/server'
    import PublicMenuLink from './components/admin/business/PublicMenuLink.jsx'
    import PublicMenuLinkDialog from './components/admin/business/PublicMenuLinkDialog.jsx'
    export const link = (props) => renderToStaticMarkup(<PublicMenuLink {...props} />)
    export const dialogOf = (props) => renderToStaticMarkup(<PublicMenuLinkDialog {...props} />)
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
  // the dialog asks for the business the panel manages (the ADMIN's own, or the SUPER_ADMIN's selected one) and uses ITS slug
  assert.match(adminTables, /const requestMyBusiness = useCallback\(\(\) => apiFetch\(scopePath\('\/businesses\/me'\), \{ token \}\), \[token, scopePath\]\)/)
  assert.match(dialog, /setState\(\{ status: 'ready', slug: business\?\.slug \}\)/)
  assert.match(dialog, /<PublicMenuLink slug=\{state\.slug\} origin=\{origin\} \/>/)
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

test('5. markup: explanation, selectable read-only field, primary Copy button, secondary Open link, live notice area', () => {
  const html = r.link({ slug: 'brasa-47', origin: ORIGIN })
  assert.ok(html.includes('sin escanear ningún QR'))
  assert.match(html, /<label class="public-link__field"><span>Enlace de tu carta<\/span><input [^>]*readOnly=""|<input [^>]*readonly=""/)
  assert.match(html, /<button type="button" class="btn btn--primary btn--small">Copiar enlace<\/button>/)
  assert.match(html, /<a class="btn btn--outline btn--small" href="[^"]+" target="_blank" rel="noopener noreferrer" aria-label="Abrir carta en una pestaña nueva">Abrir carta<\/a>/)
  assert.match(html, /<p class="public-link__status" role="status"><\/p>/, 'the live region exists (empty) before any copy')
  assert.ok(!html.includes('Enlace copiado'))
})

test('6. accessibility: the field is labelled, the open link names the new tab, the notice is a status region, and the name contains the visible text', () => {
  const html = r.link({ slug: 'brasa-47', origin: ORIGIN })
  assert.ok(html.includes('aria-label="Abrir carta en una pestaña nueva"'))
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

test('10. placement: only in Mesas (a compact section at the top, before "Gestión de mesas"); gone from Menú and Negocio; still four tabs; the preview is untouched', () => {
  for (const [name, source] of [['Negocio', adminBusiness], ['Menú', adminMenu]]) {
    assert.ok(!/PublicMenuLink|Carta digital|Enlace de mi carta|Ver enlace|linkOpen|requestMyBusiness/.test(source), `${name} no longer has the link`)
  }
  const section = adminTables.indexOf('<section className="public-link-row"')
  assert.ok(section > 0 && section < adminTables.indexOf('<h2>Gestión de mesas</h2>'))
  assert.match(adminTables, /<h3 id="public-link-row-title" className="public-link-row__title">\s*Carta digital pública\s*<\/h3>/)
  assert.ok(adminTables.includes('consulten productos y precios desde el celular, sin hacer pedidos'))
  assert.match(adminTables, /<button type="button" className="btn btn--outline btn--small" aria-haspopup="dialog" onClick=\{\(\) => setLinkOpen\(true\)\}>\s*Ver enlace\s*<\/button>/)
  assert.match(adminTables, /\{linkOpen && <PublicMenuLinkDialog request=\{requestMyBusiness\} onClose=\{\(\) => setLinkOpen\(false\)\} \/>\}/)
  // the dialog is the existing one (not copied): AdminTables only imports it
  assert.ok(!/useDialogA11y|copyLink|navigator\.clipboard/.test(adminTables))
  const tabs = [...adminPanel.slice(adminPanel.indexOf('const TABS'), adminPanel.indexOf(']', adminPanel.indexOf('const TABS'))).matchAll(/key: '(\w+)'/g)].map((m) => m[1])
  assert.deepEqual(tabs, ['pedidos', 'menu', 'mesas', 'negocio'], 'no fifth navigation tab')
  assert.match(adminBusiness, /\{view === 'preview' && <RestaurantPreview key=\{business\.id\} business=\{business\} draft=\{previewDraft\} onBack=\{\(\) => setView\('form'\)\} \/>\}/)
})

test('10b. "Gestión de mesas" keeps all its functions: New table, the list actions, the table and QR modals, and the table QR keeps its own link', () => {
  for (const needle of ['+ Nueva mesa', "setTableModal('new')", 'onToggleSession={handleToggleSession}', 'onViewQr={setQrTable}', 'onDelete={handleDeleteTable}', '<TableFormModal', '<TableQrModal', '<PrintQr data={printQr} />', "apiFetch(scopePath('/tables/admin'), { token })"]) assert.ok(adminTables.includes(needle), needle)
  const qr = read('../tables/TableQrModal.jsx')
  assert.match(qr, /\/\?t=\$\{qrToken\}/)
  assert.ok(!/\/menu\/|publicMenuUrl|PublicMenuLink/.test(qr), 'the table QR never points to the public menu')
})

test('11. styles: tokens only, scoped to .public-link*, full-width buttons on phones and side by side from 640px', () => {
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
  for (const file of ['../../customer/MenuScreen.jsx', '../../customer/CategoryTabs.jsx', '../tables/TableQrModal.jsx', './RestaurantPreview.jsx', '../../../pages/PublicMenuPage.jsx', '../../../pages/admin/AdminMenu.jsx', '../../../pages/admin/AdminBusiness.jsx']) {
    assert.ok(!/PublicMenuLink|copyLink|publicOrigin/.test(read(file)), file)
  }
  // the table QR keeps its own link: /?t=<token>, not /menu/<slug>
  assert.match(read('../tables/TableQrModal.jsx'), /\/\?t=\$\{qrToken\}/)
})

test('13. dialog: role=dialog, labelled, focus trap / restore / Escape from the shared hook, closes with the button and the backdrop, loading and error states', async () => {
  const html = r.dialogOf({ request: () => new Promise(() => {}), onClose() {}, origin: ORIGIN })
  assert.match(html, /<div class="confirm-backdrop"><div class="confirm-dialog admin-menu__modal public-link-dialog" role="dialog" aria-modal="true" aria-labelledby="[^"]+">/)
  assert.match(html, /<h3 id="[^"]+" class="admin-menu__modal-title">Enlace de mi carta digital<\/h3>/)
  assert.ok(html.includes('Cargando el enlace…') && html.includes('>Cerrar</button>'))
  assert.ok(!/Copiar enlace/.test(html), 'no link until the restaurant is known')
  assert.match(dialog, /useDialogA11y\(\{ containerRef: dialogRef, onEscape: onClose, initialFocusRef: closeRef \}\)/)
  assert.match(dialog, /<div className="confirm-backdrop" onClick=\{onClose\}>/)
  assert.match(dialog, /onClick=\{\(event\) => event\.stopPropagation\(\)\}/)
  assert.match(dialog, /status: 'error', message: translateApiError\(error\)/)
  assert.match(dialog, /onClick=\{load\}>\s*Reintentar/)
})
