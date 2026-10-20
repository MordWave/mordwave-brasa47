import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { loadModule } from '../../theme/testSupport.js'
import { describeRemovalError } from './adminErrors.js'
import { confirmationMatches, createAdminsStore } from './adminsStore.js'
import { removalDialogModel } from './removalDialogModel.js'
import { knownRemovalBlock } from './removalEligibility.js'

// 9D.5 — "Eliminar administrador": the store state machine, the Spanish error mapping, the API call, the dialog markup, and the
// source-level guarantees (SUPER_ADMIN-only reachability, no retries, tokens-only styles in light and dark).

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const BIZ = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const U1 = '11111111-1111-4111-8111-111111111111'
const U2 = '22222222-2222-4222-8222-222222222222'
const restaurant = (id = BIZ, extra = {}) => ({ id, name: 'Brasa 47', slug: 'brasa-47', active: true, ...extra })
const admin = (id, email, extra = {}) => ({ id, businessId: BIZ, email, role: 'ADMIN', active: false, mustChangePassword: true, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...extra })
const apiError = (status, errorCode, extra = {}) => Object.assign(new Error(`HTTP ${status} technical SQL detail`), { status, code: errorCode, ...extra })
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

// an in-memory "server" whose deletion can be scripted
function fakeServer(initial, { remove } = {}) {
  const db = { admins: [...initial], calls: [] }
  return {
    db,
    listAdmins: async (id) => (db.calls.push(['list', id]), db.admins.map((a) => ({ ...a }))),
    deleteAdmin: async (id, uid, confirmEmail) => {
      db.calls.push(['delete', id, uid, confirmEmail])
      if (remove) return remove({ db, id, uid, confirmEmail })
      db.admins = db.admins.filter((a) => a.id !== uid)
      return { deleted: true, alreadyDeleted: false, id: uid, email: confirmEmail, businessId: id }
    },
  }
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
const kinds = (api) => api.db.calls.map((c) => c[0])
const A1 = admin(U1, 'error@brasa47.cl')
const A2 = admin(U2, 'otro@brasa47.cl')

// ======================================================================================================================
// the typed confirmation
// ======================================================================================================================
test('confirmation: the exact e-mail, ignoring case and surrounding spaces; never an empty or different text', () => {
  assert.equal(confirmationMatches('error@brasa47.cl', 'error@brasa47.cl'), true)
  assert.equal(confirmationMatches('  ERROR@Brasa47.CL ', 'error@brasa47.cl'), true)
  for (const typed of ['', '   ', 'error@brasa47', 'error@brasa47.cl.', 'otro@brasa47.cl', 'error@brasa47.cl otro', null, undefined, 42]) assert.equal(confirmationMatches(typed, 'error@brasa47.cl'), false, String(typed))
  assert.equal(confirmationMatches('x', undefined), false)
})

test('dialog model: the red button is enabled ONLY when the e-mail matches and nothing is in flight', () => {
  const removal = (phase, extra = {}) => ({ admin: { id: U1, email: 'error@brasa47.cl' }, phase, error: null, id: 1, ...extra })
  assert.equal(removalDialogModel(removal('idle'), '').canConfirm, false)
  assert.equal(removalDialogModel(removal('idle'), 'otro@brasa47.cl').canConfirm, false)
  assert.equal(removalDialogModel(removal('idle'), 'error@brasa47.cl').canConfirm, true)
  for (const phase of ['deleting', 'refused', 'ambiguous', 'checking']) assert.equal(removalDialogModel(removal(phase), 'error@brasa47.cl').canConfirm, false, phase)
  // closing is blocked while a request or a check is pending, and an editable field only exists before the request
  assert.equal(removalDialogModel(removal('deleting'), '').closeDisabled, true)
  assert.equal(removalDialogModel(removal('checking'), '').closeDisabled, true)
  assert.equal(removalDialogModel(removal('idle'), '').closeDisabled, false)
  assert.equal(removalDialogModel(removal('idle'), '').inputReadOnly, false)
  assert.equal(removalDialogModel(removal('deleting'), '').inputReadOnly, true)
  // after a refusal or an unknown outcome the final button is gone; the unknown outcome offers a re-read of the list
  assert.equal(removalDialogModel(removal('refused'), '').showFinal, false)
  assert.equal(removalDialogModel(removal('ambiguous'), '').showFinal, false)
  assert.equal(removalDialogModel(removal('ambiguous'), '').showRefresh, true)
  assert.equal(removalDialogModel(removal('refused'), '').showRefresh, false)
  // a quiet hint while typing, only before the request
  assert.match(removalDialogModel(removal('idle'), 'err').typedHint, /Todavía no coincide/)
  assert.equal(removalDialogModel(removal('idle'), '').typedHint, '')
  assert.equal(removalDialogModel(removal('idle'), 'error@brasa47.cl').typedHint, '')
  assert.equal(removalDialogModel(removal('deleting'), 'err').typedHint, '')
})

// ======================================================================================================================
// opening and cancelling
// ======================================================================================================================
test('opening the dialog sends nothing; cancelling closes it; only one dialog and never for an account with a request in flight', async () => {
  const api = fakeServer([A1, A2])
  const store = await opened(api)
  assert.deepEqual(await store.requestRemoval(A1), { ok: true })
  assert.deepEqual(store.getState().removal, { admin: { id: U1, email: 'error@brasa47.cl' }, phase: 'idle', error: null, id: null })
  assert.deepEqual(kinds(api), ['list'], 'nothing was sent')
  assert.deepEqual(await store.requestRemoval(A2), { ok: false, ignored: true }, 'one dialog at a time')
  store.cancelRemoval()
  assert.equal(store.getState().removal, null)
  assert.deepEqual(kinds(api), ['list'])
  assert.deepEqual(await store.requestRemoval({ id: U1 }), { ok: false }, 'an account without an e-mail cannot open it')
  assert.deepEqual(store.requestRemoval(null), { ok: false })
})

// ======================================================================================================================
// success
// ======================================================================================================================
test('a wrong or empty confirmation sends NOTHING; the right one (any case, spaces) sends exactly one request with the typed e-mail', async () => {
  const api = fakeServer([A1, A2])
  const store = await opened(api)
  store.requestRemoval(A1)
  for (const typed of ['', 'otro@brasa47.cl', 'error@brasa47']) {
    const result = await store.confirmRemoval(typed)
    assert.equal(result.ok, false)
    assert.equal(result.error.kind, 'confirmation-mismatch')
  }
  assert.deepEqual(kinds(api), ['list'], 'no request for a text that does not match')
  assert.equal(store.getState().removal.phase, 'idle')
  const done = await store.confirmRemoval('  ERROR@brasa47.CL ')
  assert.deepEqual(done, { ok: true, alreadyDeleted: false })
  assert.deepEqual(api.db.calls.filter((c) => c[0] === 'delete'), [['delete', BIZ, U1, '  ERROR@brasa47.CL ']])
})

test('successful deletion: waits for the server, closes the dialog, RE-READS the list (never patches it), reports it once, frees the account', async () => {
  const gate = deferred()
  const api = fakeServer([A1, A2])
  const store = await opened({ ...api, deleteAdmin: (...args) => gate.promise.then(() => api.deleteAdmin(...args)) })
  const events = collect(store)
  store.requestRemoval(A1)
  const pending = store.confirmRemoval('error@brasa47.cl')
  assert.equal(store.getState().removal.phase, 'deleting')
  assert.deepEqual(store.getState().busy, [U1])
  assert.deepEqual(store.getState().list.items.map((a) => a.id), [U1, U2], 'the list is not touched before the server answers')
  gate.resolve()
  assert.deepEqual(await pending, { ok: true, alreadyDeleted: false })
  assert.equal(store.getState().removal, null)
  assert.deepEqual(store.getState().busy, [])
  assert.deepEqual(store.getState().list.items.map((a) => a.id), [U2], 'what is shown is what the server says')
  assert.deepEqual(events, [{ type: 'removed', email: 'error@brasa47.cl' }])
  assert.deepEqual(kinds(api), ['list', 'delete', 'list'])
})

test('alreadyDeleted: a retry that finds the account already gone is reported as such; nothing else is attempted', async () => {
  const api = fakeServer([A1, A2], { remove: ({ uid, confirmEmail, id }) => ({ deleted: true, alreadyDeleted: true, id: uid, email: confirmEmail, businessId: id }) })
  const store = await opened(api)
  const events = collect(store)
  store.requestRemoval(A1)
  assert.deepEqual(await store.confirmRemoval('error@brasa47.cl'), { ok: true, alreadyDeleted: true })
  assert.equal(store.getState().removal, null)
  assert.deepEqual(events, [{ type: 'already-removed', email: 'error@brasa47.cl' }])
  assert.equal(api.db.calls.filter((c) => c[0] === 'delete').length, 1, 'no second request')
  assert.deepEqual(kinds(api).slice(-1), ['list'], 'the list is re-read')
})

// ======================================================================================================================
// every refusal
// ======================================================================================================================
test('error messages: every answer of the endpoint has its own Spanish sentence, says nothing was deleted, and never shows the raw message', () => {
  const cases = [
    [apiError(400, 'CONFIRMATION_MISMATCH'), 'confirmation-mismatch', 'retry', /no coincide/i],
    [apiError(400, undefined), 'invalid', 'retry', /Revisa el correo/],
    [apiError(401), 'unauthorized', 'refused', /sesión expiró/],
    [apiError(403, 'PASSWORD_CHANGE_REQUIRED'), 'password-change-required', 'refused', /cambiar tu contraseña/],
    [apiError(403, 'ROLE_NOT_ALLOWED'), 'role-not-allowed', 'refused', /no es un administrador de restaurante/],
    [apiError(403, undefined), 'forbidden', 'refused', /no tiene permiso/],
    [apiError(404, 'ADMIN_NOT_FOUND'), 'admin-not-found', 'refused', /ya no existe/],
    [apiError(404, 'BUSINESS_NOT_FOUND'), 'business-not-found', 'refused', /restaurante ya no existe/],
    [apiError(409, 'ADMIN_STILL_ACTIVE'), 'still-active', 'refused', /primero desactívala/],
    [apiError(409, 'LAST_ACTIVE_ADMIN'), 'last-admin', 'refused', /último administrador activo/],
    [apiError(409, 'ADMIN_PASSWORD_ALREADY_CHANGED'), 'password-changed', 'refused', /ya cambió su contraseña inicial/],
    [apiError(409, 'ADMIN_HAS_ACTIVITY'), 'has-activity', 'refused', /actividad registrada/],
    [apiError(409, 'ADMIN_HISTORY_INCOMPATIBLE'), 'history-incompatible', 'refused', /historial de esta cuenta/],
    [apiError(409, 'ADMIN_CONCURRENT_MODIFICATION'), 'concurrent', 'retry', /al mismo tiempo/],
    [apiError(429, 'RATE_LIMITED'), 'rate-limited', 'retry', /Demasiadas solicitudes/],
    [apiError(500), 'server', 'ambiguous', /no podemos confirmar/],
    [apiError(502), 'server', 'ambiguous', /no podemos confirmar/],
    [apiError(503, 'X'), 'server', 'ambiguous', /no podemos confirmar/],
    [new TypeError('Failed to fetch'), 'network', 'ambiguous', /No pudimos confirmar/],
    [apiError(418, 'TEAPOT'), 'unknown', 'refused', /No se eliminó nada que el servidor haya confirmado/],
  ]
  for (const [error, kind, outcome, pattern] of cases) {
    const described = describeRemovalError(error)
    assert.equal(described.kind, kind, `${error.status} ${error.code}`)
    assert.equal(described.outcome, outcome, `${kind}`)
    assert.match(described.message, pattern, kind)
    assert.doesNotMatch(described.message, /HTTP|technical|SQL|Error \d|undefined|null/, `${kind}: the raw message never shows`)
    if (outcome !== 'ambiguous') assert.match(described.message, /No se eliminó nada|Se actualizó la lista|no se puede eliminar|no permite eliminarla|ya no existe|sigue activa/i, `${kind}: states the account is intact`)
    if (outcome === 'ambiguous') assert.match(described.message, /No la damos por eliminada/, `${kind}: never claims it was deleted`)
  }
})

test('refusals (409 specific reasons): nothing is deleted, the dialog stays open with the reason, offers only "Cerrar", and the list is re-read', async () => {
  for (const code of ['ADMIN_STILL_ACTIVE', 'LAST_ACTIVE_ADMIN', 'ADMIN_PASSWORD_ALREADY_CHANGED', 'ADMIN_HAS_ACTIVITY', 'ADMIN_HISTORY_INCOMPATIBLE']) {
    const api = fakeServer([A1, A2], { remove: () => { throw apiError(409, code) } })
    const store = await opened(api)
    const events = collect(store)
    store.requestRemoval(A1)
    const result = await store.confirmRemoval('error@brasa47.cl')
    assert.equal(result.ok, false, code)
    const { removal, busy, list } = store.getState()
    assert.equal(removal.phase, 'refused', code)
    assert.match(removal.error.message, /\S/)
    assert.deepEqual(busy, [], code)
    assert.deepEqual(list.items.map((a) => a.id), [U1, U2], `${code}: still there`)
    assert.deepEqual(events, [], `${code}: no success is announced`)
    assert.deepEqual(kinds(api), ['list', 'delete', 'list'], `${code}: one attempt, then a re-read`)
    const model = removalDialogModel(removal, 'error@brasa47.cl')
    assert.equal(model.showFinal, false, `${code}: the red button is gone`)
    assert.equal(model.closeLabel, 'Cerrar')
    store.cancelRemoval()
    assert.equal(store.getState().removal, null, `${code}: it can be closed`)
  }
})

test('retryable failures (concurrent change, 429, server-side CONFIRMATION_MISMATCH): back to "idle" with the message; the person decides to try again', async () => {
  let attempts = 0
  const api = fakeServer([A1], {
    remove: ({ db, uid, confirmEmail, id }) => {
      attempts += 1
      if (attempts === 1) throw apiError(409, 'ADMIN_CONCURRENT_MODIFICATION')
      if (attempts === 2) throw apiError(429, 'RATE_LIMITED')
      if (attempts === 3) throw apiError(400, 'CONFIRMATION_MISMATCH')
      db.admins = []
      return { deleted: true, alreadyDeleted: false, id: uid, email: confirmEmail, businessId: id }
    },
  })
  const store = await opened(api)
  store.requestRemoval(A1)
  const expectations = [['concurrent', true], ['rate-limited', false], ['confirmation-mismatch', false]]
  for (const [kind, rereads] of expectations) {
    const before = kinds(api).length
    const result = await store.confirmRemoval('error@brasa47.cl')
    assert.equal(result.error.kind, kind)
    assert.equal(store.getState().removal.phase, 'idle', kind)
    assert.equal(store.getState().removal.error.kind, kind)
    assert.equal(removalDialogModel(store.getState().removal, 'error@brasa47.cl').canConfirm, true, `${kind}: the person may try again`)
    assert.equal(kinds(api).length - before, rereads ? 2 : 1, `${kind}: ${rereads ? 'delete + re-read' : 'only the delete'}`)
  }
  assert.equal(attempts, 3, 'the store never retried by itself')
  assert.deepEqual(await store.confirmRemoval('error@brasa47.cl'), { ok: true, alreadyDeleted: false })
  assert.equal(attempts, 4)
})

test('404 ADMIN_NOT_FOUND: the account is already gone for the server; the list is re-read and the dialog offers only "Cerrar"', async () => {
  const api = fakeServer([A1, A2], { remove: ({ db, uid }) => { db.admins = db.admins.filter((a) => a.id !== uid); throw apiError(404, 'ADMIN_NOT_FOUND') } })
  const store = await opened(api)
  store.requestRemoval(A1)
  const result = await store.confirmRemoval('error@brasa47.cl')
  assert.equal(result.error.kind, 'admin-not-found')
  assert.equal(store.getState().removal.phase, 'refused')
  assert.deepEqual(store.getState().list.items.map((a) => a.id), [U2])
})

test('401 / 403 / business 404: reported without re-reading the list or claiming anything', async () => {
  for (const [status, code, kind] of [[401, undefined, 'unauthorized'], [403, 'PASSWORD_CHANGE_REQUIRED', 'password-change-required'], [403, undefined, 'forbidden'], [404, 'BUSINESS_NOT_FOUND', 'business-not-found']]) {
    const api = fakeServer([A1], { remove: () => { throw apiError(status, code) } })
    const store = await opened(api)
    store.requestRemoval(A1)
    const result = await store.confirmRemoval('error@brasa47.cl')
    assert.equal(result.error.kind, kind)
    assert.equal(store.getState().removal.phase, 'refused')
    assert.deepEqual(kinds(api), ['list', 'delete'], `${kind}: no extra reads`)
  }
})

// ======================================================================================================================
// double submit, pending requests, network errors, ambiguous answers
// ======================================================================================================================
test('double click / repeated Enter / simultaneous submits: ONE request; cancel and close are refused while it is in flight', async () => {
  const gate = deferred()
  const api = fakeServer([A1, A2])
  const store = await opened({ ...api, deleteAdmin: (...args) => gate.promise.then(() => api.deleteAdmin(...args)) })
  store.requestRemoval(A1)
  const first = store.confirmRemoval('error@brasa47.cl')
  const second = store.confirmRemoval('error@brasa47.cl')
  const third = store.confirmRemoval('error@brasa47.cl')
  assert.deepEqual(await second, { ok: false, ignored: true })
  assert.deepEqual(await third, { ok: false, ignored: true })
  store.cancelRemoval() // accidental Escape / Cancel while pending
  assert.equal(store.getState().removal.phase, 'deleting', 'the dialog stays: a pending deletion cannot be abandoned')
  assert.deepEqual(await store.requestRemoval(A2), { ok: false, ignored: true })
  assert.deepEqual(await store.deactivate(A1), { ok: false, ignored: true }, 'no other action on the same account meanwhile')
  gate.resolve()
  assert.equal((await first).ok, true)
  assert.equal(api.db.calls.filter((c) => c[0] === 'delete').length, 1)
})

test('network failure: the outcome is UNKNOWN — never shown as deleted, never retried by itself, the list is not touched', async () => {
  const api = fakeServer([A1, A2], { remove: () => { throw new TypeError('Failed to fetch') } })
  const store = await opened(api)
  const events = collect(store)
  store.requestRemoval(A1)
  const result = await store.confirmRemoval('error@brasa47.cl')
  assert.equal(result.error.kind, 'network')
  const { removal, busy, list } = store.getState()
  assert.equal(removal.phase, 'ambiguous')
  assert.match(removal.error.message, /No la damos por eliminada/)
  assert.doesNotMatch(removal.error.message, /se eliminó correctamente|fue eliminada\./i)
  assert.deepEqual(busy, [])
  assert.deepEqual(list.items.map((a) => a.id), [U1, U2])
  assert.deepEqual(events, [])
  await tick()
  await tick()
  assert.deepEqual(kinds(api), ['list', 'delete'], 'exactly one attempt and no automatic re-read or retry')
  assert.equal(removalDialogModel(removal, 'error@brasa47.cl').showRefresh, true)
})

test('5xx and a 200 that does not confirm THIS account are ambiguous too (no success is announced)', async () => {
  const bodies = [() => { throw apiError(500) }, () => { throw apiError(503) }, () => null, () => ({}), () => ({ deleted: false }), () => ({ deleted: true, id: U2 }), () => ({ id: U1 })]
  for (const remove of bodies) {
    const api = fakeServer([A1, A2], { remove })
    const store = await opened(api)
    const events = collect(store)
    store.requestRemoval(A1)
    const result = await store.confirmRemoval('error@brasa47.cl')
    assert.equal(result.ok, false)
    assert.equal(store.getState().removal.phase, 'ambiguous')
    assert.deepEqual(events, [])
    assert.deepEqual(kinds(api), ['list', 'delete'])
  }
})

test('after an unknown outcome the person re-reads the list: account gone -> closes with a neutral notice; still there -> back to idle; read fails -> still unknown', async () => {
  // gone (the request had in fact been applied)
  let api = fakeServer([A1, A2], { remove: ({ db, uid }) => { db.admins = db.admins.filter((a) => a.id !== uid); throw new TypeError('Failed to fetch') } })
  let store = await opened(api)
  let events = collect(store)
  store.requestRemoval(A1)
  await store.confirmRemoval('error@brasa47.cl')
  const pending = store.refreshRemoval()
  assert.equal(store.getState().removal.phase, 'checking')
  assert.deepEqual(await store.cancelRemoval(), undefined)
  assert.equal(store.getState().removal.phase, 'checking', 'cannot be closed while checking')
  assert.deepEqual(await pending, { ok: true, listed: false })
  assert.equal(store.getState().removal, null)
  assert.deepEqual(events, [{ type: 'gone', email: 'error@brasa47.cl' }], 'a neutral notice, not "eliminated"')
  assert.equal(api.db.calls.filter((c) => c[0] === 'delete').length, 1, 'the check never sends the deletion again')

  // still there (the request never reached the server)
  api = fakeServer([A1, A2], { remove: () => { throw apiError(503) } })
  store = await opened(api)
  events = collect(store)
  store.requestRemoval(A1)
  await store.confirmRemoval('error@brasa47.cl')
  assert.deepEqual(await store.refreshRemoval(), { ok: true, listed: true })
  assert.equal(store.getState().removal.phase, 'idle')
  assert.match(store.getState().removal.error.message, /sigue existiendo: no se eliminó/)
  assert.deepEqual(events, [])
  assert.equal(api.db.calls.filter((c) => c[0] === 'delete').length, 1)

  // the read itself fails: still unknown, and said so
  let failReads = false
  const base = fakeServer([A1, A2], { remove: () => { throw new TypeError('Failed to fetch') } })
  store = await opened({ ...base, listAdmins: async (id) => { if (failReads) throw new TypeError('Failed to fetch'); return base.listAdmins(id) } })
  store.requestRemoval(A1)
  await store.confirmRemoval('error@brasa47.cl')
  failReads = true
  assert.deepEqual(await store.refreshRemoval(), { ok: false })
  assert.equal(store.getState().removal.phase, 'ambiguous')
  assert.match(store.getState().removal.error.message, /Seguimos sin saber/)
  assert.deepEqual(await store.refreshRemoval(), { ok: false }, 'it can be tried again, and says the same')
})

test('refreshRemoval is only for an unknown outcome', async () => {
  const store = await opened(fakeServer([A1]))
  assert.deepEqual(await store.refreshRemoval(), { ok: false, ignored: true }, 'no dialog')
  store.requestRemoval(A1)
  assert.deepEqual(await store.refreshRemoval(), { ok: false, ignored: true }, 'idle dialog')
})

// ======================================================================================================================
// the restaurant changes while a deletion is pending
// ======================================================================================================================
test('switching restaurant (or closing the view) while a deletion is pending: the late answer is discarded and touches nothing', async () => {
  for (const mode of ['switch', 'close']) {
    for (const outcome of ['success', 'failure']) {
      const gate = deferred()
      const api = fakeServer([A1, A2])
      const other = [{ ...admin('33333333-3333-4333-8333-333333333333', 'otro-negocio@x.test', { businessId: OTHER }) }]
      const store = createAdminsStore({
        api: {
          ...api,
          listAdmins: async (id) => (id === BIZ ? api.listAdmins(id) : other),
          deleteAdmin: (...args) => gate.promise.then(() => (outcome === 'success' ? api.deleteAdmin(...args) : Promise.reject(apiError(409, 'ADMIN_HAS_ACTIVITY')))),
        },
      })
      store.open(restaurant())
      await tick()
      const events = collect(store)
      store.requestRemoval(A1)
      const pending = store.confirmRemoval('error@brasa47.cl')
      if (mode === 'switch') {
        store.open(restaurant(OTHER, { name: 'Casa Olivo', slug: 'casa-olivo' }))
        await tick()
      } else {
        store.close()
      }
      const snapshot = JSON.stringify(store.getState())
      gate.resolve()
      const result = await pending
      assert.equal(result.stale, true, `${mode}/${outcome}`)
      await tick()
      assert.equal(JSON.stringify(store.getState()), snapshot, `${mode}/${outcome}: the new view is untouched`)
      assert.deepEqual(events, [], `${mode}/${outcome}: no notice, no success, no error`)
      assert.equal(store.getState().removal, null)
    }
  }
})

test('a late answer for an account never affects the dialog of ANOTHER account in the same restaurant', async () => {
  const gate = deferred()
  const api = fakeServer([A1, A2])
  const store = await opened({ ...api, deleteAdmin: (...args) => gate.promise.then(() => api.deleteAdmin(...args)) })
  store.requestRemoval(A1)
  const pending = store.confirmRemoval('error@brasa47.cl')
  store.close()
  store.open(restaurant()) // the same restaurant, a NEW view
  await tick()
  store.requestRemoval(A2)
  const snapshot = JSON.stringify(store.getState().removal)
  gate.resolve()
  assert.equal((await pending).stale, true)
  await tick()
  assert.equal(JSON.stringify(store.getState().removal), snapshot, 'the dialog of the other account is exactly as it was')
})

// ======================================================================================================================
// the API call
// ======================================================================================================================
let mod
const saved = { fetch: globalThis.fetch }
before(async () => {
  mod = await loadModule(`
    import { renderToStaticMarkup } from 'react-dom/server'
    export { createAdminsApi } from './tenant/admins/adminsApi.js'
    import { AdminsViewContent } from './tenant/admins/AdminsView.jsx'
    import { DeleteAdminDialogView } from './tenant/admins/DeleteAdminDialog.jsx'
    const noop = () => {}
    export const renderContent = (state) =>
      renderToStaticMarkup(<AdminsViewContent state={state} email="" onEmail={noop} onCreate={noop} onBack={noop} onRetry={noop} onDeactivate={noop} onActivate={noop} onReset={noop} onRemove={noop} onConfirmRemoval={noop} onCancelRemoval={noop} onRefreshRemoval={noop} onCloseReveal={noop} />)
    export const renderRemoval = (removal, typed = '', restaurantName = 'Brasa 47') =>
      renderToStaticMarkup(<DeleteAdminDialogView removal={removal} restaurantName={restaurantName} typed={typed} onTyped={noop} onSubmit={noop} onCancel={noop} onRefresh={noop} inputRef={null} closeRef={null} refreshRef={null} dialogRef={null} />)
  `)
})
after(() => {
  globalThis.fetch = saved.fetch
})

test('API: one POST to .../delete with only { confirmEmail }, by UUID, with the real token, a single attempt even when the network fails', async () => {
  const seen = []
  globalThis.fetch = async (url, init) => (seen.push({ url: String(url), init }), { ok: true, status: 200, json: async () => ({ deleted: true }) })
  const api = mod.createAdminsApi({ getToken: () => 'real-token' })
  await api.deleteAdmin(BIZ.toUpperCase(), U1.toUpperCase(), '  Error@Brasa47.cl ')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url.replace(/^.*?\/businesses/, '/businesses'), `/businesses/${BIZ}/admins/${U1}/delete`)
  assert.equal(seen[0].init.method, 'POST')
  assert.equal(seen[0].init.body, '{"confirmEmail":"Error@Brasa47.cl"}')
  assert.equal(seen[0].init.headers.Authorization, 'Bearer real-token')
  assert.doesNotMatch(seen[0].url, /\?|businessId=/)
  // invalid ids or confirmation never reach the network
  seen.length = 0
  await assert.rejects(async () => api.deleteAdmin('x', U1, 'a@b.cl'), TypeError)
  await assert.rejects(async () => api.deleteAdmin(BIZ, 'me', 'a@b.cl'), TypeError)
  await assert.rejects(async () => api.deleteAdmin(BIZ, U1, ''), TypeError)
  await assert.rejects(async () => api.deleteAdmin(BIZ, U1, '   '), TypeError)
  await assert.rejects(async () => api.deleteAdmin(BIZ, U1, undefined), TypeError)
  await assert.rejects(async () => api.deleteAdmin(BIZ, U1, 'a'.repeat(255)), TypeError)
  assert.equal(seen.length, 0)
  // a network failure is one attempt, surfaced to the caller; nothing retries
  let calls = 0
  globalThis.fetch = async () => { calls += 1; throw new TypeError('Failed to fetch') }
  await assert.rejects(async () => api.deleteAdmin(BIZ, U1, 'a@b.cl'))
  assert.equal(calls, 1)
})

