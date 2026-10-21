import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { cartScopeFor, createCartStore } from '../context/cartStore.js'
import { BRANDING_FIELDS, brandingFromJoin, createBrandingRefresher, mergeBranding, mergeStoredBranding, reduceSessionBranding, sanitizeBranding } from './brandingRefresh.js'
import { isValidMediaUrl, normalizeMediaUrl } from './mediaUrl.js'

// 9E.9 — the welcome-screen branding of a stored session is refreshed from `join` without touching the session or the cart.

const stored = (extra = {}) => ({
  sessionToken: 'sess-1',
  tableName: 'Mesa 4',
  businessSlug: 'bistro-olivo',
  qrToken: 'qr-olivo',
  businessName: 'Bistró Olivo',
  logoUrl: null,
  coverUrl: null,
  primaryColor: '#2F6B4F',
  accentColor: '#D9B44A',
  ...extra,
})
const joinAnswer = (extra = {}) => ({
  sessionToken: 'sess-1',
  tableName: 'Mesa 4',
  businessSlug: 'bistro-olivo',
  businessName: 'Bistró Olivo',
  logoUrl: null,
  coverUrl: null,
  primaryColor: '#2F6B4F',
  accentColor: '#D9B44A',
  ...extra,
})
const apiError = (status, code) => Object.assign(new Error(`HTTP ${status}`), { status, code })
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// ---- image URLs -----------------------------------------------------------------------------------------------------------
test('a media URL must be a plain http(s) address: no scripts, data, blobs, files, relative paths or credentials', () => {
  for (const good of ['https://api.example.test/media/businesses/a/cover/b.webp', 'http://localhost:3000/media/x.webp', 'https://a.test/x?y=1']) {
    assert.equal(isValidMediaUrl(good), true, good)
    assert.equal(normalizeMediaUrl(good), good)
  }
  const bad = ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'blob:https://a.test/1', 'file:///etc/passwd', '/media/x.webp', 'media/x.webp', '//evil.test/x.webp', 'https://user:pw@a.test/x.webp', 'ftp://a.test/x', '', ' ', null, undefined, 5, {}, [], `https://a.test/${'x'.repeat(2100)}`]
  for (const value of bad) {
    assert.equal(isValidMediaUrl(value), false, String(value).slice(0, 40))
    assert.equal(normalizeMediaUrl(value), null)
  }
})

// ---- what an answer may change ---------------------------------------------------------------------------------------------
test('sanitizeBranding keeps only valid display fields, one by one; null clears the optional ones, never the name', () => {
  const all = sanitizeBranding(joinAnswer({ businessName: 'Nuevo', logoUrl: 'https://a.test/l.webp', coverUrl: 'https://a.test/c.webp', primaryColor: '#112233', accentColor: null }))
  assert.deepEqual(all, { businessName: 'Nuevo', logoUrl: 'https://a.test/l.webp', coverUrl: 'https://a.test/c.webp', primaryColor: '#112233', accentColor: null })
  assert.deepEqual(sanitizeBranding({ coverUrl: null }), { coverUrl: null }, 'null = the cover was removed')
  const partlyBad = sanitizeBranding({ businessName: '   ', logoUrl: 'javascript:alert(1)', coverUrl: 5, primaryColor: 'red', accentColor: '#ABCDEF' })
  assert.deepEqual(partlyBad, { accentColor: '#ABCDEF' }, 'every invalid field is dropped on its own, the valid one survives')
  assert.deepEqual(sanitizeBranding({ businessName: null }), {}, 'the name can never be cleared')
  assert.deepEqual(sanitizeBranding({ businessName: 'x'.repeat(121) }), {})
  assert.deepEqual(sanitizeBranding({}), {}, 'absent fields keep the stored value')
  for (const notAnObject of [null, undefined, 'text', 5, true]) assert.deepEqual(sanitizeBranding(notAnObject), {})
  // the whole contract of what may change
  assert.deepEqual(BRANDING_FIELDS, ['businessName', 'logoUrl', 'coverUrl', 'primaryColor', 'accentColor'])
})

