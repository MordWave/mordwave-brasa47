import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { loadModule } from '../theme/testSupport.js'
import { isPasswordChangeRequiredResponse, markPasswordChangeRequired, needsPasswordChange, sessionFromPasswordChange } from '../context/passwordChange.js'
import { describePasswordError } from './passwordErrors.js'
import { createPasswordChangeStore } from './passwordChangeStore.js'
import { PASSWORD_MAX_BYTES, PASSWORD_MIN_LENGTH, utf8Length, validatePasswordChange } from './passwordPolicy.js'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const apiError = (status, errorCode, extra = {}) => Object.assign(new Error(`HTTP ${status} (technical, english)`), { status, code: errorCode, ...extra })
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

const EMAIL = 'admin@brasa47.cl'
const valid = { currentPassword: 'Temporal-Passw0rd', newPassword: 'Mi-Nueva-Clave-2026', confirmation: 'Mi-Nueva-Clave-2026' }

// ======================================================================================================================
// the policy shown in the form (visual only: the backend decides)
// ======================================================================================================================
test('policy: a valid form has no errors; the numbers are the backend ones (12 characters, 72 bytes)', () => {
  assert.deepEqual(validatePasswordChange(valid, EMAIL), {})
  assert.equal(PASSWORD_MIN_LENGTH, 12)
  assert.equal(PASSWORD_MAX_BYTES, 72)
})

test('policy: at least 12 characters (code points); 11 is refused, 12 accepted', () => {
  const at = (n) => ({ ...valid, newPassword: 'a'.repeat(n), confirmation: 'a'.repeat(n) })
  assert.match(validatePasswordChange(at(11), EMAIL).newPassword, /al menos 12 caracteres/)
  assert.deepEqual(validatePasswordChange(at(12), EMAIL), {})
  const emoji = (n) => ({ ...valid, newPassword: '😀'.repeat(n), confirmation: '😀'.repeat(n) })
  assert.match(validatePasswordChange(emoji(11), EMAIL).newPassword, /al menos 12/, '11 emoji are 11 characters')
  assert.deepEqual(validatePasswordChange(emoji(12), EMAIL), {})
})

test('policy: at most 72 BYTES in UTF-8 (not characters): 72 ASCII ok, 73 refused, accents and emoji cost more', () => {
  const at = (pw) => ({ ...valid, newPassword: pw, confirmation: pw })
  assert.deepEqual(validatePasswordChange(at('a'.repeat(72)), EMAIL), {})
  assert.match(validatePasswordChange(at('a'.repeat(73)), EMAIL).newPassword, /72 bytes/)
  assert.equal(utf8Length('ñ'.repeat(36)), 72)
  assert.deepEqual(validatePasswordChange(at('ñ'.repeat(36)), EMAIL), {})
  assert.match(validatePasswordChange(at('ñ'.repeat(37)), EMAIL).newPassword, /72 bytes/, '37 characters but 74 bytes')
  assert.deepEqual(validatePasswordChange(at('😀'.repeat(18)), EMAIL), {})
  assert.match(validatePasswordChange(at('😀'.repeat(19)), EMAIL).newPassword, /72 bytes/)
})

test('policy: not the e-mail (any case, outer spaces), different from the current password, confirmation must match, blank refused', () => {
  const email = { ...valid, newPassword: ' Admin@Brasa47.CL ', confirmation: ' Admin@Brasa47.CL ' }
  assert.match(validatePasswordChange(email, EMAIL).newPassword, /correo/)
  const same = { currentPassword: 'Same-Passw0rd-123', newPassword: 'Same-Passw0rd-123', confirmation: 'Same-Passw0rd-123' }
  assert.match(validatePasswordChange(same, EMAIL).newPassword, /distinta/)
  assert.match(validatePasswordChange({ ...valid, confirmation: 'otra cosa distinta' }, EMAIL).confirmation, /no coincide/)
  assert.match(validatePasswordChange({ ...valid, newPassword: '            ', confirmation: '            ' }, EMAIL).newPassword, /Escribe/)
  assert.match(validatePasswordChange({ ...valid, currentPassword: '' }, EMAIL).currentPassword, /actual/)
  assert.deepEqual(Object.keys(validatePasswordChange({}, EMAIL)).sort(), ['currentPassword', 'newPassword'])
})

