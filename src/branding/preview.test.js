import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, test } from 'node:test'
import { loadModule } from '../theme/testSupport.js'
import { TRANSITIONAL_COVER_SRC, isDraftCoverSrc, resolveHomeCover } from '../components/customer/homeCover.js'
import { composePreview, describePending } from './previewModel.js'
import { EMPTY_PREVIEW_MENU, createPreviewMenuStore } from './previewMenu.js'

// 9E.16 — the admin's restaurant preview: display only, saved vs unsaved, per business, no session / cart / writes.

const SAVED = { id: 'b1', name: 'Bistró Olivo', slug: 'bistro-olivo', active: true, logoUrl: 'https://api.example.test/media/b1/logo.webp', coverUrl: 'https://api.example.test/media/b1/cover.webp', primaryColor: '#2F6B4F', accentColor: '#D9B44A' }
const COVER_B = 'https://api.example.test/media/b2/cover.webp'
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

// ---- composePreview -------------------------------------------------------------------------------------------------------------
test('with no draft (or drafts switched off) the preview is exactly what is SAVED, nothing pending', () => {
  for (const args of [{ saved: SAVED }, { saved: SAVED, draft: null }, { saved: SAVED, draft: { name: 'Otro', primaryColor: '#000000', accentColor: '' }, useDraft: false }]) {
    const r = composePreview(args)
    assert.deepEqual(r.effective, { businessName: 'Bistró Olivo', logoUrl: SAVED.logoUrl, coverUrl: SAVED.coverUrl, primaryColor: '#2F6B4F', accentColor: '#D9B44A' })
    assert.deepEqual([r.pending, r.invalid], [[], []])
  }
})

test('unsaved colours and name are shown and reported as pending, without touching the saved values', () => {
  const draft = { name: '  Olivo Norte ', primaryColor: '#112233', accentColor: '#d9b44a' }
  const before = JSON.stringify(SAVED)
  const r = composePreview({ saved: SAVED, draft })
  assert.equal(r.effective.businessName, 'Olivo Norte')
  assert.equal(r.effective.primaryColor, '#112233')
  assert.equal(r.effective.accentColor, '#D9B44A', 'the same colour in another letter case is NOT a change')
  assert.deepEqual(r.pending.map((p) => p.field), ['businessName', 'primaryColor'])
  assert.equal(JSON.stringify(SAVED), before, 'the saved business is never mutated')
  assert.equal(describePending(r.pending), 'el nombre y el color principal')
  assert.equal(describePending([]), '')
  assert.equal(describePending(composePreview({ saved: SAVED, draft: { name: SAVED.name, primaryColor: '#000000', accentColor: '#D9B44A' } }).pending), 'el color principal')
})

test('an emptied colour field means "default palette" (null) and is pending; reset colours show no custom colour', () => {
  const r = composePreview({ saved: SAVED, draft: { name: SAVED.name, primaryColor: '', accentColor: '   ' } })
  assert.deepEqual([r.effective.primaryColor, r.effective.accentColor], [null, null])
  assert.deepEqual(r.pending.map((p) => p.field), ['primaryColor', 'accentColor'])
  const already = composePreview({ saved: { ...SAVED, primaryColor: null, accentColor: null }, draft: { name: SAVED.name, primaryColor: '', accentColor: '' } })
  assert.deepEqual(already.pending, [], 'nothing changed when there was no colour either')
})

test('a half-typed or invalid colour is never rendered: the saved one stays and the field is reported', () => {
  for (const bad of ['#12', '#GGGGGG', 'red', 'rgb(0,0,0)', '#1234567', 'url(x)']) {
    const r = composePreview({ saved: SAVED, draft: { name: SAVED.name, primaryColor: bad, accentColor: '#D9B44A' } })
    assert.equal(r.effective.primaryColor, '#2F6B4F', bad)
    assert.deepEqual(r.invalid, ['el color principal'], bad)
    assert.deepEqual(r.pending, [])
  }
  // an empty name is not a change (the form requires a name)
  assert.equal(composePreview({ saved: SAVED, draft: { name: '   ', primaryColor: '#2F6B4F', accentColor: '#D9B44A' } }).effective.businessName, 'Bistró Olivo')
})

