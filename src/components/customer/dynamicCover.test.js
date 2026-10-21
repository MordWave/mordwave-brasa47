import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, test } from 'node:test'
import { loadModule } from '../../theme/testSupport.js'
import { TRANSITIONAL_COVER_SRC, homeCoverFor, resolveHomeCover } from './homeCover.js'

// 9E.9 — the welcome screen shows the restaurant's own cover; only Brasa 47 keeps the historical photo (transitional), only while it has
// no cover of its own; everyone else gets the neutral background; a failed image never switches to a different one.

const OWN = 'https://api.example.test/media/businesses/11111111-1111-4111-8111-111111111111/cover/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp'
const OTHER = 'https://api.example.test/media/businesses/22222222-2222-4222-8222-222222222222/cover/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp'

// ---- priority -----------------------------------------------------------------------------------------------------------------
test('1. a valid own cover wins for every restaurant — including Brasa 47, whose historical photo is then NOT used', () => {
  for (const slug of ['parrilla-demo', 'brasa-47', 'bistro-olivo', undefined]) {
    assert.deepEqual(resolveHomeCover({ coverUrl: OWN, businessSlug: slug }), { src: OWN, kind: 'custom' }, String(slug))
  }
})

test('2. no cover + slug EXACTLY brasa-47 -> the historical photo (transitional); every other slug -> neutral', () => {
  for (const coverUrl of [null, undefined, '']) {
    assert.deepEqual(resolveHomeCover({ coverUrl, businessSlug: 'brasa-47' }), { src: TRANSITIONAL_COVER_SRC, kind: 'transitional' })
    for (const slug of ['parrilla-demo', 'brasa-47-norte', 'brasa-4', 'Brasa-47', 'BRASA-47', ' brasa-47', 'brasa-47 ', 'xbrasa-47', '', null, undefined]) {
      assert.deepEqual(resolveHomeCover({ coverUrl, businessSlug: slug }), { src: null, kind: 'neutral' }, String(slug))
    }
  }
})

test('an invalid coverUrl counts as "no cover" (never rendered): Brasa 47 keeps its historical photo, others are neutral', () => {
  for (const bad of ['javascript:alert(1)', 'data:image/png;base64,AAAA', '/images/restaurant-hero.webp', 'https://u:p@a.test/x.webp', 5, {}]) {
    assert.deepEqual(resolveHomeCover({ coverUrl: bad, businessSlug: 'brasa-47' }), { src: TRANSITIONAL_COVER_SRC, kind: 'transitional' })
    assert.deepEqual(resolveHomeCover({ coverUrl: bad, businessSlug: 'parrilla-demo' }), { src: null, kind: 'neutral' })
  }
})

test('3. a FAILED image falls back to the neutral background — a failed custom cover never brings back the historical photo', () => {
  assert.deepEqual(resolveHomeCover({ coverUrl: OWN, businessSlug: 'parrilla-demo', failedSrc: OWN }), { src: null, kind: 'neutral' })
  assert.deepEqual(resolveHomeCover({ coverUrl: OWN, businessSlug: 'brasa-47', failedSrc: OWN }), { src: null, kind: 'neutral' }, 'Brasa 47 too: no historical photo after a custom failure')
  assert.deepEqual(resolveHomeCover({ coverUrl: null, businessSlug: 'brasa-47', failedSrc: TRANSITIONAL_COVER_SRC }), { src: null, kind: 'neutral' })
  // a failure of some OTHER url does not hide this one, and a NEW cover url is tried afresh
  assert.deepEqual(resolveHomeCover({ coverUrl: OWN, businessSlug: 'parrilla-demo', failedSrc: OTHER }), { src: OWN, kind: 'custom' })
  assert.deepEqual(resolveHomeCover({ coverUrl: OTHER, businessSlug: 'parrilla-demo', failedSrc: OWN }), { src: OTHER, kind: 'custom' })
})

test('the resolver is pure: two restaurants never influence each other (no shared state, nothing cached)', () => {
  const a = resolveHomeCover({ coverUrl: OWN, businessSlug: 'parrilla-demo' })
  const b = resolveHomeCover({ coverUrl: OTHER, businessSlug: 'bistro-olivo' })
  const c = resolveHomeCover({ coverUrl: null, businessSlug: 'amarillo-demo' })
  assert.equal(a.src, OWN)
  assert.equal(b.src, OTHER)
  assert.equal(c.src, null)
  assert.equal(resolveHomeCover({ coverUrl: OWN, businessSlug: 'parrilla-demo' }).src, OWN, 'asking again gives the same answer after the others')
  assert.equal(homeCoverFor('brasa-47'), TRANSITIONAL_COVER_SRC, 'the historical-photo lookup is unchanged')
})

// ---- the real markup ----------------------------------------------------------------------------------------------------------
let mod
before(async () => {
  mod = await loadModule(`
    import { renderToStaticMarkup } from 'react-dom/server'
    import HomeScreen, { HomeScreenView } from './components/customer/HomeScreen.jsx'
    export const view = (props) => renderToStaticMarkup(<HomeScreenView tableName="Mesa 4" onContinue={() => {}} {...props} />)
    export const screen = (props) => renderToStaticMarkup(<HomeScreen tableName="Mesa 4" onContinue={() => {}} {...props} />)
  `)
})

const heroKind = (html) => /data-cover="(custom|transitional|neutral)"/.exec(html)?.[1]
const photoSrc = (html) => /<img class="home__photo" src="([^"]+)"/.exec(html)?.[1] ?? null

