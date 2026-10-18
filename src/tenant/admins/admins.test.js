import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { loadModule } from '../../theme/testSupport.js'
import { describeAdminError } from './adminErrors.js'
import { createAdminsStore } from './adminsStore.js'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(new URL(`${e.name}/`, dir)) : [new URL(e.name, dir)]))

const BIZ = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const U1 = '11111111-1111-4111-8111-111111111111'
const U2 = '22222222-2222-4222-8222-222222222222'
const TEMP = 'Kd7Qm-Xp3Wz-Ht9Vb-Ns4Rf'
const TEMP2 = 'Zc8Lg-Bn5Yr-Pw2Tk-Dm6Qe'

const restaurant = (id = BIZ, extra = {}) => ({ id, name: 'Brasa 47', slug: 'brasa-47', active: true, ...extra })
const admin = (id, email, extra = {}) => ({ id, businessId: BIZ, email, role: 'ADMIN', active: true, mustChangePassword: false, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...extra })
const apiError = (status, errorCode, extra = {}) => Object.assign(new Error(`HTTP ${status} technical`), { status, code: errorCode, ...extra })
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

// a tiny in-memory "server": the list it returns is what the store must show after every confirmed change
function fakeServer(initial = []) {
  const db = { admins: [...initial], calls: [] }
  const api = {
    db,
    listAdmins: async (id) => (db.calls.push(['list', id]), db.admins.map((a) => ({ ...a }))),
    createAdmin: async (id, email) => {
      db.calls.push(['create', id, email])
      const created = admin(`${db.admins.length + 3}0000000-0000-4000-8000-000000000000`, email, { mustChangePassword: true })
      db.admins.push(created)
      return { user: created, temporaryPassword: TEMP }
    },
    deactivateAdmin: async (id, uid) => {
      db.calls.push(['deactivate', id, uid])
      const a = db.admins.find((x) => x.id === uid)
      a.active = false
      return { ...a }
    },
    activateAdmin: async (id, uid) => {
      db.calls.push(['activate', id, uid])
      const a = db.admins.find((x) => x.id === uid)
      a.active = true
      return { ...a }
    },
    resetAdminPassword: async (id, uid) => {
      db.calls.push(['reset', id, uid])
      const a = db.admins.find((x) => x.id === uid)
      a.mustChangePassword = true
      return { user: { ...a }, temporaryPassword: TEMP2 }
    },
  }
  return api
}
const opened = async (api, business = restaurant()) => {
  const store = createAdminsStore({ api })
  store.open(business)
  await tick()
  return store
}
const collect = (store) => {
  const events = []
  store.onChange((e) => events.push(e))
  return events
}

// ======================================================================================================================
// error messages
// ======================================================================================================================
test('errors: every answer the endpoints can give has its own Spanish sentence, and the raw message never shows', () => {
  const cases = [
    [apiError(409, 'EMAIL_ALREADY_EXISTS'), 'email-exists', /ya existe una cuenta/i],
    [apiError(409, 'LAST_ACTIVE_ADMIN'), 'last-admin', /último administrador activo/],
    [apiError(409, 'BUSINESS_USER_LIMIT_REACHED', { limit: 20 }), 'user-limit', /máximo de 20 usuarios/],
    [apiError(409, 'BUSINESS_USER_LIMIT_REACHED'), 'user-limit', /máximo de usuarios permitidos/],
    [apiError(409, 'CREDENTIALS_CHANGED'), 'conflict', /cambiaron mientras tanto/],
    [apiError(404, 'ADMIN_NOT_FOUND'), 'admin-not-found', /administrador ya no existe/],
    [apiError(404, 'BUSINESS_NOT_FOUND'), 'business-not-found', /restaurante ya no existe/],
    [apiError(404, undefined), 'business-not-found', /restaurante ya no existe/],
    [apiError(401, undefined), 'unauthorized', /sesión expiró/],
    [apiError(403, 'PASSWORD_CHANGE_REQUIRED'), 'password-change-required', /cambiar tu contraseña/],
    [apiError(403, undefined), 'forbidden', /no tiene permiso/],
    [apiError(429, 'RATE_LIMITED'), 'rate-limited', /demasiadas solicitudes/i],
    [apiError(400, undefined), 'invalid', /correo/],
    [apiError(500, undefined), 'server', /No se pudo completar/],
    [new TypeError('Failed to fetch'), 'network', /conectar con el servidor/],
  ]
  for (const [error, kind, message] of cases) {
    const described = describeAdminError(error)
    assert.equal(described.kind, kind, JSON.stringify([error.status, error.code]))
    assert.match(described.message, message)
    assert.doesNotMatch(described.message, /HTTP|technical/)
  }
  assert.equal(describeAdminError(apiError(409, 'EMAIL_ALREADY_EXISTS')).field, 'email', 'a duplicate shows next to the e-mail field')
})

