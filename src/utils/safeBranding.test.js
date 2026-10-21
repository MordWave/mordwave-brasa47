import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, test } from 'node:test'
import { cartScopeFor, createCartStore } from '../context/cartStore.js'
import { loadModule } from '../theme/testSupport.js'
import { brandingStyleVars } from '../theme/brandStyle.js'
import { createBrandingRefresher, reduceSessionBranding, safeBranding, withSafeBranding } from './brandingRefresh.js'

// 9E.9 (fix) — branding enters the app through two doors without a stored value to fall back to: the FIRST scan of a QR and a session
// RECOVERED from storage (possibly saved by an older build). Both must yield only safe values: a valid http(s) logo/cover, a #RRGGBB
// colour or the neutral default; never something unsafe, and never something inherited from another restaurant.

const LOGO = 'https://api.example.test/media/businesses/11111111-1111-4111-8111-111111111111/logo/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp'
const COVER = 'https://api.example.test/media/businesses/11111111-1111-4111-8111-111111111111/cover/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp'
const UNSAFE_URLS = ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'blob:https://a.test/x', 'file:///etc/passwd', '//evil.example/x.png', '/relative.png', 'logo.png', 'ftp://a.test/x.png', 'https://user:pw@a.test/x.png', '', '   ', 5, {}, [], true]
const BAD_COLORS = ['red', '#FFF', '#GGGGGG', '#12345678', ' #112233', '#112233 ', 'rgb(0,0,0)', 'url(x)', 'red; background:url(x)', '', 12, {}, true]

// what the first scan builds in CustomerApp (a source guard below proves the app does exactly this)
const firstScan = (result, qrToken = 'qr-1') => ({
  sessionToken: result.sessionToken,
  tableName: result.tableName,
  businessSlug: result.businessSlug,
  ...safeBranding(result),
  qrToken,
})
const answer = (extra = {}) => ({ sessionToken: 'sess-1', tableName: 'Mesa 4', businessSlug: 'bistro-olivo', businessName: 'Bistró Olivo', logoUrl: LOGO, coverUrl: COVER, primaryColor: '#2F6B4F', accentColor: '#d9b44a', ...extra })

let view
before(async () => {
  const mod = await loadModule(`
    import { renderToStaticMarkup } from 'react-dom/server'
    import { HomeScreenView } from './components/customer/HomeScreen.jsx'
    export const view = (props) => renderToStaticMarkup(<HomeScreenView tableName="Mesa 4" onContinue={() => {}} {...props} />)
  `)
  view = mod.view
})
const imgSrcs = (html) => [...html.matchAll(/<img[^>]*\ssrc="([^"]*)"/g)].map((m) => m[1].replaceAll('&amp;', '&'))

// ---- 1. first scan: logo ------------------------------------------------------------------------------------------------------
test('1. first scan: a valid logo is kept; every unsafe or malformed one becomes "no logo" and never reaches an <img src>', () => {
  assert.equal(firstScan(answer()).logoUrl, LOGO)
  for (const bad of UNSAFE_URLS) {
    const session = firstScan(answer({ logoUrl: bad, coverUrl: bad }))
    assert.equal(session.logoUrl, null, String(bad))
    assert.equal(session.coverUrl, null, String(bad))
    const html = view({ ...session, businessSlug: 'bistro-olivo' })
    assert.deepEqual(imgSrcs(html), [], `no <img> at all for ${String(bad)}`)
    assert.match(html, /home__mark/, 'the initials mark is shown instead of a logo')
  }
})

test('1b. the home never lets a bad logo reach <img src>, even if the state held one (older stored session, other caller)', () => {
  for (const bad of UNSAFE_URLS) assert.deepEqual(imgSrcs(view({ businessName: 'Olivo', businessSlug: 'bistro-olivo', logoUrl: bad })), [], String(bad))
  assert.deepEqual(imgSrcs(view({ businessName: 'Olivo', businessSlug: 'bistro-olivo', logoUrl: LOGO })), [LOGO])
})

// ---- 2. first scan: colours ---------------------------------------------------------------------------------------------------
test('2. first scan: valid colours are kept (any case), invalid ones and null become "no colour" (the default palette)', () => {
  const ok = firstScan(answer())
  assert.deepEqual([ok.primaryColor, ok.accentColor], ['#2F6B4F', '#d9b44a'])
  for (const bad of BAD_COLORS) {
    const session = firstScan(answer({ primaryColor: bad, accentColor: bad }))
    assert.deepEqual([session.primaryColor, session.accentColor], [null, null], String(bad))
    assert.deepEqual(brandingStyleVars(safeBranding(session), 'light'), {}, `no CSS variable is produced for ${String(bad)}`)
  }
  // null = the restaurant has no colour of its own (also what "reset to default colours" stores)
  const reset = firstScan(answer({ primaryColor: null, accentColor: null }))
  assert.deepEqual([reset.primaryColor, reset.accentColor], [null, null])
  assert.deepEqual(brandingStyleVars(safeBranding(reset), 'dark'), {})
  // one valid and one invalid colour are judged separately
  const mixed = firstScan(answer({ primaryColor: '#112233', accentColor: 'red' }))
  assert.deepEqual([mixed.primaryColor, mixed.accentColor], ['#112233', null])
})