test('everything shown went through the safe-branding validators (an unsafe saved logo / cover is never used)', () => {
  const r = composePreview({ saved: { ...SAVED, logoUrl: 'javascript:alert(1)', coverUrl: '//evil.example/c.png' }, draft: null })
  assert.deepEqual([r.effective.logoUrl, r.effective.coverUrl], [null, null])
})

test('the previewed restaurant never borrows anything from another one: the result depends only on its own saved + draft', () => {
  const a = composePreview({ saved: SAVED, draft: { name: 'A', primaryColor: '#111111', accentColor: '' } })
  const b = composePreview({ saved: { id: 'b2', name: 'Parrilla', slug: 'parrilla-demo', logoUrl: null, coverUrl: null, primaryColor: null, accentColor: null }, draft: null })
  assert.deepEqual(b.effective, { businessName: 'Parrilla', logoUrl: null, coverUrl: null, primaryColor: null, accentColor: null })
  assert.notEqual(a.effective.businessName, b.effective.businessName)
})

// ---- local draft cover (blob:) ---------------------------------------------------------------------------------------------------
test('a draft cover is only a blob: URL made in this browser; it wins over the saved cover and over the Brasa 47 photo, and a failure goes neutral', () => {
  const draft = 'blob:http://127.0.0.1:5174/11111111-1111-4111-8111-111111111111'
  assert.equal(isDraftCoverSrc(draft), true)
  for (const bad of ['https://evil.example/x.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', '/images/restaurant-hero.webp', '', null, undefined, 5, {}]) assert.equal(isDraftCoverSrc(bad), false, String(bad))
  assert.deepEqual(resolveHomeCover({ coverUrl: SAVED.coverUrl, businessSlug: 'bistro-olivo', draftSrc: draft }), { src: draft, kind: 'draft' })
  assert.deepEqual(resolveHomeCover({ coverUrl: null, businessSlug: 'brasa-47', draftSrc: draft }), { src: draft, kind: 'draft' })
  assert.deepEqual(resolveHomeCover({ coverUrl: null, businessSlug: 'brasa-47', draftSrc: draft, failedSrc: draft }), { src: null, kind: 'neutral' }, 'a failed draft never brings back the historical photo')
  // an unsafe "draft" is ignored: the normal priority applies
  assert.deepEqual(resolveHomeCover({ coverUrl: COVER_B, businessSlug: 'x-y', draftSrc: 'https://evil.example/x.png' }), { src: COVER_B, kind: 'custom' })
  // the Brasa 47 exception is untouched and still exact
  assert.deepEqual(resolveHomeCover({ coverUrl: null, businessSlug: 'brasa-47' }), { src: TRANSITIONAL_COVER_SRC, kind: 'transitional' })
  assert.deepEqual(resolveHomeCover({ coverUrl: null, businessSlug: 'brasa-47-norte' }), { src: null, kind: 'neutral' })
})

// ---- the preview's menu store ------------------------------------------------------------------------------------------------------
const cat = (id, sortOrder) => ({ id, name: `Cat ${id}`, slug: id, sortOrder })
const prod = (id, categoryId, sortOrder) => ({ id, name: `Prod ${id}`, categoryId, sortOrder, price: 1000, imageUrl: null })
const adapt = (p) => ({ ...p, image: p.imageUrl })

test('the menu store reads ONLY the public lists of its own slug, sorts and adapts them, and never retries by itself', async () => {
  const calls = []
  const store = createPreviewMenuStore({
    slug: 'bistro-olivo',
    fetchCategories: async (s) => (calls.push(['categories', s]), [cat('c2', 2), cat('c1', 1)]),
    fetchProducts: async (s) => (calls.push(['products', s]), [prod('p2', 'c1', 2), prod('p1', 'c1', 1)]),
    adapt,
    describeError: (e) => `E:${e.message}`,
  })
  assert.equal(store.getState().status, 'loading')
  await store.load()
  assert.deepEqual(calls, [['categories', 'bistro-olivo'], ['products', 'bistro-olivo']])
  const s = store.getState()
  assert.deepEqual([s.status, s.categories.map((c) => c.id), s.products.map((p) => p.id)], ['ready', ['c1', 'c2'], ['p1', 'p2']])
  assert.ok('image' in s.products[0])
  await tick()
  assert.equal(calls.length, 2, 'no automatic reload')
})

