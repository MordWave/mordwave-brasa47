import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import { contrastRatio, mixHex } from '../../theme/color.js'
import { loadModule } from '../../theme/testSupport.js'
import { isUsableStoredSession, readStoredSession } from '../../utils/qrSession.js'
import { isValidBusinessSlug } from '../../utils/businessSlug.js'
import { TRANSITIONAL_COVER_SRC, homeCoverFor } from './homeCover.js'

// 9E.2 — a restaurant never shows another restaurant's visual content: the home cover, the menu without a slug, and the stored session.

const SRC = fileURLToPath(new URL('../../', import.meta.url))
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const css = read('../../styles/index.css')

let mod
before(async () => {
  mod = await loadModule(`
    import { renderToStaticMarkup } from 'react-dom/server'
    import HomeScreen from './components/customer/HomeScreen.jsx'
    import MenuView, { NO_RESTAURANT_MESSAGE } from './components/customer/MenuView.jsx'
    import { ThemeContext } from './theme/themeContext.js'
    import { fetchPublicCategories, fetchPublicProducts, MissingBusinessSlugError } from './services/menuApi.js'
    export { NO_RESTAURANT_MESSAGE, MissingBusinessSlugError, fetchPublicCategories, fetchPublicProducts }
    export const renderHome = (props) => renderToStaticMarkup(<HomeScreen tableName="Mesa 4" onContinue={() => {}} {...props} />)
    export const renderMenu = (props) =>
      renderToStaticMarkup(
        <ThemeContext.Provider value={{ preference: 'system', resolvedTheme: 'light', systemTheme: 'light', setPreference() {} }}>
          <MenuView tableName="Mesa 4" {...props} />
        </ThemeContext.Provider>,
      )
  `)
})
after(() => {})

// ---- Home cover -----------------------------------------------------------------------------------------------
test('Brasa 47 keeps its photo (slug exactly "brasa-47") and is not styled as neutral', () => {
  const html = mod.renderHome({ businessName: 'Brasa 47', businessSlug: 'brasa-47' })
  assert.match(html, /<img class="home__photo" src="\/images\/restaurant-hero\.webp"/)
  assert.doesNotMatch(html, /home__hero--neutral/)
  assert.equal(homeCoverFor('brasa-47'), TRANSITIONAL_COVER_SRC)
})

test('every other restaurant gets the neutral background: no image, no path of the Brasa 47 photo, no "47"', () => {
  for (const slug of ['parrilla-demo', 'bistro-olivo', 'brasa-47-norte', 'brasa-4', 'brasa', 'Brasa-47', 'BRASA-47', ' brasa-47', 'brasa-47 ', 'brasa-47/', 'xbrasa-47', undefined, null, '']) {
    assert.equal(homeCoverFor(slug), null, String(slug))
    const html = mod.renderHome({ businessName: 'Parrilla Demo', businessSlug: slug })
    assert.match(html, /class="home__hero home__hero--neutral"/, String(slug))
    assert.doesNotMatch(html, /<img[^>]*home__photo/, String(slug))
    assert.doesNotMatch(html, /restaurant-hero|\/images\/|\.webp|\.jpg/, String(slug))
    assert.doesNotMatch(html, /brasa|47/i, String(slug))
  }
})

test('the home keeps what already worked: name, welcome text, table, button, logo or initials of the real name', () => {
  const html = mod.renderHome({ businessName: 'Parrilla Demo', businessSlug: 'parrilla-demo', logoUrl: null })
  assert.match(html, /<h1 class="home__brand">Parrilla Demo<\/h1>/)
  assert.match(html, /Bienvenidos a Parrilla Demo/)
  assert.match(html, /Mesa 4 detectada/)
  assert.match(html, /Ver menú/)
  assert.match(html, /<span class="home__mark">PD<\/span>/, 'initials come from the real name, never "47"')
  const withLogo = mod.renderHome({ businessName: 'Parrilla Demo', businessSlug: 'parrilla-demo', logoUrl: 'https://media.test/logo.webp' })
  assert.match(withLogo, /<img class="home__logo" src="https:\/\/media\.test\/logo\.webp"/)
  assert.match(mod.renderHome({ businessSlug: 'parrilla-demo' }), /Bienvenidos a Nuestro restaurante/)
})