// ======================================================================================================================
// the list and creation
// ======================================================================================================================
test('open: loads the admins of THAT restaurant from the server; closing resets everything', async () => {
  const api = fakeServer([admin(U1, 'a@x.test'), admin(U2, 'b@x.test', { active: false, mustChangePassword: true })])
  const store = await opened(api)
  assert.equal(store.getState().business.id, BIZ)
  assert.equal(store.getState().list.status, 'ready')
  assert.deepEqual(store.getState().list.items.map((a) => a.email), ['a@x.test', 'b@x.test'])
  assert.deepEqual(api.db.calls, [['list', BIZ]])
  store.close()
  assert.equal(store.getState().business, null)
  assert.deepEqual(store.getState().list.items, [])
})

test('open: a suspended restaurant is managed exactly the same (the target is the id it was opened with)', async () => {
  const api = fakeServer([admin(U1, 'a@x.test')])
  const store = await opened(api, restaurant(OTHER, { active: false, name: 'Suspendido' }))
  assert.equal(store.getState().business.active, false)
  await store.createAdmin('nuevo@x.test')
  await store.resetPassword(admin(U1, 'a@x.test'))
  assert.deepEqual(api.db.calls.filter((c) => c[0] !== 'list').map((c) => [c[0], c[1]]), [['create', OTHER], ['reset', OTHER]])
})

test('list failure: an error with a retry; a later retry loads it', async () => {
  let fail = true
  const api = { ...fakeServer([admin(U1, 'a@x.test')]), listAdmins: async () => { if (fail) throw apiError(500); return [admin(U1, 'a@x.test')] } }
  const store = await opened(api)
  assert.equal(store.getState().list.status, 'error')
  assert.equal(store.getState().list.error.kind, 'server')
  fail = false
  store.retry()
  await tick()
  assert.equal(store.getState().list.status, 'ready')
})

test('create: validates the address first (nothing is sent), then shows the temporary password ONCE and re-reads the list from the server', async () => {
  const api = fakeServer([admin(U1, 'a@x.test')])
  const store = await opened(api)
  const events = collect(store)

  for (const bad of ['', '   ', 'no-at-sign', 'a@b', 'a b@c.test']) {
    const result = await store.createAdmin(bad)
    assert.equal(result.ok, false, JSON.stringify(bad))
    assert.equal(store.getState().create.error.field, 'email')
  }
  assert.deepEqual(api.db.calls.filter((c) => c[0] === 'create'), [], 'invalid input never reaches the network')

  const result = await store.createAdmin('  Nuevo@X.test ')
  assert.equal(result.ok, true)
  assert.deepEqual(api.db.calls.filter((c) => c[0] === 'create'), [['create', BIZ, 'nuevo@x.test']], 'the e-mail is trimmed and lowercased like the backend does')
  assert.deepEqual(store.getState().reveal, { kind: 'created', email: 'nuevo@x.test', password: TEMP })
  // NOT optimistic: the list shown is the one re-read after the server confirmed
  assert.equal(api.db.calls.filter((c) => c[0] === 'list').length, 2)
  assert.deepEqual(store.getState().list.items.map((a) => a.email), ['a@x.test', 'nuevo@x.test'])
  assert.equal(store.getState().list.items[1].mustChangePassword, true)
  assert.deepEqual(events, [{ type: 'created', email: 'nuevo@x.test' }], 'the event carries the e-mail, never the password')
  assert.ok(!JSON.stringify(events).includes(TEMP))
})