// ======================================================================================================================
// the markup
// ======================================================================================================================
const withRemoval = (removal, items = [A1, A2]) => ({
  business: { id: BIZ, name: 'Brasa 47', slug: 'brasa-47', active: true },
  list: { status: 'ready', items, error: null },
  create: { phase: 'idle', error: null },
  busy: [],
  reveal: null,
  removal,
})
const idle = (extra = {}) => ({ admin: { id: U1, email: 'error@brasa47.cl' }, phase: 'idle', error: null, id: null, ...extra })

test('row: "Eliminar" is a separate, warning-styled action after the reversible ones; busy disables it; an account the list proves undeletable shows it as unavailable WITH the reason', () => {
  const html = mod.renderContent(withRemoval(null, [admin(U1, 'a@x.test', { active: true, mustChangePassword: false }), admin(U2, 'b@x.test')]))
  assert.equal((html.match(/admin-row__delete/g) ?? []).length, 2)
  assert.match(html, /aria-label="Eliminar a a@x\.test"/)
  assert.match(html, /aria-label="Eliminar a b@x\.test"/)
  assert.match(html, /aria-label="Desactivar a a@x\.test"/)
  assert.match(html, /aria-label="Activar a b@x\.test"/)
  const rows = html.match(/<li class="admin-row[^"]*"><div class="admin-row__main">[\s\S]*?<\/li>/g)
  assert.equal(rows.length, 2)
  const [blockedRow, openRow] = rows
  assert.ok(blockedRow.indexOf('Desactivar') < blockedRow.indexOf('Restablecer') && blockedRow.indexOf('Restablecer') < blockedRow.indexOf('admin-row__delete'), 'it comes last, apart from the reversible actions')
  // the blocked one: aria-disabled (still reachable), the reason is read by assistive tech and shown as a tooltip
  const button = blockedRow.match(/<button[^>]*admin-row__delete[^>]*>/)[0]
  assert.match(button, /aria-disabled="true"/)
  assert.match(button, /aria-describedby="([^"]+)"/)
  const id = button.match(/aria-describedby="([^"]+)"/)[1]
  assert.match(blockedRow, new RegExp(`<span id="${id}" class="visually-hidden">Esta cuenta está activa\\. Para poder eliminarla, primero desactívala\\.</span>`))
  assert.match(button, /title="Esta cuenta está activa/)
  assert.doesNotMatch(button, /\sdisabled(=|\s|>)/, 'not natively disabled: the keyboard still reaches it and gets the explanation')
  // the open one: a normal button
  const open = openRow.match(/<button[^>]*admin-row__delete[^>]*>/)[0]
  assert.doesNotMatch(open, /aria-disabled|aria-describedby|title=/)
  assert.doesNotMatch(html, /role="dialog"/, 'no dialog until requested')
  const busy = mod.renderContent({ ...withRemoval(null, [admin(U1, 'a@x.test')]), busy: [U1] })
  assert.match(busy, /admin-row__delete[^>]*disabled/)
})