// ======================================================================================================================
// what the backend answers, in Spanish
// ======================================================================================================================
test('errors: every documented answer of POST /auth/change-password has its own sentence, tied to its field; the raw message never shows', () => {
  const cases = [
    [apiError(403, 'CURRENT_PASSWORD_INCORRECT'), 'current-password', 'currentPassword', /contraseña actual no es correcta/],
    [apiError(400, 'PASSWORD_UNCHANGED'), 'unchanged', 'newPassword', /distinta de la actual/],
    [apiError(400, 'PASSWORD_TOO_SHORT'), 'policy', 'newPassword', /al menos 12/],
    [apiError(400, 'PASSWORD_TOO_LONG'), 'policy', 'newPassword', /72 bytes/],
    [apiError(400, 'PASSWORD_EQUALS_EMAIL'), 'policy', 'newPassword', /correo/],
    [apiError(400, 'PASSWORD_REQUIRED'), 'policy', 'newPassword', /Escribe/],
    [apiError(400, undefined), 'invalid', undefined, /Revisa los datos/],
    [apiError(409, 'CREDENTIALS_CHANGED'), 'conflict', undefined, /otro cambio de contraseña/i],
    [apiError(429, 'RATE_LIMITED'), 'rate-limited', undefined, /demasiados intentos/i],
    [apiError(401, undefined), 'unauthorized', undefined, /sesión expiró/],
    [apiError(403, 'BUSINESS_INACTIVE'), 'suspended', undefined, /suspendido/],
    [apiError(403, 'SOMETHING_ELSE'), 'forbidden', undefined, /no tiene permiso/],
    [apiError(500, undefined), 'server', undefined, /No se pudo cambiar/],
    [new TypeError('Failed to fetch'), 'network', undefined, /conectar con el servidor/],
  ]
  for (const [error, kind, field, message] of cases) {
    const described = describePasswordError(error)
    assert.equal(described.kind, kind, JSON.stringify([error.status, error.code]))
    assert.equal(described.field, field)
    assert.match(described.message, message)
    assert.doesNotMatch(described.message, /HTTP|technical|english/)
  }
})

test('errors: a wrong CURRENT password is a field error (403), never the "session expired" 401 path', () => {
  assert.equal(describePasswordError(apiError(403, 'CURRENT_PASSWORD_INCORRECT')).kind, 'current-password')
  assert.notEqual(describePasswordError(apiError(403, 'CURRENT_PASSWORD_INCORRECT')).kind, 'unauthorized')
})

// ======================================================================================================================
// the form's state machine
// ======================================================================================================================
test('store: invalid input never reaches the network; field errors come from the policy', async () => {
  let calls = 0
  const store = createPasswordChangeStore({ change: async () => void (calls += 1) })
  const result = await store.submit({ currentPassword: '', newPassword: 'short', confirmation: 'x' }, EMAIL)
  assert.equal(result.ok, false)
  assert.equal(calls, 0)
  assert.deepEqual(Object.keys(store.getState().fieldErrors).sort(), ['confirmation', 'currentPassword', 'newPassword'].filter((k) => k !== 'confirmation'))
  assert.equal(store.getState().phase, 'idle')
})

test('store: success calls change() exactly once with the two passwords, ends in "done" and keeps no password', async () => {
  const seen = []
  const store = createPasswordChangeStore({ change: async (...args) => void seen.push(args) })
  const events = []
  store.subscribe(() => events.push(store.getState().phase))
  const result = await store.submit(valid, EMAIL)
  assert.equal(result.ok, true)
  assert.deepEqual(seen, [[valid.currentPassword, valid.newPassword]])
  assert.equal(store.getState().phase, 'done')
  assert.deepEqual(events, ['saving', 'done'])
  const everything = JSON.stringify(store.getState())
  assert.ok(!everything.includes(valid.currentPassword) && !everything.includes(valid.newPassword), 'the store never holds a password')
})

test('store: a second submit while one is in flight is ignored (one request)', async () => {
  const gate = deferred()
  let calls = 0
  const store = createPasswordChangeStore({ change: () => (calls += 1, gate.promise) })
  const first = store.submit(valid, EMAIL)
  assert.equal(store.getState().phase, 'saving', 'flipped synchronously, before the request resolves')
  assert.deepEqual(await store.submit(valid, EMAIL), { ok: false, ignored: true })
  assert.equal(calls, 1)
  gate.resolve()
  assert.equal((await first).ok, true)
})