test('an answer is used only for the SAME session and the SAME business', () => {
  const s = stored()
  assert.deepEqual(brandingFromJoin(s, joinAnswer({ businessName: 'Otro nombre' })), { ok: true, branding: sanitizeBranding(joinAnswer({ businessName: 'Otro nombre' })) })
  assert.deepEqual(brandingFromJoin(s, joinAnswer({ sessionToken: 'sess-2' })), { ok: false, reason: 'other-session' })
  assert.deepEqual(brandingFromJoin(s, joinAnswer({ sessionToken: undefined })), { ok: false, reason: 'other-session' })
  assert.deepEqual(brandingFromJoin(s, joinAnswer({ businessSlug: 'parrilla-demo' })), { ok: false, reason: 'other-business' })
  assert.deepEqual(brandingFromJoin(s, joinAnswer({ businessSlug: 'Bistro-Olivo' })), { ok: false, reason: 'other-business' }, 'exact, case-sensitive')
  assert.deepEqual(brandingFromJoin(s, joinAnswer({ businessSlug: undefined })), { ok: false, reason: 'other-business' })
  assert.deepEqual(brandingFromJoin(s, joinAnswer({ businessSlug: 'x' })), { ok: false, reason: 'other-business' }, 'an invalid slug never matches')
  for (const bad of [null, undefined, 'x', 5]) assert.deepEqual(brandingFromJoin(s, bad), { ok: false, reason: 'invalid' })
})

test('mergeBranding changes ONLY the display fields: token, QR token, table, slug and any other key stay exactly as they were', () => {
  const s = stored({ extra: 'kept' })
  const merged = mergeBranding(s, { businessName: 'Nuevo', coverUrl: 'https://a.test/c.webp', primaryColor: null, sessionToken: 'EVIL', qrToken: 'EVIL', tableName: 'EVIL', businessSlug: 'evil', status: 'closed', extra: 'EVIL' })
  assert.equal(merged.businessName, 'Nuevo')
  assert.equal(merged.coverUrl, 'https://a.test/c.webp')
  assert.equal(merged.primaryColor, null)
  for (const key of ['sessionToken', 'qrToken', 'tableName', 'businessSlug', 'extra']) assert.equal(merged[key], s[key], key)
  assert.equal('status' in merged, false)
  assert.notEqual(merged, s)
  assert.equal(s.businessName, 'Bistró Olivo', 'the input is never mutated')
  assert.equal(mergeBranding(s, { businessName: 'Bistró Olivo', coverUrl: null }), s, 'nothing changes -> the very same object (no re-render, nothing to write)')
  assert.equal(mergeBranding(s, {}), s)
})

test('the live state and the stored copy are updated only for the session that was asked about', () => {
  const active = { status: 'active', ...stored() }
  const updated = reduceSessionBranding(active, 'sess-1', { businessName: 'Nuevo' })
  assert.equal(updated.businessName, 'Nuevo')
  assert.equal(updated.status, 'active')
  assert.equal(reduceSessionBranding(active, 'sess-OTHER', { businessName: 'Nuevo' }), active, 'another session is active now')
  for (const prev of [{ status: 'closed', tableName: 'Mesa 4' }, { status: 'none' }, { status: 'loading' }, { status: 'unavailable' }, null]) {
    assert.equal(reduceSessionBranding(prev, 'sess-1', { businessName: 'Nuevo' }), prev)
  }
  const record = stored()
  assert.equal(mergeStoredBranding(record, 'sess-1', { businessName: 'Nuevo' }).businessName, 'Nuevo')
  assert.equal(mergeStoredBranding(record, 'sess-OTHER', { businessName: 'Nuevo' }), null, 'a different session is stored now: never overwrite it')
  assert.equal(mergeStoredBranding(null, 'sess-1', { businessName: 'Nuevo' }), null)
  assert.equal(mergeStoredBranding(record, 'sess-1', { businessName: 'Bistró Olivo' }), null, 'nothing to write')
})

// ---- the refresher ------------------------------------------------------------------------------------------------------------
function harness({ join, current = () => true } = {}) {
  const calls = { join: [], apply: [] }
  const refresh = createBrandingRefresher({
    join: (qr) => {
      calls.join.push(qr)
      return join(qr)
    },
    isCurrent: (s) => current(s),
    apply: (s, branding) => calls.apply.push({ token: s.sessionToken, branding }),
  })
  return { refresh, calls }
}

test('asks join ONCE with the QR token of the stored session and applies the changed display fields', async () => {
  const { refresh, calls } = harness({ join: async () => joinAnswer({ businessName: 'Nuevo', coverUrl: 'https://a.test/c.webp', primaryColor: '#112233' }) })
  const result = await refresh(stored())
  assert.deepEqual(result, { status: 'updated' })
  assert.deepEqual(calls.join, ['qr-olivo'], 'the QR token, never the session token')
  assert.equal(calls.apply.length, 1)
  assert.deepEqual(calls.apply[0].branding.coverUrl, 'https://a.test/c.webp')
  assert.equal(calls.apply[0].branding.businessName, 'Nuevo')
})

test('an unchanged answer applies nothing', async () => {
  const { refresh, calls } = harness({ join: async () => joinAnswer() })
  assert.deepEqual(await refresh(stored()), { status: 'unchanged' })
  assert.equal(calls.apply.length, 0)
})