test('a failure shows the error and keeps NOTHING of a previous menu; retry is only an explicit load()', async () => {
  let fail = true
  const store = createPreviewMenuStore({ slug: 'a-b', fetchCategories: async () => { if (fail) throw new Error('down'); return [cat('c1', 1)] }, fetchProducts: async () => [prod('p1', 'c1', 1)], adapt, describeError: (e) => `E:${e.message}` })
  await store.load()
  assert.deepEqual([store.getState().status, store.getState().error, store.getState().products], ['error', 'E:down', []])
  fail = false
  await store.load()
  assert.equal(store.getState().status, 'ready')
})

test('LATE answers are dropped: after dispose (another business was selected) and when a newer load started', async () => {
  const a = deferred()
  const seen = []
  const storeA = createPreviewMenuStore({ slug: 'a-a', fetchCategories: () => a.promise, fetchProducts: async () => [prod('pa', 'ca', 1)], adapt, describeError: String })
  storeA.subscribe(() => seen.push('notified'))
  const pending = storeA.load()
  storeA.dispose()
  a.resolve([cat('ca', 1)])
  await pending
  assert.equal(storeA.getState().status, 'loading', 'a disposed store never receives an answer')
  assert.equal(seen.length, 1, 'only the "loading" notification before dispose')

  const first = deferred()
  let n = 0
  const storeB = createPreviewMenuStore({ slug: 'b-b', fetchCategories: () => (++n === 1 ? first.promise : Promise.resolve([cat('new', 1)])), fetchProducts: async () => [prod('pn', 'new', 1)], adapt, describeError: String })
  const p1 = storeB.load()
  const p2 = storeB.load() // the admin pressed Reintentar: a newer load
  await p2
  first.resolve([cat('old', 1)]) // the older answer arrives last
  await p1
  assert.deepEqual(storeB.getState().categories.map((c) => c.id), ['new'])
  // late FAILURES are dropped too
  const late = deferred()
  const storeC = createPreviewMenuStore({ slug: 'c-c', fetchCategories: () => late.promise, fetchProducts: async () => [], adapt, describeError: String })
  const pc = storeC.load()
  storeC.dispose()
  late.reject(new Error('boom'))
  await pc
  assert.equal(storeC.getState().status, 'loading')
})

test('useSyncExternalStore contract: the empty store and every store return a STABLE snapshot', async () => {
  assert.equal(EMPTY_PREVIEW_MENU.getState(), EMPTY_PREVIEW_MENU.getState())
  const store = createPreviewMenuStore({ slug: 'a-a', fetchCategories: async () => [], fetchProducts: async () => [], adapt, describeError: String })
  assert.equal(store.getState(), store.getState())
  await store.load()
  assert.equal(store.getState(), store.getState())
})

// ---- real markup ------------------------------------------------------------------------------------------------------------------------
let r
before(async () => {
  r = await loadModule(`
    import { renderToStaticMarkup } from 'react-dom/server'
    import MenuScreen from './components/customer/MenuScreen.jsx'
    import RestaurantPreview from './components/admin/business/RestaurantPreview.jsx'
    import PreviewFrame, { WelcomePreview } from './components/admin/business/PreviewFrame.jsx'
    import { ThemeContext } from './theme/themeContext.js'
    const theme = (resolvedTheme = 'light') => ({ resolvedTheme, preference: resolvedTheme, systemTheme: resolvedTheme, enabled: true, setPreference() {} })
    export const menu = (props) => renderToStaticMarkup(<MenuScreen {...props} />)
    export const preview = (props, t = 'light') => renderToStaticMarkup(<ThemeContext.Provider value={theme(t)}><RestaurantPreview onBack={() => {}} {...props} /></ThemeContext.Provider>)
    export const frame = (props, t = 'light') => renderToStaticMarkup(<ThemeContext.Provider value={theme(t)}><PreviewFrame {...props}>child</PreviewFrame></ThemeContext.Provider>)
    export const welcome = (props, t = 'light') => renderToStaticMarkup(<ThemeContext.Provider value={theme(t)}><WelcomePreview {...props} /></ThemeContext.Provider>)
  `)
})
const imgSrcs = (html) => [...html.matchAll(/<img[^>]*\ssrc="([^"]*)"/g)].map((m) => m[1])
const BRAND = { businessName: 'Bistró Olivo', logoUrl: SAVED.logoUrl, coverUrl: SAVED.coverUrl, primaryColor: '#2F6B4F', accentColor: '#D9B44A' }