test('create: a second submit while one is in flight is ignored; the list is not touched before the server answers', async () => {
  const gate = deferred()
  const base = fakeServer([])
  let creates = 0
  const api = { ...base, createAdmin: (id, email) => (creates += 1, gate.promise.then(() => base.createAdmin(id, email))) }
  const store = await opened(api)
  const first = store.createAdmin('a@x.test')
  assert.equal(store.getState().create.phase, 'saving', 'flipped synchronously')
  assert.deepEqual(await store.createAdmin('a@x.test'), { ok: false, ignored: true })
  assert.equal(creates, 1)
  assert.deepEqual(store.getState().list.items, [], 'nothing is added optimistically')
  assert.equal(store.getState().reveal, null)
  gate.resolve()
  await first
  assert.equal(store.getState().list.items.length, 1)
})

test('create failures: 409 duplicate / limit / 429 are reported, nothing is revealed, the form stays usable', async () => {
  for (const [error, kind] of [[apiError(409, 'EMAIL_ALREADY_EXISTS'), 'email-exists'], [apiError(409, 'BUSINESS_USER_LIMIT_REACHED', { limit: 20 }), 'user-limit'], [apiError(429, 'RATE_LIMITED'), 'rate-limited'], [apiError(403, 'PASSWORD_CHANGE_REQUIRED'), 'password-change-required'], [apiError(404, 'BUSINESS_NOT_FOUND'), 'business-not-found']]) {
    const store = await opened({ ...fakeServer([]), createAdmin: async () => { throw error } })
    const result = await store.createAdmin('x@y.test')
    assert.equal(result.ok, false)
    assert.equal(store.getState().create.error.kind, kind)
    assert.equal(store.getState().create.phase, 'idle')
    assert.equal(store.getState().reveal, null)
  }
})

// ======================================================================================================================
// the temporary password: once, in memory, gone when the view goes
// ======================================================================================================================
test('the temporary password lives only in `reveal`: dismissing, closing or opening another restaurant drops it', async () => {
  const api = fakeServer([admin(U1, 'a@x.test')])
  let store = await opened(api)
  await store.createAdmin('n1@x.test')
  assert.equal(store.getState().reveal.password, TEMP)
  store.dismissReveal()
  assert.equal(store.getState().reveal, null)
  assert.ok(!JSON.stringify(store.getState()).includes(TEMP), 'nothing else in the state ever held it')

  store = await opened(api)
  await store.resetPassword(admin(U1, 'a@x.test'))
  assert.equal(store.getState().reveal.password, TEMP2)
  store.close()
  assert.ok(!JSON.stringify(store.getState()).includes(TEMP2))

  store = await opened(api)
  await store.createAdmin('n2@x.test')
  store.open(restaurant(OTHER)) // another restaurant
  assert.equal(store.getState().reveal, null, 'a password never follows the user to another restaurant')
})

test('an answer that arrives after the view was closed or replaced is discarded: its password is never stored or shown', async () => {
  for (const make of [
    (store, base, gate) => {
      const api = { ...base, createAdmin: (id, e) => gate.promise.then(() => base.createAdmin(id, e)) }
      return [api, () => store.createAdmin('late@x.test')]
    },
  ]) {
    const gate = deferred()
    const base = fakeServer([])
    const holder = {}
    const [api, run] = make(holder, base, gate)
    const store = await opened(api)
    holder.createAdmin = store.createAdmin
    const pending = store.createAdmin('late@x.test')
    store.close() // the SUPER_ADMIN left the view while the request was in flight
    gate.resolve()
    const result = await pending
    assert.equal(result.stale, true)
    assert.equal(store.getState().reveal, null)
    assert.ok(!JSON.stringify(store.getState()).includes(TEMP))
    void run
  }
  // same for a reset
  const gate = deferred()
  const base = fakeServer([admin(U1, 'a@x.test')])
  const store = await opened({ ...base, resetAdminPassword: (id, uid) => gate.promise.then(() => base.resetAdminPassword(id, uid)) })
  const pending = store.resetPassword(admin(U1, 'a@x.test'))
  store.open(restaurant(OTHER)) // replaced by another restaurant
  gate.resolve()
  assert.equal((await pending).stale, true)
  assert.equal(store.getState().reveal, null)
  assert.equal(store.getState().business.id, OTHER)
})