test('dialog: names the account and the restaurant, explains irreversibility, the sessions and who it is for, and asks for the exact e-mail', () => {
  const html = mod.renderRemoval(idle(), '', 'Casa Olivo')
  assert.match(html, /role="dialog"/)
  assert.match(html, /aria-modal="true"/)
  assert.match(html, /aria-labelledby="[^"]+"/)
  assert.match(html, /aria-describedby="[^"]+"/)
  assert.match(html, /<h3[^>]*>Eliminar administrador<\/h3>/)
  assert.match(html, /error@brasa47\.cl/)
  assert.match(html, /Restaurante: Casa Olivo/)
  assert.match(html, /Esta acción es irreversible/)
  assert.match(html, /sus sesiones dejarán de funcionar de inmediato/)
  assert.match(html, /su correo quedará libre/)
  assert.match(html, /Solo para cuentas creadas por error y sin actividad/)
  assert.match(html, /debe estar desactivada/)
  assert.match(html, /no haber cambiado su contraseña inicial/)
  assert.match(html, /no tener historial de reactivaciones ni restablecimientos/)
  assert.match(html, /Si no cumple, no se elimina nada y te explicamos el motivo/)
  assert.match(html, /Para quitar el acceso a una cuenta en uso, déjala desactivada/)
  assert.doesNotMatch(html, /<ul/, 'the conditions are one short paragraph: the dialog is shorter on a phone, nothing is dropped')
  assert.match(html, /Para confirmar, escribe el correo exacto del administrador/)
  assert.match(html, /<label for="([^"]+)">[\s\S]*<input id="\1"/, 'the field is labelled')
  assert.match(html, /autoComplete="off"|autocomplete="off"/i)
  assert.match(html, /spellcheck="false"/i)
  assert.doesNotMatch(html.match(/<input[^>]*>/)[0], /placeholder=/, 'the e-mail is not pre-filled as a placeholder: the person types it')
  assert.match(html, /btn btn--danger btn--small/)
  assert.match(html, />Eliminar definitivamente</)
  assert.match(html, />Cancelar</)
})