test('2b. missing properties in a first-scan answer become the neutral defaults, not undefined', () => {
  const session = firstScan({ sessionToken: 's', tableName: 'Mesa 1', businessSlug: 'bistro-olivo' })
  assert.deepEqual(
    { name: session.businessName, logo: session.logoUrl, cover: session.coverUrl, p: session.primaryColor, a: session.accentColor },
    { name: '', logo: null, cover: null, p: null, a: null },
  )
  // a bad name never reaches the screens (they fall back to their own generic name)
  for (const bad of ['', '   ', 'x'.repeat(121), 7, null, {}]) assert.equal(firstScan(answer({ businessName: bad })).businessName, '')
})

// ---- 3. recovered older session -----------------------------------------------------------------------------------------------
test('3. a recovered session saved with an unsafe logo or colour is made safe; identity, table, slug and QR are not touched', () => {
  const old = { sessionToken: 'sess-1', tableName: 'Mesa 4', businessSlug: 'bistro-olivo', qrToken: 'qr-1', businessName: 'Bistró Olivo', logoUrl: 'javascript:alert(1)', primaryColor: 'red', accentColor: '#D9B44A' }
  const safe = withSafeBranding(old)
  assert.notEqual(safe, old)
  assert.deepEqual(
    { logo: safe.logoUrl, cover: safe.coverUrl, p: safe.primaryColor, a: safe.accentColor, name: safe.businessName },
    { logo: null, cover: null, p: null, a: '#D9B44A', name: 'Bistró Olivo' },
  )
  for (const key of ['sessionToken', 'tableName', 'businessSlug', 'qrToken']) assert.equal(safe[key], old[key], key)
  assert.deepEqual(imgSrcs(view({ ...safe })), [])
  assert.deepEqual(brandingStyleVars(safeBranding(safe), 'light')['--primary'], undefined)
  // a session that already is safe is returned untouched (nothing to rewrite)
  const clean = firstScan(answer())
  assert.equal(withSafeBranding(clean), clean)
  // and repairing is idempotent: a repaired session is already safe
  assert.equal(withSafeBranding(safe), safe)
})

test('3b. stored colours cannot be applied unsafely at render time either', () => {
  for (const bad of BAD_COLORS) assert.deepEqual(brandingStyleVars(safeBranding({ primaryColor: bad, accentColor: bad }), 'light'), {}, String(bad))
  assert.ok(brandingStyleVars(safeBranding({ primaryColor: '#2F6B4F', accentColor: '#D9B44A' }), 'light')['--primary'])
})

// ---- 4. intentional removal ---------------------------------------------------------------------------------------------------
test('4. null logo and null cover mean "none" on purpose: the first scan stores null and the refresh REMOVES the stored ones', async () => {
  const scanned = firstScan(answer({ logoUrl: null, coverUrl: null }))
  assert.deepEqual([scanned.logoUrl, scanned.coverUrl], [null, null])

  const session = firstScan(answer())
  let live = { status: 'active', ...session }
  const refresher = createBrandingRefresher({
    join: async () => answer({ logoUrl: null, coverUrl: null }),
    isCurrent: () => true,
    apply: (s, branding) => void (live = reduceSessionBranding(live, s.sessionToken, branding)),
  })
  assert.deepEqual(await refresher(session), { status: 'updated' })
  assert.deepEqual([live.logoUrl, live.coverUrl], [null, null])
  assert.deepEqual(imgSrcs(view({ ...live })), [], 'no logo and, for a normal restaurant, no cover image either')
})

// ---- 5. no pollution between restaurants --------------------------------------------------------------------------------------
test('5. nothing is inherited from another restaurant: an unsafe value becomes null, never the previous or another business\'s image/colour', () => {
  const a = firstScan(answer({ businessSlug: 'bistro-olivo' }), 'qr-a')
  const b = firstScan(answer({ sessionToken: 'sess-2', businessSlug: 'parrilla-demo', businessName: 'Parrilla', logoUrl: 'javascript:1', coverUrl: '/brasa.png', primaryColor: 'red', accentColor: null }), 'qr-b')
  assert.equal(a.logoUrl, LOGO)
  assert.deepEqual([b.logoUrl, b.coverUrl, b.primaryColor, b.accentColor], [null, null, null, null], 'B holds nothing of A')
  // safeBranding is a pure function of its argument: no module state carries values from one call to the next
  assert.deepEqual(safeBranding({}), { businessName: '', logoUrl: null, coverUrl: null, primaryColor: null, accentColor: null })
  // markup: a business with bad values shows neither another logo nor any photo
  const html = view({ ...b })
  assert.deepEqual(imgSrcs(html), [])
  assert.doesNotMatch(html, /restaurant-hero|brasa/i)
  // the historical photo stays Brasa 47's alone
  assert.deepEqual(imgSrcs(view({ ...b, businessSlug: 'brasa-47' })), ['/images/restaurant-hero.webp'])
})