// ======================================================================================================================
// sensitive actions: server first, then re-read
// ======================================================================================================================
test('deactivate / activate: wait for the server, re-read the list, report the event; the list is never patched by hand', async () => {
  const api = fakeServer([admin(U1, 'a@x.test'), admin(U2, 'b@x.test')])
  const store = await opened(api)
  const events = collect(store)
  assert.equal((await store.deactivate(admin(U2, 'b@x.test'))).ok, true)
  assert.equal(store.getState().list.items.find((a) => a.id === U2).active, false)
  assert.equal((await store.activate(admin(U2, 'b@x.test'))).ok, true)
  assert.equal(store.getState().list.items.find((a) => a.id === U2).active, true)
  assert.deepEqual(events, [{ type: 'deactivated', email: 'b@x.test' }, { type: 'activated', email: 'b@x.test' }])
  assert.deepEqual(api.db.calls.map((c) => c[0]), ['list', 'deactivate', 'list', 'activate', 'list'])
  assert.equal(store.getState().reveal, null, 'no password is involved')
})

test('deactivate refused by the server (LAST_ACTIVE_ADMIN): the error is returned, the account stays active, the list is re-read', async () => {
  const base = fakeServer([admin(U1, 'only@x.test')])
  const store = await opened({ ...base, deactivateAdmin: async () => { throw apiError(409, 'LAST_ACTIVE_ADMIN') } })
  const result = await store.deactivate(admin(U1, 'only@x.test'))
  assert.equal(result.ok, false)
  assert.equal(result.error.kind, 'last-admin')
  assert.equal(store.getState().list.items[0].active, true)
  assert.equal(base.db.calls.filter((c) => c[0] === 'list').length, 2, 'the list was re-read after the refusal')
  assert.deepEqual(store.getState().busy, [], 'the account is free again')
})

test('reset: shows the new temporary password once; CREDENTIALS_CHANGED / ADMIN_NOT_FOUND report the conflict and re-read the list', async () => {
  const api = fakeServer([admin(U1, 'a@x.test')])
  const store = await opened(api)
  const events = collect(store)
  assert.equal((await store.resetPassword(admin(U1, 'a@x.test'))).ok, true)
  assert.deepEqual(store.getState().reveal, { kind: 'reset', email: 'a@x.test', password: TEMP2 })
  assert.deepEqual(events, [{ type: 'reset', email: 'a@x.test' }])
  assert.ok(!JSON.stringify(events).includes(TEMP2))
  assert.equal(store.getState().list.items[0].mustChangePassword, true, 'the pending-change badge comes from the re-read list')

  for (const [error, kind] of [[apiError(409, 'CREDENTIALS_CHANGED'), 'conflict'], [apiError(404, 'ADMIN_NOT_FOUND'), 'admin-not-found']]) {
    store.dismissReveal()
    const failing = await opened({ ...fakeServer([admin(U1, 'a@x.test')]), resetAdminPassword: async () => { throw error } })
    const before = failing.getState().list.items.length
    const result = await failing.resetPassword(admin(U1, 'a@x.test'))
    assert.equal(result.error.kind, kind)
    assert.equal(failing.getState().reveal, null, 'a failed reset reveals nothing')
    assert.equal(failing.getState().list.items.length, before)
  }
})