test('dialog: the red button is disabled until the typed e-mail matches', () => {
  const finalButton = (html) => html.match(/<button type="submit"[^>]*>[^<]*<\/button>/)[0]
  assert.match(finalButton(mod.renderRemoval(idle(), '')), /disabled/)
  assert.match(finalButton(mod.renderRemoval(idle(), 'otro@brasa47.cl')), /disabled/)
  assert.doesNotMatch(finalButton(mod.renderRemoval(idle(), 'error@brasa47.cl')), /disabled/)
  assert.doesNotMatch(finalButton(mod.renderRemoval(idle(), '  ERROR@Brasa47.cl ')), /disabled/)
  assert.match(mod.renderRemoval(idle(), 'err'), /Todavía no coincide/)
})

test('dialog phases: deleting (locked), refused (reason + only "Cerrar"), ambiguous (re-read, never "eliminada"), checking', () => {
  const deleting = mod.renderRemoval(idle({ phase: 'deleting', id: 1 }), 'error@brasa47.cl')
  assert.match(deleting, /Eliminando…/)
  assert.match(deleting.match(/<button type="submit"[^>]*>/)[0], /disabled/)
  assert.match(deleting.match(/<button[^>]*type="button"[^>]*>[^<]*Cancelar/)[0], /disabled/, 'cannot cancel while the request is pending')
  assert.match(deleting, /readOnly|readonly/i)

  const refused = mod.renderRemoval(idle({ phase: 'refused', error: describeRemovalError(apiError(409, 'ADMIN_HAS_ACTIVITY')) }), 'error@brasa47.cl')
  assert.match(refused, /role="alert"[^>]*>[^<]*actividad registrada/)
  assert.match(refused, />Cerrar</)
  assert.doesNotMatch(refused, /Eliminar definitivamente|Actualizar lista/)

  const ambiguous = mod.renderRemoval(idle({ phase: 'ambiguous', id: 1, error: describeRemovalError(new TypeError('Failed to fetch')) }), 'error@brasa47.cl')
  assert.match(ambiguous, /No la damos por eliminada/)
  assert.match(ambiguous, />Actualizar lista</)
  assert.match(ambiguous, />Cerrar</)
  assert.doesNotMatch(ambiguous, /Eliminar definitivamente/)

  const checking = mod.renderRemoval(idle({ phase: 'checking', id: 1, error: describeRemovalError(apiError(500)) }), 'error@brasa47.cl')
  assert.match(checking, />Actualizando…</)
  assert.match(checking.match(/<button[^>]*type="button"[^>]*>[^<]*Actualizando/)[0], /disabled/)
  assert.match(checking.match(/<button[^>]*type="button"[^>]*>[^<]*Cerrar/)[0], /disabled/)
})