test('store: a failure keeps the form usable, shows the message next to its field (or as a general error) and allows a retry', async () => {
  let attempt = 0
  const store = createPasswordChangeStore({
    change: async () => {
      attempt += 1
      if (attempt === 1) throw apiError(403, 'CURRENT_PASSWORD_INCORRECT')
      if (attempt === 2) throw apiError(500)
    },
  })
  assert.equal((await store.submit(valid, EMAIL)).ok, false)
  assert.equal(store.getState().phase, 'idle')
  assert.match(store.getState().fieldErrors.currentPassword, /actual no es correcta/)
  assert.equal(store.getState().error, null)
  assert.equal((await store.submit(valid, EMAIL)).ok, false)
  assert.equal(store.getState().error.kind, 'server')
  assert.deepEqual(store.getState().fieldErrors, {})
  assert.equal((await store.submit(valid, EMAIL)).ok, true, 'a later attempt works')
})

// ======================================================================================================================
// session rules
// ======================================================================================================================
test('forced change: only a real `true` counts, and only the exact 403 + code is "required"', () => {
  assert.equal(needsPasswordChange({ mustChangePassword: true }), true)
  for (const user of [{ mustChangePassword: false }, {}, null, undefined, { mustChangePassword: 'true' }, { mustChangePassword: 1 }]) assert.equal(needsPasswordChange(user), false, JSON.stringify(user))
  assert.equal(isPasswordChangeRequiredResponse(403, 'PASSWORD_CHANGE_REQUIRED'), true)
  for (const [status, errorCode] of [[403, 'BUSINESS_INACTIVE'], [403, undefined], [401, 'PASSWORD_CHANGE_REQUIRED'], [200, 'PASSWORD_CHANGE_REQUIRED']]) assert.equal(isPasswordChangeRequiredResponse(status, errorCode), false)
})

test('stale state: a 403 PASSWORD_CHANGE_REQUIRED flips the stored session to the forced change — same token, same user, no loop', () => {
  const session = { accessToken: 't1', user: { id: 'u1', email: EMAIL, role: 'ADMIN', mustChangePassword: false } }
  const flipped = markPasswordChangeRequired(session)
  assert.deepEqual(flipped, { accessToken: 't1', user: { ...session.user, mustChangePassword: true } })
  assert.equal(session.user.mustChangePassword, false, 'the input is not mutated')
  assert.equal(markPasswordChangeRequired(flipped), flipped, 'already flagged: the SAME object comes back, so nothing updates again')
  assert.equal(markPasswordChangeRequired(null), null)
  const legacy = { accessToken: 't0', user: { id: 'u0' } }
  assert.equal(markPasswordChangeRequired(legacy).user.mustChangePassword, true, 'a session stored before the flag existed is flipped too')
})

test('a successful change replaces token AND user together; anything else is refused (never the old token with a new user)', () => {
  const user = { id: 'u1', email: EMAIL, role: 'ADMIN', businessId: 'b1', active: true, mustChangePassword: false }
  assert.deepEqual(sessionFromPasswordChange({ accessToken: 'new-token', user }), { accessToken: 'new-token', user })
  for (const bad of [null, {}, { accessToken: 'x' }, { user }, { accessToken: '', user }, { accessToken: 5, user }, { accessToken: 'x', user: { ...user, mustChangePassword: true } }, { accessToken: 'x', user: { ...user, mustChangePassword: undefined } }, { accessToken: 'x', user: { email: EMAIL, mustChangePassword: false } }]) {
    assert.equal(sessionFromPasswordChange(bad), null, JSON.stringify(bad))
  }
})

// ======================================================================================================================
// the real API layer and AuthProvider (stubbed fetch / storage)
// ======================================================================================================================
let mod
const saved = { localStorage: globalThis.localStorage, fetch: globalThis.fetch }
before(async () => {
  mod = await loadModule(`
    import { renderToStaticMarkup } from 'react-dom/server'
    export { ApiError, apiFetch, setPasswordChangeRequiredHandler, setUnauthorizedHandler, setBusinessInactiveHandler } from './services/api.js'
    import { AuthProvider, useAuth } from './context/AuthContext.jsx'
    let captured
    function Probe() { captured = useAuth(); return null }
    export const mountAuth = () => renderToStaticMarkup(<AuthProvider><Probe /></AuthProvider>)
    export const auth = () => captured
  `)
})
after(() => {
  globalThis.localStorage = saved.localStorage
  globalThis.fetch = saved.fetch
})