test('one request per account at a time: a second action on the same account is ignored; another account is independent', async () => {
  const gate = deferred()
  const base = fakeServer([admin(U1, 'a@x.test'), admin(U2, 'b@x.test')])
  let resets = 0
  const store = await opened({ ...base, resetAdminPassword: (id, uid) => (resets += 1, gate.promise.then(() => base.resetAdminPassword(id, uid))) })
  const first = store.resetPassword(admin(U1, 'a@x.test'))
  assert.deepEqual(store.getState().busy, [U1])
  assert.deepEqual(await store.resetPassword(admin(U1, 'a@x.test')), { ok: false, ignored: true })
  assert.deepEqual(await store.deactivate(admin(U1, 'a@x.test')), { ok: false, ignored: true }, 'not even another action on the same account')
  assert.equal(resets, 1)
  assert.equal((await store.activate(admin(U2, 'b@x.test'))).ok, true, 'a different account is independent')
  gate.resolve()
  await first
  assert.deepEqual(store.getState().busy, [])
})

test('rate limit and network errors on actions are reported without changing anything', async () => {
  for (const [error, kind] of [[apiError(429, 'RATE_LIMITED'), 'rate-limited'], [new TypeError('Failed to fetch'), 'network'], [apiError(403, 'PASSWORD_CHANGE_REQUIRED'), 'password-change-required'], [apiError(401), 'unauthorized']]) {
    const store = await opened({ ...fakeServer([admin(U1, 'a@x.test')]), deactivateAdmin: async () => { throw error } })
    const result = await store.deactivate(admin(U1, 'a@x.test'))
    assert.equal(result.error.kind, kind)
    assert.equal(store.getState().list.items[0].active, true)
    assert.deepEqual(store.getState().busy, [])
  }
})

// ======================================================================================================================
// the real API calls, components and wiring
// ======================================================================================================================
let mod
const saved = { fetch: globalThis.fetch }
before(async () => {
  mod = await loadModule(`
    import { renderToStaticMarkup } from 'react-dom/server'
    export { createAdminsApi } from './tenant/admins/adminsApi.js'
    import { AdminsViewContent } from './tenant/admins/AdminsView.jsx'
    import TemporaryPasswordDialog from './tenant/admins/TemporaryPasswordDialog.jsx'
    import BusinessPickerView from './tenant/selector/BusinessPickerView.jsx'
    const noop = () => {}
    export const renderContent = (state, email = '') =>
      renderToStaticMarkup(<AdminsViewContent state={state} email={email} onEmail={noop} onCreate={noop} onBack={noop} onRetry={noop} onDeactivate={noop} onActivate={noop} onReset={noop} onCloseReveal={noop} />)
    export const renderReveal = (reveal, restaurantName) => renderToStaticMarkup(<TemporaryPasswordDialog reveal={reveal} restaurantName={restaurantName} onClose={noop} />)
    export const renderPicker = (state, management) =>
      renderToStaticMarkup(<BusinessPickerView state={state} searchText="" management={management} onSearchText={noop} onActive={noop} onSelect={noop} onLoadMore={noop} onRetry={noop} />)
  `)
})
after(() => {
  globalThis.fetch = saved.fetch
})

test('API: exactly the five approved endpoints, addressed by UUID, with the real token and never a businessId query', async () => {
  const seen = []
  globalThis.fetch = async (url, init) => (seen.push({ url: String(url), init }), { ok: true, status: 200, json: async () => ({}) })
  const api = mod.createAdminsApi({ getToken: () => 'real-token' })
  await api.listAdmins(BIZ.toUpperCase())
  await api.createAdmin(BIZ, 'x@y.test')
  await api.deactivateAdmin(BIZ, U1)
  await api.activateAdmin(BIZ, U1)
  await api.resetAdminPassword(BIZ, U1)
  await assert.rejects(async () => api.listAdmins('../../etc'), TypeError)
  await assert.rejects(async () => api.deactivateAdmin(BIZ, 'me'), TypeError)
  await assert.rejects(async () => api.resetAdminPassword('x', U1), TypeError)
  const rows = seen.map((s) => [s.init.method ?? 'GET', s.url.replace(/^.*?\/businesses/, '/businesses'), s.init.body])
  assert.deepEqual(rows, [
    ['GET', `/businesses/${BIZ}/admins`, undefined],
    ['POST', `/businesses/${BIZ}/admins`, '{"email":"x@y.test"}'],
    ['POST', `/businesses/${BIZ}/admins/${U1}/deactivate`, '{}'],
    ['POST', `/businesses/${BIZ}/admins/${U1}/activate`, '{}'],
    ['POST', `/businesses/${BIZ}/admins/${U1}/reset-password`, '{}'],
  ])
  for (const s of seen) {
    assert.doesNotMatch(s.url, /businessId|\?/)
    assert.equal(s.init.headers.Authorization, 'Bearer real-token')
  }
})