test('the view renders the dialog only when the store has a removal open', () => {
  assert.doesNotMatch(mod.renderContent(withRemoval(null)), /Eliminar administrador<\/h3>/)
  assert.match(mod.renderContent(withRemoval(idle())), /Eliminar administrador<\/h3>/)
})

// ======================================================================================================================
// roles, accessibility and styles — by construction
// ======================================================================================================================
test('visibility by role: the delete UI exists only inside the SUPER_ADMIN view, mounted only by the selector gate; no role/token logic of its own', () => {
  const gate = code(read('../selector/BusinessGate.jsx'))
  assert.match(gate, /adminsState\.business !== null\) return <AdminsView store=\{admins\} onBack=\{admins\.close\} \/>/)
  const panel = code(read('../../pages/admin/AdminPanel.jsx'))
  assert.match(panel, /isBusinessSelectable \? <BusinessGate onBusiness=\{setBusiness\}>\{panels\}<\/BusinessGate> : panels/, 'an ADMIN renders the panels directly, never the gate')
  for (const file of ['./DeleteAdminDialog.jsx', './removalDialogModel.js', './adminsApi.js']) {
    const source = code(read(file))
    assert.doesNotMatch(source, /user\??\.role|SUPER_ADMIN|'ADMIN'|Authorization|accessToken|jwt|login\(|localStorage|sessionStorage|console\./i, file)
  }
  // the dialog is imported by the admins view only
  assert.match(code(read('./AdminsView.jsx')), /import DeleteAdminDialog from '\.\/DeleteAdminDialog\.jsx'/)
})