test('MenuScreen draws categories and products from props alone: no theme toggle, no table, no cart, a slot for the header actions', () => {
  const html = r.menu({ businessName: 'Bistró Olivo', headerActions: 'SLOT-ACTIONS', status: 'ready', categories: [cat('c1', 1), cat('c2', 2)], products: [prod('p1', 'c1', 1), prod('p2', 'c2', 1)], activeCategory: 'c1', onSelectCategory() {}, onSelectProduct() {} })
  assert.match(html, /Bistró Olivo/)
  assert.match(html, /SLOT-ACTIONS/)
  assert.match(html, /Cat c1/)
  assert.match(html, /Prod p2/)
  assert.doesNotMatch(html, /theme-toggle|cart-bar|Mesa/i)
  assert.match(r.menu({ status: 'loading' }), /Cargando el menú/)
  assert.match(r.menu({ status: 'error', error: 'No pudimos cargar', onRetry() {} }), /No pudimos cargar[\s\S]*Reintentar/)
  assert.match(r.menu({ status: 'ready', categories: [], products: [] }), /Todavía no hay productos publicados/)
  assert.match(r.menu({ status: 'ready', businessName: '' }), /Nuestro restaurante/)
})

test('PreviewFrame applies the restaurant\'s colours as CSS variables on its own subtree only, per device, labelled, optionally inert and shrunk', () => {
  const html = r.frame({ device: 'mobile', branding: BRAND, label: 'Vista previa de Olivo' })
  assert.match(html, /class="preview-frame preview-frame--mobile"/)
  assert.match(html, /--primary:#2F6B4F/)
  assert.match(html, /--accent:#D9B44A/)
  assert.match(html, /role="region" aria-label="Vista previa de Olivo"/)
  assert.doesNotMatch(html, /inert/)
  assert.match(r.frame({ device: 'desktop', branding: BRAND }), /preview-frame--desktop/)
  assert.match(r.frame({ device: 'mobile', branding: { ...BRAND, primaryColor: null, accentColor: null } }), /^<div class="preview-stage"><div class="preview-frame preview-frame--mobile" role="region"/, 'no colours = the default palette: no variable at all')
  const small = r.frame({ device: 'mobile', scale: 0.5, branding: BRAND, inert: true })
  assert.match(small, /width:187\.5px;height:350px/)
  assert.match(small, /transform:scale\(0\.5\)/)
  assert.match(small, /inert=""/)
  // unsafe or invalid colours are never written
  assert.doesNotMatch(r.frame({ branding: { ...BRAND, primaryColor: 'red; background:url(x)' } }), /url\(x\)/)
  // the dark theme changes the derived variables, not the stored colours
  assert.notEqual(r.frame({ branding: BRAND }, 'light'), r.frame({ branding: BRAND }, 'dark'))
})

test('WelcomePreview shows the REAL welcome screen: saved logo and name, the draft cut as cover, in a shrunk inert window', () => {
  const draft = 'blob:http://127.0.0.1:5174/22222222-2222-4222-8222-222222222222'
  const html = r.welcome({ branding: BRAND, businessSlug: 'bistro-olivo', draftCoverSrc: draft })
  assert.match(html, /home__hero/)
  assert.equal(imgSrcs(html).length, 2, 'exactly the draft cover and the saved logo')
  assert.ok(imgSrcs(html).includes(draft))
  assert.ok(imgSrcs(html).includes(SAVED.logoUrl))
  assert.ok(!imgSrcs(html).includes(SAVED.coverUrl), 'the draft replaces the saved cover')
  assert.match(html, /Mesa demo/)
  assert.match(html, /data-cover="draft"/)
  assert.match(html, /inert=""/)
})

test('RestaurantPreview: saved only -> says so, no "pending" controls; the welcome screen shows the saved restaurant', () => {
  const html = r.preview({ business: SAVED, draft: { name: SAVED.name, primaryColor: SAVED.primaryColor, accentColor: SAVED.accentColor } })
  assert.match(html, /Esto es lo que ven tus clientes: la configuración guardada/)
  assert.doesNotMatch(html, /Con cambios sin guardar|Solo lo guardado/)
  assert.match(html, /VISTA PREVIA · solo para mirar, no se pueden hacer pedidos/)
  assert.match(html, /← Volver a personalizar/)
  assert.deepEqual(imgSrcs(html).sort(), [SAVED.coverUrl, SAVED.logoUrl].sort())
  assert.match(html, /--primary:#2F6B4F/)
})

test('RestaurantPreview: the screen switch is "Bienvenida" / "Pedido por QR" (no "Menú" label here) and a short note says this is the table ordering flow', () => {
  const same = { name: SAVED.name, primaryColor: SAVED.primaryColor, accentColor: SAVED.accentColor }
  const html = r.preview({ business: SAVED, draft: same })
  assert.match(html, /aria-label="Pantalla"[\s\S]*>Bienvenida<\/button>[\s\S]*>Pedido por QR<\/button>/)
  assert.doesNotMatch(html, />Menú<\/button>/)
  assert.match(html, /<p class="restaurant-preview__hint">Esta vista muestra cómo piden tus clientes desde la mesa, al escanear el QR/)
  // the other controls are still there: device, and (with unsaved changes) saved / unsaved
  assert.match(html, /aria-label="Dispositivo"[\s\S]*>Móvil<\/button>[\s\S]*>Escritorio<\/button>/)
  assert.doesNotMatch(html, /Con cambios sin guardar/)
  const pending = r.preview({ business: SAVED, draft: { ...same, primaryColor: '#112233' } })
  assert.match(pending, /aria-label="Qué mostrar"[\s\S]*>Con cambios sin guardar<\/button>[\s\S]*>Solo lo guardado<\/button>/)
  assert.match(pending, />Pedido por QR<\/button>/)
})

test('the new labels stay inside the preview: the "Menú" tab of the panel and the titles of the menus are untouched, and the preview offers no way to open the public menu', () => {
  assert.match(read('../pages/admin/AdminPanel.jsx'), /\{ key: 'menu', label: 'Menú' \}/)
  assert.match(read('../components/customer/MenuScreen.jsx'), /PUBLIC_MENU_NEUTRAL_TITLE = 'Menú'/)
  assert.match(read('../components/customer/MenuView.jsx'), /<h1 className="menu__title">Menú<\/h1>/)
  const comp = read('../components/admin/business/RestaurantPreview.jsx')
  assert.doesNotMatch(comp, /<a[\s>]|href=|iframe|\/menu\/|window\.open/)
})

test('RestaurantPreview: unsaved colours are shown, flagged as NOT saved, and can be compared with the saved look', () => {
  const html = r.preview({ business: SAVED, draft: { name: SAVED.name, primaryColor: '#112233', accentColor: '' } })
  assert.match(html, /Estás viendo cambios sin guardar:<\/strong> el color principal y el color secundario/)
  assert.match(html, /Tus clientes aún no los ven/)
  assert.match(html, /Con cambios sin guardar[\s\S]*Solo lo guardado/)
  assert.match(html, /--primary:#112233/)
  assert.doesNotMatch(html, /--accent:/, 'the emptied colour falls back to the default palette')
  const bad = r.preview({ business: SAVED, draft: { name: SAVED.name, primaryColor: '#12', accentColor: SAVED.accentColor } })
  assert.match(bad, /formato #RRGGBB/)
  assert.match(bad, /--primary:#2F6B4F/, 'a half-typed colour never reaches the page')
})

test('RestaurantPreview: Brasa 47 without a cover of its own keeps its historical photo; another restaurant without cover stays neutral', () => {
  const brasa = r.preview({ business: { ...SAVED, slug: 'brasa-47', name: 'Brasa 47', coverUrl: null, logoUrl: null }, draft: { name: 'Brasa 47', primaryColor: '#2F6B4F', accentColor: '#D9B44A' } })
  assert.deepEqual(imgSrcs(brasa), [TRANSITIONAL_COVER_SRC])
  const other = r.preview({ business: { ...SAVED, slug: 'brasa-47-norte', name: 'Norte', coverUrl: null, logoUrl: null }, draft: { name: 'Norte', primaryColor: '#2F6B4F', accentColor: '#D9B44A' } })
  assert.deepEqual(imgSrcs(other), [])
  assert.match(other, /home__hero--neutral/)
})

// ---- guarantees by construction ------------------------------------------------------------------------------------------------------------
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const read = (rel) => code(readFileSync(new URL(rel, import.meta.url), 'utf8'))
const PREVIEW_FILES = ['./previewModel.js', './previewMenu.js', '../components/customer/MenuScreen.jsx', '../components/admin/business/RestaurantPreview.jsx', '../components/admin/business/PreviewFrame.jsx']

test('the preview code has NO way to start a session, touch a cart, place an order, write storage or send anything', () => {
  for (const f of PREVIEW_FILES) {
    const src = read(f)
    assert.doesNotMatch(src, /CartContext|cartStore|useCart|CartProvider|qrSession|tableSessionApi|joinTableSession|orderApi|CustomerApp|ProductModal|ThemeToggle/, f)
    assert.doesNotMatch(src, /sessionStorage|localStorage|indexedDB|document\.cookie|navigator\.sendBeacon/, f)
    assert.doesNotMatch(src, /table-sessions|\/orders|qrToken|sessionToken|Authorization|accessToken|useAuth/, f)
    assert.doesNotMatch(src, /method:\s*['"](POST|PATCH|PUT|DELETE)['"]|\bfetch\(|apiFetch|FormData|XMLHttpRequest/, f)
  }
  // the only network primitives: the two PUBLIC menu reads, passed in by the component
  const comp = read('../components/admin/business/RestaurantPreview.jsx')
  assert.deepEqual([...new Set([...comp.matchAll(/services\/menuApi'/g)].map(() => 'menuApi'))], ['menuApi'])
  assert.match(comp, /fetchCategories: fetchPublicCategories, fetchProducts: fetchPublicProducts/)
})

test('wiring: the preview is per business and disposed with it; the draft is only the form\'s own state; nothing in AdminBusiness saves it', () => {
  const comp = read('../components/admin/business/RestaurantPreview.jsx')
  assert.match(comp, /return \(\) => created\.dispose\(\)/)
  const admin = read('../pages/admin/AdminBusiness.jsx')
  assert.match(admin, /<RestaurantPreview key=\{business\.id\} business=\{business\} draft=\{previewDraft\}/)
  assert.match(admin, /const previewDraft = useMemo\(\(\) => \(\{ name, primaryColor, accentColor \}\), \[name, primaryColor, accentColor\]\)/)
  assert.equal((admin.match(/method: 'PATCH'/g) ?? []).length, 1, 'the only write of the form is still the explicit save')
  // the form and the images are only hidden (not unmounted) while the preview is open
  assert.match(admin, /className="business-edit" hidden=\{view === 'preview'\}/)
  assert.match(admin, /Vista previa/)
  // the customer app never passes a draft cover; the draft reaches the real welcome screen only through the admin's WelcomePreview
  assert.doesNotMatch(read('../pages/CustomerApp.jsx'), /draftCoverSrc|draftSrc/)
  const modal = read('../components/admin/business/CoverCropModal.jsx')
  assert.match(modal, /<WelcomePreview branding=\{previewBranding\} businessSlug=\{businessSlug\} draftCoverSrc=\{result\.url\} \/>/)
  assert.equal((modal.match(/onUse\(/g) ?? []).length, 1, 'the cut is uploaded only by the explicit "Usar esta portada" button')
})