const SESSION_KEY = 'brasa47_admin_session'
function stubStorage(initial = {}) {
  const data = { ...initial }
  const writes = []
  return {
    data,
    writes,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => (writes.push([k, String(v)]), (data[k] = String(v))),
    removeItem: (k) => (writes.push([k, null]), delete data[k]),
  }
}
const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

test('apiFetch: a 401 reports the token it was sent with; the exact 403 PASSWORD_CHANGE_REQUIRED calls its own handler, other 403s do not', async () => {
  const unauthorized = []
  let required = 0
  mod.setUnauthorizedHandler((token) => unauthorized.push(token))
  mod.setPasswordChangeRequiredHandler(() => (required += 1))
  try {
    globalThis.fetch = async () => jsonResponse(401, { message: 'x' })
    await assert.rejects(() => mod.apiFetch('/x', { token: 'tok-1' }), { status: 401 })
    assert.deepEqual(unauthorized, ['tok-1'])

    globalThis.fetch = async () => jsonResponse(403, { message: 'x', errorCode: 'PASSWORD_CHANGE_REQUIRED' })
    await assert.rejects(() => mod.apiFetch('/x', { token: 'tok-1' }), { status: 403, code: 'PASSWORD_CHANGE_REQUIRED' })
    assert.equal(required, 1)

    for (const body of [{ errorCode: 'BUSINESS_INACTIVE' }, { errorCode: 'CURRENT_PASSWORD_INCORRECT' }, {}]) {
      globalThis.fetch = async () => jsonResponse(403, body)
      await assert.rejects(() => mod.apiFetch('/x', { token: 'tok-1' }), { status: 403 })
    }
    assert.equal(required, 1, 'no other 403 is a forced change')
    assert.deepEqual(unauthorized, ['tok-1'], 'and a 403 is never a logout')
  } finally {
    mod.setUnauthorizedHandler(null)
    mod.setPasswordChangeRequiredHandler(null)
  }
})

test('AuthProvider.changePassword: sends the CURRENT token, then replaces token and user in ONE storage write; a failure changes nothing', async () => {
  const oldSession = { accessToken: 'old-token', user: { id: 'u1', email: EMAIL, role: 'ADMIN', businessId: 'b1', active: true, mustChangePassword: true } }
  const storage = stubStorage({ [SESSION_KEY]: JSON.stringify(oldSession) })
  globalThis.localStorage = storage
  const requests = []
  const realConsoleError = console.error
  console.error = () => {} // setState outside a mounted tree (static render) only warns
  try {
    mod.mountAuth()
    const auth = mod.auth()
    const newUser = { ...oldSession.user, mustChangePassword: false }

    // failure first: the old session and the restriction stay exactly as they were
    globalThis.fetch = async (url, init) => (requests.push({ url: String(url), init }), jsonResponse(403, { errorCode: 'CURRENT_PASSWORD_INCORRECT' }))
    await assert.rejects(() => auth.changePassword('wrong-current', 'Mi-Nueva-Clave-2026'), { status: 403, code: 'CURRENT_PASSWORD_INCORRECT' })
    assert.deepEqual(storage.writes, [], 'a failed change writes nothing')
    assert.equal(JSON.parse(storage.data[SESSION_KEY]).accessToken, 'old-token')

    // success
    globalThis.fetch = async (url, init) => (requests.push({ url: String(url), init }), jsonResponse(200, { accessToken: 'new-token', user: newUser }))
    const user = await auth.changePassword('Temporal-Passw0rd', 'Mi-Nueva-Clave-2026')
    assert.deepEqual(user, newUser)
    assert.deepEqual(storage.writes, [[SESSION_KEY, JSON.stringify({ accessToken: 'new-token', user: newUser })]], 'one write: new token + new user together')
    assert.equal(JSON.parse(storage.data[SESSION_KEY]).user.mustChangePassword, false)
  } finally {
    console.error = realConsoleError
  }
  assert.equal(requests.length, 2)
  for (const r of requests) {
    assert.match(r.url, /\/auth\/change-password$/)
    assert.equal(r.init.method, 'POST')
    assert.equal(r.init.headers.Authorization, 'Bearer old-token', 'the request is authenticated with the token being replaced')
  }
  assert.deepEqual(JSON.parse(requests[1].init.body), { currentPassword: 'Temporal-Passw0rd', newPassword: 'Mi-Nueva-Clave-2026' }, 'exactly the two fields')
  // the passwords were never persisted anywhere
  for (const [, value] of storage.writes) assert.ok(!String(value).includes('Mi-Nueva-Clave-2026') && !String(value).includes('Temporal-Passw0rd'))
})