test('own cover: the image is the restaurant\'s URL, the hero is not neutral, and nothing historical is present', () => {
  const html = mod.view({ businessName: 'Parrilla Demo', businessSlug: 'parrilla-demo', coverUrl: OWN })
  assert.equal(heroKind(html), 'custom')
  assert.equal(photoSrc(html), OWN)
  assert.doesNotMatch(html, /home__hero--neutral|restaurant-hero|\/images\//)
  assert.match(html, /<img class="home__photo"[^>]*alt=""[^>]*aria-hidden="true"/, 'decorative: hidden from assistive technology')
})

test('Brasa 47 with no cover keeps the historical photo; with its own cover it shows that one instead', () => {
  const historical = mod.view({ businessName: 'Brasa 47', businessSlug: 'brasa-47', coverUrl: null })
  assert.equal(heroKind(historical), 'transitional')
  assert.equal(photoSrc(historical), '/images/restaurant-hero.webp')
  const own = mod.view({ businessName: 'Brasa 47', businessSlug: 'brasa-47', coverUrl: OWN })
  assert.equal(heroKind(own), 'custom')
  assert.equal(photoSrc(own), OWN)
  assert.doesNotMatch(own, /restaurant-hero/)
})

test('any other restaurant without a cover gets the neutral background: no <img> cover, no image path, nothing of Brasa 47', () => {
  for (const slug of ['parrilla-demo', 'bistro-olivo', 'brasa-47-norte', 'Brasa-47', undefined]) {
    const html = mod.view({ businessName: 'Parrilla Demo', businessSlug: slug, coverUrl: null })
    assert.equal(heroKind(html), 'neutral', String(slug))
    assert.match(html, /class="home__hero home__hero--neutral"/)
    assert.doesNotMatch(html, /<img[^>]*home__photo/)
    assert.doesNotMatch(html, /restaurant-hero|\/images\/|\.webp|\.jpg|brasa|47/i)
  }
})

test('a failed cover renders the neutral background and no other picture (custom failure on Brasa 47 too)', () => {
  const custom = mod.view({ businessName: 'Parrilla Demo', businessSlug: 'parrilla-demo', coverUrl: OWN, failedSrc: OWN })
  assert.equal(heroKind(custom), 'neutral')
  assert.doesNotMatch(custom, /<img[^>]*home__photo/)
  const brasa = mod.view({ businessName: 'Brasa 47', businessSlug: 'brasa-47', coverUrl: OWN, failedSrc: OWN })
  assert.equal(heroKind(brasa), 'neutral')
  assert.doesNotMatch(brasa, /restaurant-hero|\/images\/|<img[^>]*home__photo/)
})

test('no visual leaks between restaurants: each screen contains only its own cover URL', () => {
  const a = mod.view({ businessName: 'A', businessSlug: 'parrilla-demo', coverUrl: OWN })
  const b = mod.view({ businessName: 'B', businessSlug: 'bistro-olivo', coverUrl: OTHER })
  const c = mod.view({ businessName: 'C', businessSlug: 'amarillo-demo', coverUrl: null })
  assert.ok(a.includes(OWN) && !a.includes(OTHER))
  assert.ok(b.includes(OTHER) && !b.includes(OWN))
  assert.ok(!c.includes(OWN) && !c.includes(OTHER) && !/<img[^>]*home__photo/.test(c))
})

test('the screen keeps what already worked: name, welcome text, table, button, logo or initials, and the stateful wrapper starts with the cover', () => {
  const html = mod.screen({ businessName: 'Parrilla Demo', businessSlug: 'parrilla-demo', coverUrl: OWN, logoUrl: null })
  assert.equal(heroKind(html), 'custom', 'the default export renders the cover on first paint (no failure yet)')
  assert.match(html, /<h1 class="home__brand">Parrilla Demo<\/h1>/)
  assert.match(html, /Bienvenidos a Parrilla Demo/)
  assert.match(html, /Mesa 4 detectada/)
  assert.match(html, /Ver menú/)
  assert.match(html, /<span class="home__mark">PD<\/span>/)
  assert.match(mod.screen({ businessName: 'Parrilla Demo', businessSlug: 'parrilla-demo', logoUrl: 'https://api.example.test/media/logo.webp' }), /<img class="home__logo" src="https:\/\/api\.example\.test\/media\/logo\.webp"/)
  assert.match(mod.screen({ businessSlug: 'parrilla-demo' }), /Bienvenidos a Nuestro restaurante/)
})

// ---- wiring --------------------------------------------------------------------------------------------------------------------
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

test('HomeScreen wiring: a load error is remembered per URL (so a new cover is retried) and the <img> is re-created when its URL changes', () => {
  const source = code(read('./HomeScreen.jsx'))
  assert.match(source, /onError=\{\(\) => onCoverError\?\.\(cover\.src\)\}/)
  assert.match(source, /useState\(null\)/)
  assert.match(source, /key=\{cover\.src\}/)
  assert.match(source, /onCoverError=\{setFailedSrc\}/)
  assert.doesNotMatch(source, /style\.display/, 'the old "hide the image" behaviour is gone: a failure now switches to the neutral background')
})

test('the transitional exception is documented as such and stays in one file; priority and removal steps are written down', () => {
  const source = read('./homeCover.js')
  assert.match(source, /TRANSITIONAL EXCEPTION/)
  assert.match(source, /remove once Brasa 47 has its own cover configured/i)
  assert.match(source, /1\. the restaurant's OWN cover/)
  assert.match(source, /never to another picture/)
})
