import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { loadModule } from '../theme/testSupport.js'
import { isSameSession, isStaleSessionToken, mayEndSessionOnSuspension, revalidateSession, sessionAfterPasswordChangeRequired, shouldEndSessionOnUnauthorized } from './sessionRaces.js'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}
const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

const USER = { id: 'u1', email: 'admin@brasa47.cl', role: 'ADMIN', businessId: 'b1', active: true }
const OLD = { accessToken: 'old-token', user: { ...USER, mustChangePassword: true } }
const NEW = { accessToken: 'new-token', user: { ...USER, mustChangePassword: false } }

// ======================================================================================================================
// the decisions
// ======================================================================================================================
test('stale token: only when a session exists, the request carried a token, and it is not the current one', () => {
  assert.equal(isStaleSessionToken(NEW, 'old-token'), true)
  assert.equal(isStaleSessionToken(NEW, 'new-token'), false)
  assert.equal(isStaleSessionToken(NEW, undefined), false, 'no token on record: treated as current (the behaviour before)')
  assert.equal(isStaleSessionToken(null, 'old-token'), false)
})

test('same session: needs a session AND the very token that made the request; none (logged out) is stale', () => {
  assert.equal(isSameSession(NEW, 'new-token'), true)
  assert.equal(isSameSession(NEW, 'old-token'), false)
  assert.equal(isSameSession(null, 'new-token'), false, 'a late answer never resurrects a closed session')
  assert.equal(isSameSession(NEW, undefined), false)
})

test('the three late-answer rules, A / B / C, against a session that was just replaced', () => {
  // A — 401 of the old token: does not end the new session; a 401 of the CURRENT token still does
  assert.equal(shouldEndSessionOnUnauthorized(NEW, 'old-token'), false)
  assert.equal(shouldEndSessionOnUnauthorized(NEW, 'new-token'), true)
  assert.equal(shouldEndSessionOnUnauthorized(null, 'x'), true, 'with no session, ending it is a harmless no-op')
  // B — 403 PASSWORD_CHANGE_REQUIRED of the old token: does not re-activate the forced change on the new session
  assert.equal(sessionAfterPasswordChangeRequired(NEW, 'old-token'), null)
  // ...but for the current token it does, once
  const flagged = sessionAfterPasswordChangeRequired(NEW, 'new-token')
  assert.equal(flagged.user.mustChangePassword, true)
  assert.equal(flagged.accessToken, 'new-token')
  assert.equal(sessionAfterPasswordChangeRequired(flagged, 'new-token'), null, 'already flagged: nothing to do, no loop')
  assert.equal(sessionAfterPasswordChangeRequired(null, 'new-token'), null)
  // a suspension (403 BUSINESS_INACTIVE) of the old token cannot end the new session either
  assert.equal(mayEndSessionOnSuspension(NEW, 'old-token'), false)
  assert.equal(mayEndSessionOnSuspension(NEW, 'new-token'), true)
})

// ======================================================================================================================
// C — GET /auth/me revalidation, every ordering
// ======================================================================================================================
function holder(initial) {
  const state = { session: initial, applied: [], dropped: [] }
  return {
    state,
    get: () => state.session,
    replace: (next) => (state.session = next), // what changePassword / login / logout do (ref first)
    onValid: (next) => (state.applied.push(next), (state.session = next)),
    onInvalid: (error) => (state.dropped.push(error), (state.session = null)),
  }
}

test('C: a LATE 200 of the old token (outdated user) does not replace the updated session nor restore mustChangePassword = true', async () => {
  const h = holder(OLD)
  const gate = deferred()
  const pending = revalidateSession({ stored: OLD, fetchMe: () => gate.promise, getSession: h.get, onValid: h.onValid, onInvalid: h.onInvalid })
  h.replace(NEW) // the password change completes while GET /auth/me is still in flight
  gate.resolve({ ...OLD.user }) // the old, outdated user (mustChangePassword still true) arrives
  assert.deepEqual(await pending, { applied: false })
  assert.deepEqual(h.state.applied, [])
  assert.deepEqual(h.state.session, NEW, 'token and user are exactly the new ones')
  assert.equal(h.state.session.user.mustChangePassword, false)
})

test('C: a LATE failure of the old token (revoked by the change, so 401) does not log the new session out', async () => {
  const h = holder(OLD)
  const gate = deferred()
  const pending = revalidateSession({ stored: OLD, fetchMe: () => gate.promise, getSession: h.get, onValid: h.onValid, onInvalid: h.onInvalid })
  h.replace(NEW)
  gate.reject(Object.assign(new Error('401'), { status: 401 }))
  assert.deepEqual(await pending, { applied: false })
  assert.deepEqual(h.state.dropped, [])
  assert.deepEqual(h.state.session, NEW)
})