test('a cover that was removed (null) replaces the stored one', async () => {
  const { refresh, calls } = harness({ join: async () => joinAnswer({ coverUrl: null }) })
  assert.deepEqual(await refresh(stored({ coverUrl: 'https://a.test/old.webp' })), { status: 'updated' })
  assert.equal(calls.apply[0].branding.coverUrl, null)
})

test('no repeated requests: the same session is asked once per page load, even with concurrent or repeated calls', async () => {
  const d = deferred()
  const { refresh, calls } = harness({ join: () => d.promise })
  const first = refresh(stored())
  const second = refresh(stored()) // e.g. a re-run of an effect while the first is still in flight
  assert.deepEqual(await second, { status: 'skipped' })
  d.resolve(joinAnswer({ businessName: 'Nuevo' }))
  assert.deepEqual(await first, { status: 'updated' })
  assert.deepEqual(await refresh(stored()), { status: 'skipped' }, 'and not again afterwards')
  assert.equal(calls.join.length, 1)
  // another session (another token) is a different question
  await refresh(stored({ sessionToken: 'sess-2' }))
  assert.equal(calls.join.length, 2)
})

test('a session without a QR token cannot be asked about: skipped, no request', async () => {
  const { refresh, calls } = harness({ join: async () => joinAnswer() })
  for (const s of [stored({ qrToken: undefined }), stored({ qrToken: '' }), stored({ qrToken: 5 }), stored({ sessionToken: undefined }), null, undefined]) {
    assert.deepEqual(await refresh(s), { status: 'skipped' })
  }
  assert.equal(calls.join.length, 0)
})

test('LATE answers are dropped whole: the session closed or another one was joined while the request was in flight', async () => {
  let live = 'sess-1'
  const d = deferred()
  const { refresh, calls } = harness({ join: () => d.promise, current: (s) => live === s.sessionToken })
  const pending = refresh(stored())
  live = 'sess-NEW' // the customer joined another QR / the session closed
  d.resolve(joinAnswer({ businessName: 'Tarde' }))
  assert.deepEqual(await pending, { status: 'ignored-stale' })
  assert.equal(calls.apply.length, 0)

  // the answer of the old request never leaks into the session that is live now: asking about the new one is a separate request
  const next = harness({ join: async () => joinAnswer({ sessionToken: 'sess-NEW', businessSlug: 'parrilla-demo', businessName: 'Parrilla Demo' }), current: () => true })
  const fresh = { ...stored({ sessionToken: 'sess-NEW', businessSlug: 'parrilla-demo', qrToken: 'qr-parrilla', businessName: 'Parrilla' }) }
  assert.deepEqual(await next.refresh(fresh), { status: 'updated' })
  assert.equal(next.calls.apply[0].token, 'sess-NEW')
})

test('an answer for ANOTHER session or ANOTHER business is never applied', async () => {
  const cases = [
    [joinAnswer({ sessionToken: 'sess-2', businessName: 'Otra sesión' }), 'ignored-other-session'],
    [joinAnswer({ businessSlug: 'parrilla-demo', businessName: 'Otro negocio', coverUrl: 'https://a.test/ajena.webp' }), 'ignored-other-business'],
    [null, 'ignored-invalid'],
    ['texto', 'ignored-invalid'],
  ]
  for (const [answer, status] of cases) {
    const { refresh, calls } = harness({ join: async () => answer })
    assert.deepEqual(await refresh(stored()), { status })
    assert.equal(calls.apply.length, 0, status)
  }
})

test('connection and server errors keep the stored branding, are never retried and never claimed as success', async () => {
  for (const error of [new TypeError('Failed to fetch'), apiError(500), apiError(503, 'TEMPORARILY_UNAVAILABLE'), apiError(504, 'REQUEST_TIMEOUT'), apiError(429, 'RATE_LIMITED'), apiError(400)]) {
    const { refresh, calls } = harness({ join: async () => { throw error } })
    assert.deepEqual(await refresh(stored()), { status: 'failed' })
    assert.equal(calls.apply.length, 0)
    assert.deepEqual(await refresh(stored()), { status: 'skipped' }, 'no automatic retry')
    assert.equal(calls.join.length, 1)
  }
})

test('404 TABLE_SESSION_UNAVAILABLE is reported as "unavailable" and changes nothing here (the status poll is the one place that ends a session)', async () => {
  const { refresh, calls } = harness({ join: async () => { throw apiError(404, 'TABLE_SESSION_UNAVAILABLE') } })
  assert.deepEqual(await refresh(stored()), { status: 'unavailable' })
  assert.equal(calls.apply.length, 0)
  // a 404 with another code is just a failure
  const other = harness({ join: async () => { throw apiError(404, 'SOMETHING_ELSE') } })
  assert.deepEqual(await other.refresh(stored()), { status: 'failed' })
})