// ---- 6. identity and cart ------------------------------------------------------------------------------------------------------
test('6. making the branding safe never changes token, QR, table, slug or the cart (real cart store)', () => {
  const memory = () => {
    const data = new Map()
    return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => void data.set(k, String(v)), removeItem: (k) => void data.delete(k), data }
  }
  const storage = memory()
  const old = { sessionToken: 'sess-1', tableName: 'Mesa 4', businessSlug: 'bistro-olivo', qrToken: 'qr-1', businessName: 'Bistró Olivo', logoUrl: 'data:text/html,x', primaryColor: '#FFF', accentColor: null }
  const cart = createCartStore({ storage })
  cart.attachScope(cartScopeFor(old))
  cart.addItem({ cartItemId: 'l1', productId: 'p1', name: 'Plato', quantity: 3, unitPrice: 1000, lineTotal: 3000, removed: [], added: [] })
  const before = cart.getState()
  const persisted = storage.getItem('brasa47_cart_v2')

  const safe = withSafeBranding(old)
  assert.equal(cartScopeFor(safe), cartScopeFor(old))
  cart.attachScope(cartScopeFor(safe)) // what resuming does: the same scope
  assert.equal(cart.getState().items[0].quantity, 3)
  assert.deepEqual(cart.getState().items, before.items)
  assert.equal(storage.getItem('brasa47_cart_v2'), persisted)
  for (const key of ['sessionToken', 'qrToken', 'tableName', 'businessSlug']) assert.equal(safe[key], old[key], key)
})

// ---- 7. later refresh with correct values ----------------------------------------------------------------------------------------
test('7. after a first scan or a repair, the next refresh brings the correct values and applies them', async () => {
  const repaired = withSafeBranding({ sessionToken: 'sess-1', tableName: 'Mesa 4', businessSlug: 'bistro-olivo', qrToken: 'qr-1', businessName: 'Bistró Olivo', logoUrl: 'javascript:1', coverUrl: '//evil.example/c.png', primaryColor: 'red', accentColor: 'blue' })
  assert.deepEqual([repaired.logoUrl, repaired.coverUrl, repaired.primaryColor, repaired.accentColor], [null, null, null, null])
  let live = { status: 'active', ...repaired }
  const refresher = createBrandingRefresher({
    join: async () => answer(),
    isCurrent: () => true,
    apply: (s, branding) => void (live = reduceSessionBranding(live, s.sessionToken, branding)),
  })
  assert.deepEqual(await refresher(repaired), { status: 'updated' })
  assert.deepEqual([live.logoUrl, live.coverUrl, live.primaryColor, live.accentColor], [LOGO, COVER, '#2F6B4F', '#d9b44a'])
  assert.deepEqual(imgSrcs(view({ ...live })).sort(), [COVER, LOGO].sort())
})

// ---- wiring --------------------------------------------------------------------------------------------------------------------
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const app = code(readFileSync(new URL('../pages/CustomerApp.jsx', import.meta.url), 'utf8'))
const home = code(readFileSync(new URL('../components/customer/HomeScreen.jsx', import.meta.url), 'utf8'))

test('wiring: the first scan, the recovered session and the colours all go through the validators; the logo through normalizeMediaUrl', () => {
  // first scan: identity from the answer, branding ONLY through safeBranding (no raw result.logoUrl / colours)
  const fresh = app.slice(app.indexOf('const fresh = {'), app.indexOf('writeStoredSession(fresh)'))
  assert.match(fresh, /\.\.\.safeBranding\(result\)/)
  assert.doesNotMatch(fresh, /result\.(logoUrl|coverUrl|primaryColor|accentColor|businessName)/)
  // recovered session: made safe before it becomes state, stored copy corrected, same scope
  const resume = app.slice(app.indexOf('function resumeStoredSession'), app.indexOf('async function init()'))
  assert.match(resume, /withSafeBranding\(storedAsRead\)/)
  assert.match(resume, /attachScope\(cartScopeFor\(stored\)\)/)
  assert.doesNotMatch(resume, /clearStoredSession|setCheckout|reset: true/)
  // colours: never applied straight from the session
  assert.match(app, /brandingStyleVars\(safeBranding\(session\), resolvedTheme\)/)
  assert.doesNotMatch(app, /brandingStyleVars\(session/)
  // logo: the only <img src> for it goes through the validator
  assert.match(home, /normalizeMediaUrl\(logoUrl\)/)
  assert.doesNotMatch(home, /src=\{logoUrl\}/)
})