test('C: nothing is resurrected after a logout, and another login in the meantime wins too', async () => {
  for (const meanwhile of [null, { accessToken: 'someone-else', user: { id: 'u9' } }]) {
    const h = holder(OLD)
    const gate = deferred()
    const pending = revalidateSession({ stored: OLD, fetchMe: () => gate.promise, getSession: h.get, onValid: h.onValid, onInvalid: h.onInvalid })
    h.replace(meanwhile)
    gate.resolve({ ...OLD.user })
    assert.equal((await pending).applied, false)
    assert.deepEqual(h.state.session, meanwhile)
    assert.deepEqual(h.state.applied, [])
  }
})

test('C: when nothing changed in the meantime the revalidation applies its answer as always (success keeps the session with the fresh user, failure ends it)', async () => {
  const h = holder(OLD)
  const fresh = { ...OLD.user, mustChangePassword: false }
  assert.deepEqual(await revalidateSession({ stored: OLD, fetchMe: async () => fresh, getSession: h.get, onValid: h.onValid, onInvalid: h.onInvalid }), { applied: true })
  assert.deepEqual(h.state.session, { accessToken: 'old-token', user: fresh })

  const g = holder(OLD)
  const error = Object.assign(new Error('401'), { status: 401 })
  assert.deepEqual(await revalidateSession({ stored: OLD, fetchMe: async () => Promise.reject(error), getSession: g.get, onValid: g.onValid, onInvalid: g.onInvalid }), { applied: true })
  assert.deepEqual(g.state.dropped, [error])
  assert.equal(g.state.session, null)
})

// ======================================================================================================================
// A and B through the REAL apiFetch, wired exactly like AuthContext wires it
// ======================================================================================================================
let mod
const saved = { fetch: globalThis.fetch, localStorage: globalThis.localStorage }
before(async () => {
  mod = await loadModule(`
    import { renderToStaticMarkup } from 'react-dom/server'
    export { ApiError, apiFetch, setBusinessInactiveHandler, setPasswordChangeRequiredHandler, setUnauthorizedHandler } from './services/api.js'
    import { AuthProvider, useAuth } from './context/AuthContext.jsx'
    let captured
    function Probe() { captured = useAuth(); return null }
    export const mountAuth = () => renderToStaticMarkup(<AuthProvider><Probe /></AuthProvider>)
    export const auth = () => captured
  `)
})
after(() => {
  globalThis.fetch = saved.fetch
  globalThis.localStorage = saved.localStorage
  for (const set of [mod.setUnauthorizedHandler, mod.setPasswordChangeRequiredHandler, mod.setBusinessInactiveHandler]) set(null)
})

// the session as AuthContext keeps it, and the handlers it registers (same pure rules, same arguments)
function wireLikeAuthContext(initial) {
  const h = holder(initial)
  const events = { logouts: 0, flagged: 0, suspended: 0 }
  mod.setUnauthorizedHandler((failedToken) => {
    if (!shouldEndSessionOnUnauthorized(h.get(), failedToken)) return
    events.logouts += 1
    h.replace(null)
  })
  mod.setPasswordChangeRequiredHandler((failedToken) => {
    const next = sessionAfterPasswordChangeRequired(h.get(), failedToken)
    if (!next) return
    events.flagged += 1
    h.replace(next)
  })
  mod.setBusinessInactiveHandler((failedToken) => {
    if (!mayEndSessionOnSuspension(h.get(), failedToken)) return 'own'
    events.suspended += 1
    h.replace(null)
    return 'own'
  })
  return { h, events }
}