test('AuthProvider.changePassword: an answer that is not a complete new session is refused, and nothing is stored', async () => {
  const oldSession = { accessToken: 'old-token', user: { id: 'u1', email: EMAIL, role: 'ADMIN', mustChangePassword: true } }
  const storage = stubStorage({ [SESSION_KEY]: JSON.stringify(oldSession) })
  globalThis.localStorage = storage
  const realConsoleError = console.error
  console.error = () => {}
  try {
    mod.mountAuth()
    for (const body of [{ accessToken: 'only-a-token' }, { user: { id: 'u1', mustChangePassword: false } }, { accessToken: 'x', user: { id: 'u1', mustChangePassword: true } }]) {
      globalThis.fetch = async () => jsonResponse(200, body)
      await assert.rejects(() => mod.auth().changePassword('a', 'b'))
    }
  } finally {
    console.error = realConsoleError
  }
  assert.deepEqual(storage.writes, [])
})

// ======================================================================================================================
// source-level guarantees
// ======================================================================================================================
const accountSources = readdirSync(new URL('.', import.meta.url))
  .filter((f) => /\.(js|jsx)$/.test(f) && !f.endsWith('.test.js'))
  .map((f) => [f, code(read(`./${f}`))])

test('the password code touches no storage, URL, console or cookie, and decides nothing by role', () => {
  for (const [name, source] of accountSources) {
    assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie|console\.|location\.|history\.|URLSearchParams/, name)
    assert.doesNotMatch(source, /user\??\.role|SUPER_ADMIN|'ADMIN'/, `${name}: role decisions live in tenant/tenantCore.js only`)
    assert.doesNotMatch(source, /devtools|useViewAs|viewAs/i, name)
  }
  for (const f of ['../context/passwordChange.js']) assert.doesNotMatch(code(read(f)), /localStorage|console\.|SUPER_ADMIN|'ADMIN'/, f)
})

test('the forced screen replaces the panels: AdminPanel renders it before the tabs, the selector and any request', () => {
  const panel = code(read('../pages/admin/AdminPanel.jsx'))
  assert.match(panel, /const mustChangePassword = needsPasswordChange\(user\)/)
  assert.match(panel, /if \(mustChangePassword\) \{\s*return <ForcedPasswordChange \/>\s*\}/)
  assert.ok(panel.indexOf('return <ForcedPasswordChange />') < panel.indexOf('const panels ='), 'before anything of the panel is built')
  assert.match(panel, /isAuthenticated && !isBusinessSelectable && !mustChangePassword/, 'not even the branding read is sent while the change is required')
  const forced = code(read('./ForcedPasswordChange.jsx'))
  assert.match(forced, /onClick=\{logout\}/, 'the only other way out is closing the session')
  assert.doesNotMatch(forced, /BusinessGate|useActiveBusiness|apiFetch/)
})

test('AuthContext: a password change replaces the session through one path, and stale tokens are recognised', () => {
  const ctx = code(read('../context/AuthContext.jsx'))
  assert.match(ctx, /sessionFromPasswordChange\(result\)/)
  assert.match(ctx, /shouldEndSessionOnUnauthorized\(sessionRef\.current, failedToken\)/)
  assert.match(ctx, /setPasswordChangeRequiredHandler\(handlePasswordChangeRequired\)/)
  assert.doesNotMatch(ctx, /tenant\//, 'AuthContext still imports nothing from tenant/')
  assert.doesNotMatch(ctx, /URLSearchParams|location\.search|mustChangePassword\s*=\s*(false|true)/, 'no client-side bypass or override of the flag')
})