test('the exception is transitional, in one place, documented, and the image files are NOT deleted yet', () => {
  const source = read('./homeCover.js')
  assert.match(source, /TRANSITIONAL EXCEPTION/)
  assert.match(source, /remove once Brasa 47 has its own cover configured/i)
  // the only non-test source that names the photo or the slug exception
  const offenders = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(jsx?|css|html)$/.test(name) && !/\.test\.js$/.test(name) && !full.endsWith(join('customer', 'homeCover.js'))) {
        const text = readFileSync(full, 'utf8')
        if (/restaurant-hero|\/images\//.test(text)) offenders.push(full.replace(SRC, ''))
      }
    }
  }
  walk(SRC)
  assert.deepEqual(offenders, [])
  assert.ok(existsSync(new URL('../../../public/images/restaurant-hero.webp', import.meta.url)), 'public/images is untouched in this phase')
})

// ---- Neutral hero: readable over ANY brand colour, in both themes ----------------------------------------------
const ruleBody = (selector) => {
  const start = css.indexOf(`\n${selector} {`)
  assert.ok(start >= 0, `${selector} not found`)
  return css.slice(start, css.indexOf('}', start))
}

test('the neutral hero is dark in every theme and its text keeps AA contrast over the lightest possible brand colour', () => {
  const base = /background:\s*(#[0-9a-fA-F]{6})/.exec(ruleBody('.home__hero--neutral'))[1]
  const glow = ruleBody('.home__hero--neutral::before')
  const glowOpacity = Number(/opacity:\s*([0-9.]+)/.exec(glow)[1])
  assert.match(glow, /var\(--primary\)/, "the glow is the restaurant's own colour")
  assert.ok(glowOpacity <= 0.3, `glow opacity ${glowOpacity}`)
  // the weakest darkening the vignette applies over the top area, where the brand name and tagline sit
  const vignette = ruleBody('.home__vignette')
  const alphas = [...vignette.split('radial-gradient')[0].matchAll(/rgba\(15, 12, 9, ([0-9.]+)\)/g)].map((m) => Number(m[1]))
  assert.ok(alphas.length >= 3)
  const weakest = Math.min(...alphas)
  // text colours of the hero (white title / brand, translucent cream tagline)
  const tagline = /\.home__tagline \{[^}]*color:\s*rgba\(245, 241, 232, ([0-9.]+)\)/.exec(css)
  const taglineAlpha = Number(tagline[1])
  const worstBrands = ['#FFFFFF', '#FFFF00', '#00FFFF', '#FFFFCC', '#F5F5F5', '#D94A2B', '#E9B44C', '#000000']
  for (const brand of worstBrands) {
    const withGlow = mixHex(base, brand, glowOpacity)
    const ground = mixHex(withGlow, '#0F0C09', weakest)
    assert.ok(contrastRatio('#FFFFFF', ground) >= 4.5, `white on ${brand}: ${contrastRatio('#FFFFFF', ground)}`)
    const taglineOnGround = mixHex(ground, '#F5F1E8', taglineAlpha)
    assert.ok(contrastRatio(taglineOnGround, ground) >= 4.5, `tagline on ${brand}: ${contrastRatio(taglineOnGround, ground)}`)
  }
})

test('the hero rules use no theme token for their ground (dark in light AND dark theme) and the photo rules are unchanged', () => {
  assert.doesNotMatch(ruleBody('.home__hero--neutral'), /var\(--(bg|surface|text|elevated)\b/)
  assert.match(ruleBody('.home__photo'), /object-fit:\s*cover/)
  assert.match(ruleBody('.home__hero'), /background:\s*#17110c/)
})

// ---- Slug: no default restaurant ------------------------------------------------------------------------------
const GOOD = ['brasa-47', 'parrilla-demo', 'abc', 'a1-b2-c3', 'x'.repeat(60)]
const BAD = [undefined, null, '', ' ', 'ab', 'x'.repeat(61), 'Brasa-47', 'brasa_47', 'brasa 47', '-brasa', 'brasa-', 'bra--sa', 'brasa.47', 'ñandú', 47, {}, [], ['brasa-47'], 'brasa-47\n', '../x']

test('slug validation mirrors the backend rule', () => {
  for (const slug of GOOD) assert.equal(isValidBusinessSlug(slug), true, slug)
  for (const slug of BAD) assert.equal(isValidBusinessSlug(slug), false, JSON.stringify(slug))
})

test('menuApi has no default restaurant: without a valid slug it rejects and sends NO request', async () => {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (...args) => {
    calls.push(args)
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    for (const slug of BAD) {
      await assert.rejects(() => mod.fetchPublicCategories(slug), mod.MissingBusinessSlugError, JSON.stringify(slug))
      await assert.rejects(() => mod.fetchPublicProducts(slug), mod.MissingBusinessSlugError, JSON.stringify(slug))
    }
    await assert.rejects(() => mod.fetchPublicCategories(), (error) => error.code === 'BUSINESS_SLUG_MISSING')
    assert.equal(calls.length, 0, 'not a single request for an unknown restaurant')
    // with a valid slug the request goes out, for exactly that restaurant
    await mod.fetchPublicCategories('parrilla-demo')
    await mod.fetchPublicProducts('parrilla-demo')
    assert.equal(calls.length, 2)
    assert.match(String(calls[0][0]), /\/categories\?businessSlug=parrilla-demo$/)
    assert.match(String(calls[1][0]), /\/products\?businessSlug=parrilla-demo$/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('no source falls back to the slug brasa-47 or reads a build-time default slug', () => {
  const offenders = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.jsx?$/.test(name) && !/\.test\.js$/.test(name)) {
        const text = code(readFileSync(full, 'utf8'))
        if (/VITE_BUSINESS_SLUG|DEFAULT_BUSINESS_SLUG|['"`]brasa-47['"`]/.test(text) && !full.endsWith(join('customer', 'homeCover.js')) && !full.includes(`${join('devtools')}`)) offenders.push(full.replace(SRC, ''))
      }
    }
  }
  walk(SRC)
  assert.deepEqual(offenders, [])
})

test('the menu without a valid slug shows a clear safe state (no loading, no retry, no request)', () => {
  for (const slug of [undefined, null, '', 'Brasa 47']) {
    const html = mod.renderMenu({ businessSlug: slug, businessName: 'Parrilla Demo' })
    assert.ok(html.includes(mod.NO_RESTAURANT_MESSAGE), String(slug))
    assert.match(html, /role="alert"/)
    assert.match(html, /Escanea de nuevo el código QR/)
    assert.doesNotMatch(html, /Cargando el menú|Reintentar|Todavía no hay productos/)
    assert.doesNotMatch(html, /brasa|47/i)
  }
})

test('the menu with a valid slug starts loading as before (header with the restaurant name and the table)', () => {
  const html = mod.renderMenu({ businessSlug: 'parrilla-demo', businessName: 'Parrilla Demo' })
  assert.match(html, /Parrilla Demo/)
  assert.match(html, /Cargando el menú…/)
  assert.match(html, /Mesa 4/)
  assert.doesNotMatch(html, /No pudimos identificar/)
})

// ---- Stored table session ---------------------------------------------------------------------------------------
test('a stored session without a valid restaurant identifier is not trusted (the customer scans again)', () => {
  const store = new Map()
  const realStorage = globalThis.sessionStorage
  globalThis.sessionStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) }
  try {
    const put = (value) => store.set('brasa47_table_session', typeof value === 'string' ? value : JSON.stringify(value))
    const ok = { sessionToken: 't1', tableName: 'Mesa 4', businessSlug: 'parrilla-demo', businessName: 'Parrilla Demo', qrToken: 'q1' }
    put(ok)
    assert.deepEqual(readStoredSession(), ok)
    for (const broken of [{ ...ok, businessSlug: undefined }, { ...ok, businessSlug: '' }, { ...ok, businessSlug: 'Brasa 47' }, { ...ok, sessionToken: '' }, { ...ok, sessionToken: undefined }, { ...ok, tableName: undefined }, 'not json', 'null', '[]', '"x"']) {
      put(broken)
      assert.equal(readStoredSession(), null, JSON.stringify(broken))
    }
    store.clear()
    assert.equal(readStoredSession(), null)
    assert.equal(isUsableStoredSession(ok), true)
    assert.equal(isUsableStoredSession(null), false)
  } finally {
    globalThis.sessionStorage = realStorage
  }
})

// ---- Wiring (source guards: the effects of CustomerApp need a browser; they are also verified there) --------------------
test('CustomerApp wires the isolation: cart scope from the session, no localStorage, slug to the home, invalid join rejected', () => {
  const source = code(read('../../pages/CustomerApp.jsx'))
  assert.doesNotMatch(source, /localStorage/)
  assert.match(source, /cartScopeFor\(stored\)/)
  assert.match(source, /attachScope\(cartScopeFor\(fresh\), \{ reset: true \}\)/)
  assert.match(source, /isValidBusinessSlug\(fresh\.businessSlug\)/)
  assert.match(source, /businessSlug=\{session\.businessSlug\}/)
  // every way a session ends detaches the cart
  assert.ok((source.match(/attachScope\(null\)/g) ?? []).length >= 4, 'no session / join failed / closed by polling / closed on order')
  const cart = code(read('../../context/CartContext.jsx'))
  assert.doesNotMatch(cart, /localStorage\.(get|set)Item/)
})