const ready = (items, extra = {}) => ({
  business: { id: BIZ, name: 'Brasa 47', slug: 'brasa-47', active: true },
  list: { status: 'ready', items, error: null },
  create: { phase: 'idle', error: null },
  busy: [],
  reveal: null,
  ...extra,
})

test('view: lists each admin with its state and a pending-password-change badge, with the actions that fit', () => {
  const html = mod.renderContent(ready([admin(U1, 'activo@x.test'), admin(U2, 'nuevo@x.test', { active: false, mustChangePassword: true })]))
  assert.match(html, /Administradores de Brasa 47/)
  assert.match(html, /activo@x\.test/)
  assert.match(html, /2 administradores/)
  assert.equal((html.match(/business-card__badge--active/g) ?? []).length, 1)
  assert.equal((html.match(/business-card__badge--inactive/g) ?? []).length, 1)
  assert.equal((html.match(/Cambio de contraseña pendiente/g) ?? []).length, 1, 'only the account that has one')
  assert.match(html, /aria-label="Desactivar a activo@x\.test"/)
  assert.match(html, /aria-label="Activar a nuevo@x\.test"/)
  assert.doesNotMatch(html, /aria-label="Activar a activo@x\.test"/)
  assert.equal((html.match(/Restablecer la contraseña de /g) ?? []).length, 2, 'a reset is offered for every account')
  assert.doesNotMatch(html, /\$2[aby]\$|passwordHash|credentialsVersion/)
})

test('view: loading, error (with retry), empty and suspended-restaurant states', () => {
  assert.match(mod.renderContent(ready([], { list: { status: 'loading', items: [], error: null } })), /Cargando administradores/)
  const error = mod.renderContent(ready([], { list: { status: 'error', items: [], error: { kind: 'server', message: 'No se pudo completar la acción. Intenta nuevamente.' } } }))
  assert.match(error, /role="alert"/)
  assert.match(error, /Reintentar/)
  const forbidden = mod.renderContent(ready([], { list: { status: 'error', items: [], error: { kind: 'forbidden', message: 'Tu cuenta no tiene permiso para gestionar administradores.' } } }))
  assert.doesNotMatch(forbidden, /Reintentar/, 'a permission error cannot be retried')
  assert.match(mod.renderContent(ready([])), /todavía no tiene administradores/)
  const suspended = mod.renderContent(ready([admin(U1, 'a@x.test')], { business: { id: BIZ, name: 'Cerrado', slug: 'cerrado', active: false } }))
  assert.match(suspended, /Este restaurante está suspendido/)
  assert.match(suspended, /Desactivar a a@x\.test/, 'its accounts can still be managed')
})

test('view: the create form shows the field error next to the e-mail and the general error below; saving disables it', () => {
  const dup = mod.renderContent(ready([], { create: { phase: 'idle', error: { kind: 'email-exists', field: 'email', message: 'Ya existe una cuenta con ese correo electrónico.' } } }), 'a@x.test')
  assert.match(dup, /Ya existe una cuenta con ese correo electrónico\./)
  assert.match(dup, /aria-invalid="true"/)
  const limit = mod.renderContent(ready([], { create: { phase: 'idle', error: { kind: 'user-limit', message: 'Este restaurante alcanzó el máximo de 20 usuarios. No se pueden crear más cuentas.' } } }))
  assert.match(limit, /máximo de 20 usuarios/)
  const saving = mod.renderContent(ready([], { create: { phase: 'saving', error: null } }), 'a@x.test')
  assert.match(saving, /Creando…/)
  assert.match(saving, /disabled=""/)
})