test('refreshing the branding never touches the cart or the session identity (real cart store, real scope)', async () => {
  const memory = () => {
    const data = new Map()
    return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => void data.set(k, String(v)), removeItem: (k) => void data.delete(k), data }
  }
  const storage = memory()
  const session = stored()
  const cart = createCartStore({ storage })
  cart.attachScope(cartScopeFor(session))
  cart.addItem({ cartItemId: 'l1', productId: 'p1', name: 'Plato', quantity: 2, unitPrice: 1000, lineTotal: 2000, removed: [], added: [] })
  cart.setOrderNote('sin cebolla')
  const cartBefore = cart.getState()
  const storedBefore = storage.getItem('brasa47_cart_v2')

  let live = { status: 'active', ...session }
  const refresher = createBrandingRefresher({
    join: async () => joinAnswer({ businessName: 'Nuevo', logoUrl: 'https://a.test/l.webp', coverUrl: 'https://a.test/c.webp', primaryColor: '#111111', accentColor: '#EEEEEE' }),
    isCurrent: () => live.status === 'active',
    apply: (s, branding) => {
      live = reduceSessionBranding(live, s.sessionToken, branding)
    },
  })
  assert.deepEqual(await refresher(session), { status: 'updated' })

  // all five display fields changed...
  assert.deepEqual([live.businessName, live.logoUrl, live.coverUrl, live.primaryColor, live.accentColor], ['Nuevo', 'https://a.test/l.webp', 'https://a.test/c.webp', '#111111', '#EEEEEE'])
  // ...and nothing else did
  for (const key of ['sessionToken', 'qrToken', 'tableName', 'businessSlug']) assert.equal(live[key], session[key], key)
  assert.equal(cartScopeFor(live), cartScopeFor(session), 'the cart scope (slug:sessionToken) is identical, so the cart is still the same one')
  assert.equal(cart.getState(), cartBefore, 'the cart store was never touched (same state object)')
  assert.equal(storage.getItem('brasa47_cart_v2'), storedBefore, 'nor was its persisted copy')
  assert.equal(cart.getState().items[0].quantity, 2)
  assert.equal(cart.getState().orderNote, 'sin cebolla')
})

// ---- wiring (the effects need a browser; they are also verified there) -------------------------------------------------------------
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const app = code(readFileSync(new URL('../pages/CustomerApp.jsx', import.meta.url), 'utf8'))

test('CustomerApp wiring: one refresher, started only when a stored session is resumed; never by the poll, a fresh join or the cart', () => {
  assert.equal((app.match(/createBrandingRefresher\(/g) ?? []).length, 1)
  assert.equal((app.match(/refresherRef\.current\(stored\)/g) ?? []).length, 1, 'the refresh is requested in exactly one place')
  const resume = app.slice(app.indexOf('function resumeStoredSession'), app.indexOf('async function init()'))
  assert.match(resume, /refresherRef\.current\(stored\)/)
  assert.match(resume, /attachScope\(cartScopeFor\(stored\)\)/)
  // both ways of recovering a stored session go through it
  assert.equal((app.match(/^\s+resumeStoredSession\(stored\)/gm) ?? []).length, 2)
  // the branding apply never touches the cart or ends/creates a session
  const apply = app.slice(app.indexOf('function applyBranding'), app.indexOf('function resumeStoredSession'))
  assert.doesNotMatch(apply, /attachScope|clearCart|setCheckout|clearStoredSession|joinTableSession|setSession\(\{/)
  assert.match(apply, /reduceSessionBranding/)
  assert.match(apply, /mergeStoredBranding/)
  // the only other join is the initial one for a QR that is not stored
  assert.equal((app.match(/joinTableSession\(/g) ?? []).length, 1)
  assert.equal((app.match(/join: joinTableSession/g) ?? []).length, 1)
})

test('CustomerApp wiring: the poll depends on primitives (a branding refresh never restarts its timer) and the home gets the cover', () => {
  assert.equal((app.match(/setInterval\(/g) ?? []).length, 1)
  assert.match(app, /\[sessionStatus, activeToken, activeTable, attachScope\]/)
  assert.match(app, /coverUrl=\{session\.coverUrl\}/)
  assert.match(app, /\.\.\.safeBranding\(result\)/)
  assert.match(app, /isCurrent: \(s\) => sessionRef\.current\.status === 'active' && sessionRef\.current\.sessionToken === s\.sessionToken/)
})