test('accessibility: dialog semantics, the shared focus trap, Escape/backdrop blocked while pending, 44px targets, focus follows the outcome', () => {
  const dialog = code(read('./DeleteAdminDialog.jsx'))
  assert.match(dialog, /role="dialog" aria-modal="true" aria-labelledby=\{titleId\} aria-describedby=\{descriptionId\}/)
  assert.match(dialog, /useDialogA11y\(\{ containerRef: dialogRef, onEscape: onCancel, initialFocusRef: inputRef, disableEscape: model\.inFlight \}\)/)
  assert.doesNotMatch(dialog, /className="confirm-backdrop"[^>]*onClick/, 'the backdrop never closes the dialog')
  assert.match(dialog, /readOnly=\{model\.inputReadOnly\}/, 'read-only, not disabled: keyboard focus is not lost')
  assert.doesNotMatch(dialog, /disabled=\{model\.inputDisabled\}/)
  assert.match(dialog, /if \(model\.canConfirm\) onSubmit\(\)/, 'Enter submits only when the red button would be enabled')
  assert.match(dialog, /closeRef\.current\?\.focus\(\)/)
  assert.match(dialog, /refreshRef\.current\?\.focus\(\)/)
  const css = code(read('../../styles/index.css'))
  assert.match(css, /\.delete-admin__actions \.btn \{\s*min-height: 44px;/)
  assert.match(css, /@media \(max-width: 420px\) \{\s*\.delete-admin__actions \{\s*flex-direction: column;/, 'buttons stack on phones, in keyboard order (never column-reverse)')
  assert.doesNotMatch(css.slice(css.indexOf('.delete-admin__actions')), /\.delete-admin__actions \{[^}]*column-reverse/)
})

test('styles: the new rules use only theme tokens, hover is behind (hover: hover), and the pairs they use reach WCAG AA in light AND dark', async () => {
  const css = code(read('../../styles/index.css'))
  const start = css.indexOf('.admin-row__delete {')
  const end = css.indexOf('.temp-password__restaurant {', start)
  assert.ok(start > 0 && end > start)
  const block = css.slice(start, end)
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|:\s*(white|black)\b/, 'no literal colour')
  assert.match(block, /\.admin-row__delete \{[^}]*color: var\(--danger\);[^}]*background: var\(--danger-tint\);[^}]*border-color: var\(--danger\)/)
  assert.match(block, /@media \(hover: hover\) \{\s*\.admin-row__delete:hover:not\(:disabled\)/)
  assert.match(block, /\.delete-admin__warning \{[^}]*var\(--danger-tint\)[^}]*border-left: 4px solid var\(--danger\)/)

  const { contrastRatio } = await import('../../theme/color.js')
  const tokens = read('../../styles/tokens.css')
  const darkAt = tokens.indexOf(':root[data-theme="dark"] {')
  const darkEnd = tokens.indexOf('\n}', darkAt)
  const declarations = (text) => {
    const out = {}
    for (const m of text.matchAll(/\n\s*(--[a-z0-9-]+):\s*(#[0-9A-Fa-f]{3,8}|var\(--[a-z0-9-]+\));/g)) if (!(m[1] in out)) out[m[1]] = m[2]
    return out
  }
  const light = declarations(tokens.slice(0, darkAt))
  const dark = { ...light, ...declarations(tokens.slice(darkAt, darkEnd)) }
  const resolve = (theme, name, depth = 0) => {
    const value = theme[name]
    if (value === undefined || depth > 5) return null
    const alias = /^var\((--[a-z0-9-]+)\)$/.exec(value)
    return alias ? resolve(theme, alias[1], depth + 1) : value
  }
  const pairs = [
    ['--danger', '--danger-tint'], // the "Eliminar" button text
    ['--text', '--danger-tint'], // the irreversibility notice
    ['--on-danger', '--danger'], // its hover and the red confirmation button
    ['--text-muted', '--surface'], // restaurant line and hints
    ['--text-secondary', '--input-bg'], // the read-only field
  ]
  const failures = []
  for (const [themeName, theme] of [['light', light], ['dark', dark]]) {
    for (const [fg, bg] of pairs) {
      const a = resolve(theme, fg)
      const b = resolve(theme, bg)
      const ratio = a && b ? contrastRatio(a, b) : null
      if (ratio === null || ratio < 4.5) failures.push(`${themeName}: ${fg} on ${bg} = ${ratio === null ? 'unresolved' : ratio.toFixed(2)}`)
    }
  }
  assert.deepEqual(failures, [])
  // the tokens used exist for both themes
  for (const token of ['--danger', '--danger-tint', '--on-danger', '--text-muted', '--text-secondary', '--input-bg']) {
    assert.ok(token in light && token in dark, token)
  }
})

test('no secret, no loop: the deletion code never touches passwords, storage, the URL or the console, and schedules no second attempt', () => {
  for (const file of ['./DeleteAdminDialog.jsx', './removalDialogModel.js', './adminErrors.js']) {
    const source = code(read(file))
    assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie|console\.|location\.|history\.|URLSearchParams/i, file)
    assert.doesNotMatch(source, /setTimeout|setInterval|requestAnimationFrame|while \(/, `${file}: no timers or loops`)
  }
  // the dialog and its model have nothing to do with passwords (the error codes of the shared mapper legitimately name them)
  for (const file of ['./DeleteAdminDialog.jsx', './removalDialogModel.js']) assert.doesNotMatch(code(read(file)), /password|temporaryPassword|reveal/i, file)
  const store = code(read('./adminsStore.js'))
  const removalPart = store.slice(store.indexOf('requestRemoval('), store.indexOf('resetPassword:'))
  assert.ok(removalPart.length > 500, 'the scan really covers the deletion methods')
  assert.doesNotMatch(removalPart, /setTimeout|setInterval|for \(|while \(/, 'the deletion never loops or schedules a second attempt')
  assert.equal((removalPart.match(/api\.deleteAdmin\(/g) ?? []).length, 1, 'one call site, one attempt')
})

// ======================================================================================================================
// 9D.5 review: known eligibility, the confirmation contract with the backend, focus after a deletion, shorter text, legibility
// ======================================================================================================================
test('known eligibility: ONLY what the list proves blocks the action (active, or initial password already changed); a missing field never does; nothing else is inferred', () => {
  const block = (extra) => knownRemovalBlock({ id: U1, email: 'a@x.test', ...extra })
  assert.equal(block({ active: true, mustChangePassword: true })?.kind, 'active')
  assert.equal(block({ active: true, mustChangePassword: false })?.kind, 'active', 'active is reported first')
  assert.equal(block({ active: false, mustChangePassword: false })?.kind, 'password-changed')
  assert.match(block({ active: true }).message, /primero desactívala/)
  assert.match(block({ active: false, mustChangePassword: false }).message, /ya cambió su contraseña inicial/)
  // the only combination that is NOT blocked by what the list says: inactive + initial password pending
  assert.equal(block({ active: false, mustChangePassword: true }), null)
  // a field that is not there (or not a real boolean) proves nothing
  for (const extra of [{}, { active: undefined }, { active: 'true' }, { active: 1 }, { active: null, mustChangePassword: null }, { active: false }, { active: false, mustChangePassword: 'false' }]) assert.equal(block(extra), null, JSON.stringify(extra))
  assert.equal(knownRemovalBlock(null), null)
  assert.equal(knownRemovalBlock(undefined), null)
})

test('known eligibility in the store: a blocked account never opens the dialog and sends nothing; the server\'s own refusals are still handled for the cases the list cannot know', async () => {
  const api = fakeServer([admin(U1, 'activo@x.test', { active: true, mustChangePassword: false }), admin(U2, 'cambio@x.test', { active: false, mustChangePassword: false })])
  const store = await opened(api)
  const first = await store.requestRemoval(api.db.admins[0])
  assert.equal(first.ok, false)
  assert.equal(first.blocked.kind, 'active')
  const second = await store.requestRemoval(api.db.admins[1])
  assert.equal(second.blocked.kind, 'password-changed')
  assert.equal(store.getState().removal, null, 'no dialog')
  assert.deepEqual(kinds(api), ['list'], 'nothing was sent')
  // a stale list (it says inactive, the server says active) is still refused by the server with its own reason
  const stale = fakeServer([A1], { remove: () => { throw apiError(409, 'ADMIN_STILL_ACTIVE') } })
  const store2 = await opened(stale)
  store2.requestRemoval(A1)
  assert.equal((await store2.confirmRemoval('error@brasa47.cl')).error.kind, 'still-active')
})

test('confirmEmail contract: the frontend judges the text EXACTLY like the backend (trim + lowercase of the typed text, stored address lower-cased only, max 254)', () => {
  // backend, verbatim: DeleteBusinessAdminDto normalizeEmail = value.trim().toLowerCase(); BusinessAdminService.remove: target.email.toLowerCase() !== confirmEmail
  const backendAccepts = (typed, stored) => {
    const normalised = typed.trim().toLowerCase()
    return normalised.length > 0 && normalised.length <= 254 && stored.toLowerCase() === normalised
  }
  const stored = 'Error.Creado@Brasa47.CL' // a legacy mixed-case address: still matches in both
  const typedCases = [
    'error.creado@brasa47.cl', 'ERROR.CREADO@BRASA47.CL', '  error.creado@brasa47.cl  ', '\terror.creado@brasa47.cl\n', '\u00A0error.creado@brasa47.cl\u00A0', '\u2003error.creado@brasa47.cl',
    'error.creado@brasa47.c', 'error.creado@brasa47.cl.', 'error creado@brasa47.cl', '', '   ', 'otro@brasa47.cl', 'error.creado@brasa47.cl'.padEnd(300, 'x'),
  ]
  for (const typed of typedCases) assert.equal(confirmationMatches(typed, stored), backendAccepts(typed, stored), JSON.stringify(typed))
  // the stored address is NEVER trimmed (the backend does not trim it): an address stored with spaces cannot be confirmed by either side
  assert.equal(confirmationMatches('a@x.test', ' a@x.test '), backendAccepts('a@x.test', ' a@x.test '))
  assert.equal(confirmationMatches('a@x.test', ' a@x.test '), false)
  // what is sent is the typed text, trimmed (the backend lowercases it again): same bytes the person confirmed
  assert.match(code(read('./adminsApi.js')), /confirmEmail: confirmEmail\.trim\(\)/)
  assert.match(code(read('./adminsApi.js')), /confirmEmail\.length > 254/)
  assert.match(code(read('./DeleteAdminDialog.jsx')), /maxLength=\{254\}/, 'the field accepts what the backend accepts')
})

test('focus after a deletion: events arrive AFTER the list was re-read, so the target exists; the view moves focus to the list summary, never <body>', async () => {
  const api = fakeServer([A1, A2])
  const store = await opened(api)
  const seen = []
  store.onChange((event) => seen.push({ ...event, ids: store.getState().list.items.map((a) => a.id), dialog: store.getState().removal }))
  store.requestRemoval(A1)
  await store.confirmRemoval('error@brasa47.cl')
  assert.deepEqual(seen, [{ type: 'removed', email: 'error@brasa47.cl', ids: [U2], dialog: null }], 'when the notice (and the focus move) fires, the deleted row is already gone and the dialog is closed')
  // alreadyDeleted and the neutral "gone" notice behave the same way
  const again = fakeServer([A1, A2], { remove: ({ id, uid, confirmEmail }) => ({ deleted: true, alreadyDeleted: true, id: uid, email: confirmEmail, businessId: id }) })
  const store2 = await opened(again)
  const seen2 = []
  store2.onChange((event) => seen2.push({ type: event.type, ids: store2.getState().list.items.map((a) => a.id) }))
  store2.requestRemoval(A1)
  await store2.confirmRemoval('error@brasa47.cl')
  assert.deepEqual(seen2, [{ type: 'already-removed', ids: [U1, U2] }], 'the fake keeps the row, the order is what matters: the list was re-read first')
  // a view that was closed meanwhile receives no notice at all
  const gate = deferred()
  const api3 = fakeServer([A1, A2])
  const store3 = await opened({ ...api3, deleteAdmin: (...args) => gate.promise.then(() => api3.deleteAdmin(...args)) })
  const seen3 = collect(store3)
  store3.requestRemoval(A1)
  const pending = store3.confirmRemoval('error@brasa47.cl')
  store3.close()
  gate.resolve()
  await pending
  assert.deepEqual(seen3, [])
})

test('focus after a deletion: the summary is focusable (tabindex -1) in the list and in the empty state, and the view focuses it after every confirmed removal', () => {
  const withItems = mod.renderContent(withRemoval(null, [admin(U1, 'a@x.test'), admin(U2, 'b@x.test')]))
  assert.match(withItems, /<p tabindex="-1" class="business-picker__count" aria-live="polite">2 administradores<\/p>/)
  const empty = mod.renderContent(withRemoval(null, []))
  assert.match(empty, /<p tabindex="-1" class="business-picker__status" role="status">Este restaurante todavía no tiene administradores/)
  const view = code(read('./AdminsView.jsx'))
  assert.match(view, /const listFocusRef = useRef\(null\)/)
  assert.match(view, /useEffect\(\(\) => \{\s*if \(focusRequest > 0\) listFocusRef\.current\?\.focus\(\)\s*\}, \[focusRequest\]\)/)
  assert.match(view, /event\.type === 'removed' \|\| event\.type === 'already-removed' \|\| event\.type === 'gone'/)
  assert.match(view, /setFocusRequest\(\(n\) => n \+ 1\)/)
  assert.match(view, /listFocusRef=\{listFocusRef\}/)
  assert.match(view, /if \(result\.blocked\) toast\.info\(result\.blocked\.message\)/, 'activating an unavailable action explains why (touch and keyboard users have no tooltip)')
  const css = code(read('../../styles/index.css'))
  assert.match(css, /\.business-picker__count\[tabindex='-1'\]:focus-visible,\s*\.business-picker__status\[tabindex='-1'\]:focus-visible \{[^}]*outline: 2px solid var\(--focus-ring\)/)
})

test('phone layout: shorter copy, the dialog scrolls inside itself, its actions stay pinned and a focused field is never hidden behind them', () => {
  const css = code(read('../../styles/index.css'))
  assert.match(css, /\.business-dialog \{[^}]*max-height: calc\(100dvh - 40px\);[^}]*overflow-y: auto;/, 'the existing dialog already scrolls within the viewport')
  assert.match(css, /\.delete-admin \{[^}]*overscroll-behavior: contain;[^}]*scroll-padding-bottom: 96px;/)
  assert.match(css, /@media \(max-width: 420px\) \{\s*\.delete-admin__actions \{\s*flex-direction: column;\s*position: sticky;\s*bottom: -22px;[^}]*background: var\(--surface\);/)
  // a scrolling dialog makes its text reachable with Tab (a text field would swallow PageUp/arrows); otherwise no extra tab stop
  const dialogSource = code(read('./DeleteAdminDialog.jsx'))
  assert.match(dialogSource, /tabIndex=\{scrollable \? 0 : undefined\} role=\{scrollable \? 'group' : undefined\} aria-labelledby=\{scrollable \? titleId : undefined\}/)
  assert.match(dialogSource, /element\.scrollHeight > element\.clientHeight \+ 1/)
  assert.match(dialogSource, /window\.addEventListener\('resize', measure\)[\s\S]*window\.removeEventListener\('resize', measure\)/, 'the listener is removed')
  assert.doesNotMatch(mod.renderRemoval(idle(), ''), /tabindex="0"/, 'not scrollable (static render): no extra tab stop')
  assert.match(css, /\.delete-admin__description:focus-visible \{[^}]*outline: 2px solid var\(--focus-ring\)/)
  // the copy is one short paragraph per idea: at most ~5 sentences of explanation in total, still with every important fact
  const html = mod.renderRemoval(idle(), '')
  const description = html.match(/<div id="[^"]+" class="delete-admin__description"[^>]*>([\s\S]*?)<\/div><form/)[1].replace(/<[^>]+>/g, ' ')
  assert.ok(description.replace(/\s+/g, ' ').length < 520, `the explanation is ${description.length} characters`)
  for (const fact of [/irreversible/, /para siempre/, /sesiones dejarán de funcionar/, /correo quedará libre/, /creadas por error/, /desactivada/, /contraseña inicial/, /reactivaciones ni restablecimientos/, /no se elimina nada/, /déjala desactivada/]) assert.match(description, fact)
})

test('legibility: the explanatory copy of the dialog uses a stronger tone than --text-secondary in BOTH themes, and every pair it uses keeps a high contrast', async () => {
  const css = code(read('../../styles/index.css'))
  const start = css.indexOf('.delete-admin {')
  const end = css.indexOf('.delete-admin input[readonly]', start)
  const block = css.slice(start, end)
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|:\s*(white|black)\b/, 'no literal colour')
  assert.match(block, /--delete-admin-soft: var\(--text\);/, 'a fallback for browsers without color-mix')
  assert.match(block, /@supports \(color: color-mix\(in srgb, red 50%, blue\)\) \{\s*\.delete-admin \{\s*--delete-admin-soft: color-mix\(in srgb, var\(--text\) 80%, var\(--surface\)\);/)
  for (const selector of ['.delete-admin__restaurant', '.delete-admin .business-dialog__intro', '.delete-admin .business-dialog__hint', '.delete-admin__typed-hint']) {
    assert.match(block, new RegExp(`${selector.replace(/[.]/g, '\\.')} \\{[^}]*color: var\\(--delete-admin-soft\\)`), selector)
  }
  assert.match(block, /\.delete-admin \.admin-menu__form label \{\s*color: var\(--text\);/)
  // sizes went up slightly
  assert.match(block, /\.delete-admin \.business-dialog__intro \{[^}]*font-size: 14px/)
  assert.match(block, /\.delete-admin__restaurant \{[^}]*font-size: 13\.5px/)

  const { contrastRatio, mixHex } = await import('../../theme/color.js')
  const tokens = read('../../styles/tokens.css')
  const darkAt = tokens.indexOf(':root[data-theme="dark"] {')
  const darkEnd = tokens.indexOf('\n}', darkAt)
  const declarations = (text) => {
    const out = {}
    for (const m of text.matchAll(/\n\s*(--[a-z0-9-]+):\s*(#[0-9A-Fa-f]{3,8}|var\(--[a-z0-9-]+\));/g)) if (!(m[1] in out)) out[m[1]] = m[2]
    return out
  }
  const light = declarations(tokens.slice(0, darkAt))
  const dark = { ...light, ...declarations(tokens.slice(darkAt, darkEnd)) }
  const resolve = (theme, name, depth = 0) => {
    const value = theme[name]
    if (value === undefined || depth > 5) return null
    const alias = /^var\((--[a-z0-9-]+)\)$/.exec(value)
    return alias ? resolve(theme, alias[1], depth + 1) : value
  }
  const failures = []
  for (const [themeName, theme] of [['light', light], ['dark', dark]]) {
    const text = resolve(theme, '--text')
    const surface = resolve(theme, '--surface')
    const soft = mixHex(text, surface, 0.2) // 80% --text + 20% --surface, as the CSS declares (the weight is the one of the SECOND colour)
    const secondary = resolve(theme, '--text-secondary')
    const onSurface = contrastRatio(soft, surface)
    const onInput = contrastRatio(soft, resolve(theme, '--input-bg'))
    if (!(contrastRatio(soft, surface) > contrastRatio(secondary, surface))) failures.push(`${themeName}: the soft tone is not stronger than --text-secondary`)
    if (onSurface < 7) failures.push(`${themeName}: soft on surface = ${onSurface.toFixed(2)}`)
    if (onInput < 7) failures.push(`${themeName}: soft on input-bg = ${onInput.toFixed(2)}`)
    if (contrastRatio(text, resolve(theme, '--danger-tint')) < 7) failures.push(`${themeName}: --text on --danger-tint`)
  }
  assert.deepEqual(failures, [])
})