test('temporary-password dialog: shows the password once with a warning and an EXPLICIT copy button; says the clipboard may keep it', () => {
  const html = mod.renderReveal({ kind: 'created', email: 'nuevo@x.test', password: TEMP }, 'Brasa 47')
  assert.equal((html.match(new RegExp(TEMP, 'g')) ?? []).length, 1, 'the password appears exactly once in the markup')
  assert.match(html, /role="dialog"/)
  assert.match(html, /aria-modal="true"/)
  assert.match(html, /Administrador creado/)
  assert.match(html, /nuevo@x\.test/)
  assert.match(html, /Brasa 47/)
  assert.match(html, /una sola vez/)
  assert.match(html, /no podrás consultarla de nuevo/)
  assert.match(html, /Copiar contraseña/)
  assert.match(html, /portapapeles de tu dispositivo puede conservarla/)
  assert.match(html, /Ya la guardé, cerrar/)
  assert.match(mod.renderReveal({ kind: 'reset', email: 'a@x.test', password: TEMP2 }, ''), /Contraseña restablecida/)
  assert.doesNotMatch(html, /value="/, 'not an input: nothing for a browser to autofill or save')
})

test('without a reveal the view contains no password at all, and the dialog is not rendered', () => {
  const html = mod.renderContent(ready([admin(U1, 'a@x.test')]))
  assert.doesNotMatch(html, /role="dialog"|temp-password|Copiar contraseña/)
  const withReveal = mod.renderContent(ready([admin(U1, 'a@x.test')], { reveal: { kind: 'created', email: 'a@x.test', password: TEMP } }))
  assert.match(withReveal, /Copiar contraseña/)
})

test('the picker menu offers "Administradores" for active AND suspended restaurants, only when the gate passes the callback', async () => {
  const { businessMenuItems } = await import('../selector/cardActions.js')
  const active = { id: BIZ, name: 'Activo', slug: 'activo', active: true, logoUrl: null }
  const suspended = { id: OTHER, name: 'Cerrado', slug: 'cerrado', active: false, logoUrl: null }
  const seen = []
  const noop = () => {}
  const withAdmins = { onEdit: noop, onSuspend: noop, onActivate: noop, onAdmins: (b) => seen.push(b.id) }
  const keys = (business, management) => businessMenuItems(business, management).map((i) => i.key)
  assert.ok(keys(active, withAdmins).includes('admins'))
  assert.ok(keys(suspended, withAdmins).includes('admins'), 'a suspended restaurant can still be managed')
  businessMenuItems(suspended, withAdmins).find((i) => i.key === 'admins').onSelect()
  assert.deepEqual(seen, [OTHER], 'it opens the view of THAT restaurant')
  assert.ok(!keys(active, { onEdit: noop, onSuspend: noop, onActivate: noop, onAdmins: null }).includes('admins'))
  assert.deepEqual(keys(active, null), [])
})

// ======================================================================================================================
// SUPER_ADMIN only, by construction; no persistence of any secret
// ======================================================================================================================
test('the admin-management code is reachable only through the SUPER_ADMIN selector gate (an ADMIN never mounts it)', () => {
  const importers = walk(new URL('../../', import.meta.url))
    .filter((u) => /\.(js|jsx)$/.test(u.pathname) && !u.pathname.endsWith('.test.js') && !u.pathname.includes('/tenant/admins/'))
    .filter((u) => /admins\/(AdminsView|adminsApi|adminsStore|TemporaryPasswordDialog)/.test(code(readFileSync(u, 'utf8'))))
    .map((u) => u.pathname.split('/src/')[1])
  assert.deepEqual(importers, ['tenant/selector/BusinessGate.jsx'])
  const panel = code(read('../../pages/admin/AdminPanel.jsx'))
  assert.match(panel, /isBusinessSelectable \? <BusinessGate onBusiness=\{setBusiness\}>\{panels\}<\/BusinessGate> : panels/, 'an ADMIN renders the panels directly, never the gate')
  const gate = code(read('../selector/BusinessGate.jsx'))
  assert.match(gate, /adminsState\.business !== null\) return <AdminsView store=\{admins\} onBack=\{admins\.close\} \/>/)
  assert.match(gate, /onAdmins=\{admins\.open\}/)
})