test('A + B + suspension, end to end: late answers of the OLD token never touch the NEW session; the same answers for the CURRENT token do', async () => {
  const cases = [
    ['A: 401', jsonResponse(401, { message: 'x' }), (e) => e.logouts, (e) => assert.equal(e.logouts, 0)],
    ['B: 403 PASSWORD_CHANGE_REQUIRED', jsonResponse(403, { errorCode: 'PASSWORD_CHANGE_REQUIRED' }), (e) => e.flagged, (e) => assert.equal(e.flagged, 0)],
    ['403 BUSINESS_INACTIVE', jsonResponse(403, { errorCode: 'BUSINESS_INACTIVE' }), (e) => e.suspended, (e) => assert.equal(e.suspended, 0)],
  ]
  for (const [label, response, counter] of cases) {
    // 1. a request made with the OLD token is still pending when the password change replaces the session
    const { h, events } = wireLikeAuthContext(OLD)
    const gate = deferred()
    globalThis.fetch = () => gate.promise
    const late = mod.apiFetch('/orders/admin', { token: 'old-token' })
    const settled = late.then(() => 'ok', (error) => error.status)
    h.replace(NEW)
    gate.resolve(response)
    await settled
    assert.equal(counter(events), 0, `${label}: the late answer of the old token did nothing`)
    assert.deepEqual(h.get(), NEW, `${label}: the new session is exactly as it was (token, user, mustChangePassword = false)`)

    // 2. the same answer for a request made with the CURRENT token still has its normal effect
    globalThis.fetch = async () => response
    await mod.apiFetch('/orders/admin', { token: 'new-token' }).catch(() => {})
    assert.equal(counter(events), 1, `${label}: for the current token it still applies`)
  }
})

test('A, for the current token: a 401 still closes the session (and only then)', async () => {
  const { h, events } = wireLikeAuthContext(NEW)
  globalThis.fetch = async () => jsonResponse(401, {})
  await mod.apiFetch('/x', { token: 'old-token' }).catch(() => {})
  assert.equal(events.logouts, 0)
  assert.deepEqual(h.get(), NEW)
  await mod.apiFetch('/x', { token: 'new-token' }).catch(() => {})
  assert.equal(events.logouts, 1)
  assert.equal(h.get(), null)
})

// ======================================================================================================================
// the real AuthProvider: the reply of a password change that arrives after a logout
// ======================================================================================================================
function stubStorage(initial = {}) {
  const data = { ...initial }
  const writes = []
  return {
    data,
    writes,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => (writes.push(['set', k, String(v)]), (data[k] = String(v))),
    removeItem: (k) => (writes.push(['remove', k]), delete data[k]),
  }
}

test('AuthProvider.changePassword: if the user logs out while it is in flight, its reply is dropped — nothing is stored, no session is resurrected', async () => {
  const storage = stubStorage({ brasa47_admin_session: JSON.stringify(OLD) })
  globalThis.localStorage = storage
  const realConsoleError = console.error
  console.error = () => {}
  try {
    mod.mountAuth()
    const auth = mod.auth()
    const gate = deferred()
    globalThis.fetch = () => gate.promise
    const pending = auth.changePassword('Temporal-Passw0rd', 'Mi-Nueva-Clave-2026')
    auth.logout() // the user clicks "Cerrar sesión" meanwhile
    gate.resolve(jsonResponse(200, { accessToken: 'new-token', user: NEW.user }))
    assert.equal(await pending, null)
    assert.equal(storage.data.brasa47_admin_session, undefined, 'the closed session stays closed')
    assert.deepEqual(storage.writes.filter(([op]) => op === 'set'), [], 'the new token was never written')
  } finally {
    console.error = realConsoleError
  }
})

// ======================================================================================================================
// wiring (source level): AuthContext uses these rules, and the ref is the session as it is NOW
// ======================================================================================================================
test('AuthContext applies the rules: handlers, revalidation and the reply of a password change all check the originating session', () => {
  const ctx = code(read('./AuthContext.jsx'))
  assert.match(ctx, /shouldEndSessionOnUnauthorized\(sessionRef\.current, failedToken\)/)
  assert.match(ctx, /sessionAfterPasswordChangeRequired\(sessionRef\.current, failedToken\)/)
  assert.match(ctx, /mayEndSessionOnSuspension\(sessionRef\.current, failedToken\)/)
  assert.match(ctx, /await revalidateSession\(\{[\s\S]*getSession: \(\) => sessionRef\.current/)
  assert.match(ctx, /if \(!isSameSession\(sessionRef\.current, current\.accessToken\)\) return null/)
  // the ref is updated synchronously wherever the session changes
  assert.match(ctx, /const logout = useCallback\(\(\) => \{\s*sessionRef\.current = null/)
  assert.match(ctx, /sessionRef\.current = next\s*localStorage\.setItem\(SESSION_KEY, JSON\.stringify\(next\)\)\s*setSession\(next\)/)
  // the old direct writes after an await are gone from the revalidation
  assert.doesNotMatch(ctx, /const user = await apiFetch\('\/auth\/me'/)
  assert.doesNotMatch(ctx, /tenant\//)
  const api = code(read('../services/api.js'))
  assert.match(api, /onUnauthorized\(token\)/)
  assert.match(api, /onPasswordChangeRequired\(token\)/)
  assert.match(api, /onBusinessInactive\(token\)/)
})