test('the admin-management code reads no role or token, and never persists, logs or puts a password in a URL', () => {
  const sources = readdirSync(new URL('.', import.meta.url))
    .filter((f) => /\.(js|jsx)$/.test(f) && !f.endsWith('.test.js'))
    .map((f) => [f, code(read(`./${f}`))])
  assert.ok(sources.length >= 5, 'the scan really covers the folder')
  for (const [name, source] of sources) {
    assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie|console\.|location\.|history\.|URLSearchParams|indexedDB|analytics|gtag|dataLayer/i, name)
    assert.doesNotMatch(source, /user\??\.role|SUPER_ADMIN|'ADMIN'|Authorization|accessToken|jwt|setSession|logout|login\(/i, `${name}: no role decision, no JWT handling`)
    assert.doesNotMatch(source, /devtools|useViewAs|viewAs/i, name)
  }
  // the clipboard is touched only by the explicit button of the dialog
  const clipboardUsers = sources.filter(([, s]) => /clipboard/.test(s)).map(([n]) => n)
  assert.deepEqual(clipboardUsers, ['TemporaryPasswordDialog.jsx'])
  const dialog = code(read('./TemporaryPasswordDialog.jsx'))
  assert.match(dialog, /async function handleCopy\(\) \{\s*try \{\s*await navigator\.clipboard\.writeText\(reveal\.password\)/)
  assert.equal((dialog.match(/clipboard/g) ?? []).length, 1, 'one call, inside the click handler: nothing is copied automatically')
  assert.doesNotMatch(dialog, /useEffect/, 'no effect can copy or keep the password')
})

test('the toasts of the view never carry a password', () => {
  const view = code(read('./AdminsView.jsx'))
  for (const m of view.matchAll(/toast\.(success|error)\(([^\n]*)\)/g)) assert.doesNotMatch(m[2], /password|temporaryPassword|reveal/i, m[0])
  assert.match(view, /useEffect\(\(\) => \(\) => store\.dismissReveal\(\), \[store\]\)/, 'unmounting the view drops a password still on screen')
})

test('only the five approved paths are ever built, and no other backend route is used', () => {
  const api = code(read('./adminsApi.js'))
  // the helper's own definition aside (it has default values), each call builds one of the five approved paths
  const calls = [...api.matchAll(/adminsPath\(([^)]*)\)/g)].map((m) => m[1].replace(/\s+/g, ' ').trim()).filter((args) => !args.includes('='))
  assert.deepEqual([...new Set(calls)].sort(), ['businessId', "businessId, userId, '/activate'", "businessId, userId, '/deactivate'", "businessId, userId, '/reset-password'"])
  assert.equal((api.match(/method: 'POST'/g) ?? []).length, 4)
  assert.doesNotMatch(api, /PATCH|PUT|DELETE|\/users|\/auth\//)
})

test('styles use only theme tokens (light and dark) and are hidden in print', () => {
  const css = code(read('../../styles/index.css'))
  const start = css.indexOf('.password-form {')
  const end = css.indexOf('@media print', start)
  assert.ok(start > 0 && end > start)
  const block = css.slice(start, end)
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|:\s*(white|black)\b/, 'no literal colour')
  assert.match(block, /\.temp-password__warning \{[^}]*var\(--warning-tint\)/)
  assert.match(block, /\.temp-password__value \{[^}]*background:\s*var\(--input-bg\)/)
  assert.match(block, /\.admin-row--inactive \{[^}]*var\(--dimmed-surface\)/)
  assert.match(css, /@media print \{[^}]*\.admins,\s*\.temp-password/)
})
