import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { loadModule } from '../../theme/testSupport.js'
import { createBusinessListStore } from '../selector/businessListStore.js'
import { createBusinessValidator } from '../selector/businessValidation.js'
import { BUSINESS_FIELD_LIMITS, SUSPENSION_REASON_MAX, buildBusinessPatch, formFromBusiness, normalizeReason, validateBusinessForm } from './businessForm.js'
import { describeManagementError } from './managementErrors.js'
import { createBusinessManagementStore } from './managementStore.js'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const here = readdirSync(new URL('.', import.meta.url)).filter((f) => /\.(js|jsx)$/.test(f) && !f.endsWith('.test.js')).map((f) => [f, code(read(`./${f}`))])

const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const full = (id, extra = {}) => ({ id, name: 'Brasa 47', slug: 'brasa-47', active: true, address: 'Calle 1', phone: null, hours: null, logoUrl: null, ...extra })
const item = (id, name = 'Brasa 47') => ({ id, name, slug: name.toLowerCase().replace(/\s+/g, '-'), active: true, logoUrl: null })
const apiError = (status, code, extra = {}) => Object.assign(new Error(`HTTP ${status}`), { status, code, ...extra })
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

function fakeApi(overrides = {}) {
  const calls = []
  const api = {
    calls,
    fetchBusiness: async (id) => (calls.push(['fetch', id]), full(id)),
    updateBusiness: async (id, patch) => (calls.push(['update', id, patch]), full(id, patch)),
    deactivateBusiness: async (id, reason) => (calls.push(['deactivate', id, reason]), full(id, { active: false })),
    activateBusiness: async (id) => (calls.push(['activate', id]), full(id)),
    ...overrides,
  }
  return api
}
const collect = (store) => {
  const events = []
  store.onChange((e) => events.push(e))
  return events
}

// ======================================================================================================================
// form: the PUBLISHED backend contract (PATCH /businesses/:id accepts name, address, phone, hours only)
// ======================================================================================================================
test('form limits are exactly the ceilings the backend DTOs enforce (read from the backend source)', () => {
  const dto = readFileSync(new URL('../../../backend/src/business/dto/admin-update-business.dto.ts', import.meta.url), 'utf8')
  const limits = [...dto.matchAll(/@MaxLength\((\d+)\)\s*\n\s*(\w+)\??:/g)].map((m) => [m[2], Number(m[1])])
  assert.deepEqual(Object.fromEntries(limits), BUSINESS_FIELD_LIMITS)
  const reasonDto = readFileSync(new URL('../../../backend/src/business/dto/deactivate-business.dto.ts', import.meta.url), 'utf8')
  assert.equal(Number(reasonDto.match(/BUSINESS_SUSPENSION_REASON_MAX_LENGTH = (\d+)/)[1]), SUSPENSION_REASON_MAX)
})

test('the form only ever contains name, address, phone and hours', () => {
  const form = formFromBusiness(full(ID_A, { phone: '+56 9', hours: 'Lun-Dom', slug: 'x', active: false, logoUrl: 'u', primaryColor: '#112233', id: ID_A }))
  assert.deepEqual(Object.keys(form).sort(), ['address', 'hours', 'name', 'phone'])
  assert.deepEqual(formFromBusiness(null), { name: '', address: '', phone: '', hours: '' })
  // whatever else is in the form object, a patch can only hold the four editable fields
  const patch = buildBusinessPatch(full(ID_A), { name: 'Otro', slug: 'hack', active: false, logoStorageKey: 'x', primaryColor: '#000000', id: 'x', address: 'Calle 1', phone: '', hours: '' })
  assert.deepEqual(patch, { name: 'Otro' })
})

test('validation: name is required, every field has the backend ceiling, blanks are fine for the optional ones', () => {
  assert.deepEqual(validateBusinessForm({ name: 'Ok', address: '', phone: '', hours: '' }), {})
  assert.match(validateBusinessForm({ name: '   ' }).name, /obligatorio/)
  assert.match(validateBusinessForm({ name: 'n'.repeat(121) }).name, /120/)
  assert.deepEqual(validateBusinessForm({ name: 'n'.repeat(120), address: 'a'.repeat(200), phone: 'p'.repeat(40), hours: 'h'.repeat(200) }), {})
  const tooLong = validateBusinessForm({ name: 'Ok', address: 'a'.repeat(201), phone: 'p'.repeat(41), hours: 'h'.repeat(201) })
  assert.deepEqual(Object.keys(tooLong).sort(), ['address', 'hours', 'phone'])
})

test('patch: trimmed, only what changed, a blank optional field clears it (null), nothing changed -> {}', () => {
  const business = full(ID_A, { address: 'Calle 1', phone: '+56 9', hours: null })
  assert.deepEqual(buildBusinessPatch(business, formFromBusiness(business)), {})
  assert.deepEqual(buildBusinessPatch(business, { name: '  Brasa 47  ', address: ' Calle 1 ', phone: '+56 9', hours: '   ' }), {}, 'whitespace-only differences are not changes')
  assert.deepEqual(buildBusinessPatch(business, { name: 'Brasa Centro', address: '', phone: '+56 1', hours: ' 12-23 ' }), { name: 'Brasa Centro', address: null, phone: '+56 1', hours: '12-23' })
})

test('suspension reason: optional, trimmed, 200 chars at most', () => {
  assert.deepEqual(normalizeReason(undefined), { reason: null, error: null })
  assert.deepEqual(normalizeReason('   '), { reason: null, error: null })
  assert.deepEqual(normalizeReason('  Falta de pago '), { reason: 'Falta de pago', error: null })
  assert.equal(normalizeReason('r'.repeat(200)).error, null)
  assert.match(normalizeReason('r'.repeat(201)).error, /200/)
})

// ======================================================================================================================
// errors: exact status / errorCode of the published endpoints
// ======================================================================================================================
test('errors: 409 BUSINESS_HAS_PENDING_ORDERS carries the REAL count; other 409s are not that', () => {
  const one = describeManagementError(apiError(409, 'BUSINESS_HAS_PENDING_ORDERS', { count: 1 }))
  assert.equal(one.kind, 'pending-orders')
  assert.equal(one.count, 1)
  assert.match(one.message, /1 pedido pendiente\b/)
  assert.match(one.message, /antes de suspenderlo/)
  const many = describeManagementError(apiError(409, 'BUSINESS_HAS_PENDING_ORDERS', { count: 7 }))
  assert.match(many.message, /7 pedidos pendientes/)
  assert.equal(many.count, 7)
  const noCount = describeManagementError(apiError(409, 'BUSINESS_HAS_PENDING_ORDERS'))
  assert.equal(noCount.count, null)
  assert.doesNotMatch(noCount.message, /undefined|null|NaN/)
  assert.notEqual(describeManagementError(apiError(409, 'SOMETHING_ELSE', { count: 3 })).kind, 'pending-orders')
})

test('errors: 401, 403, 404, 400, network and server errors each have their own clear sentence', () => {
  const kinds = [401, 403, 404, 400, 500].map((s) => describeManagementError(apiError(s)).kind)
  assert.deepEqual(kinds, ['unauthorized', 'forbidden', 'not-found', 'invalid', 'server'])
  assert.equal(describeManagementError(new Error('Failed to fetch')).kind, 'network')
  assert.equal(describeManagementError(undefined).kind, 'network')
  for (const e of [apiError(401), apiError(403), apiError(404), apiError(400), apiError(500), new Error('x')]) {
    assert.doesNotMatch(describeManagementError(e).message, /HTTP|Error|undefined/)
  }
})

// ======================================================================================================================
// store: edit
// ======================================================================================================================
test('edit: opens loading, fetches the FULL record by id, then is ready', async () => {
  const api = fakeApi()
  const store = createBusinessManagementStore({ api })
  store.openEdit(item(ID_A))
  assert.equal(store.getState().dialog.phase, 'loading')
  assert.equal(store.getState().dialog.kind, 'edit')
  await tick()
  const { dialog } = store.getState()
  assert.equal(dialog.phase, 'ready')
  assert.deepEqual(api.calls, [['fetch', ID_A]])
  assert.equal(dialog.business.address, 'Calle 1', 'address/phone/hours come from GET /businesses/:id, the list does not carry them')
})

test('edit: a failed load can be retried; a 404 reports the business as missing and offers no retry path', async () => {
  let fail = true
  const events = []
  const store = createBusinessManagementStore({ api: fakeApi({ fetchBusiness: async (id) => { if (fail) throw apiError(500); return full(id) } }) })
  store.onChange((e) => events.push(e))
  store.openEdit(item(ID_A))
  await tick()
  assert.equal(store.getState().dialog.phase, 'load-error')
  fail = false
  store.retryLoad()
  assert.equal(store.getState().dialog.phase, 'loading')
  await tick()
  assert.equal(store.getState().dialog.phase, 'ready')
  assert.deepEqual(events, [])

  const gone = createBusinessManagementStore({ api: fakeApi({ fetchBusiness: async () => { throw apiError(404, 'BUSINESS_NOT_FOUND') } }) })
  const goneEvents = collect(gone)
  gone.openEdit(item(ID_B))
  await tick()
  assert.equal(gone.getState().dialog.error.kind, 'not-found')
  assert.deepEqual(goneEvents, [{ type: 'missing', businessId: ID_B }])
})

test('edit: a record answering for a DIFFERENT business is refused', async () => {
  const store = createBusinessManagementStore({ api: fakeApi({ fetchBusiness: async () => full(ID_B) }) })
  store.openEdit(item(ID_A))
  await tick()
  assert.equal(store.getState().dialog.phase, 'load-error')
  assert.equal(store.getState().dialog.business, null, 'nothing of the other business is kept')
})

test('edit: stale load — a slow answer for a closed dialog never lands on the next business', async () => {
  const slow = deferred()
  const api = fakeApi({ fetchBusiness: (id) => (id === ID_A ? slow.promise : Promise.resolve(full(id, { name: 'Otro Local' }))) })
  const store = createBusinessManagementStore({ api })
  store.openEdit(item(ID_A))
  store.close() // user gives up while A is still loading
  store.openEdit(item(ID_B, 'Otro Local'))
  await tick()
  assert.equal(store.getState().dialog.businessId, ID_B)
  assert.equal(store.getState().dialog.phase, 'ready')
  slow.resolve(full(ID_A, { name: 'VIEJO A' })) // A answers late
  await tick()
  const { dialog } = store.getState()
  assert.equal(dialog.businessId, ID_B)
  assert.equal(dialog.business.name, 'Otro Local')
  assert.notEqual(dialog.name, 'VIEJO A')
})

test('edit: invalid form -> field errors and NO request; no changes -> a notice and NO request', async () => {
  const api = fakeApi()
  const store = createBusinessManagementStore({ api })
  store.openEdit(item(ID_A))
  await tick()
  await store.submitEdit({ name: '   ', address: '', phone: '', hours: '' })
  assert.equal(store.getState().dialog.error.kind, 'validation')
  assert.match(store.getState().dialog.error.fields.name, /obligatorio/)
  await store.submitEdit(formFromBusiness(full(ID_A)))
  assert.equal(store.getState().dialog.error.kind, 'no-changes')
  assert.equal(store.getState().dialog.phase, 'ready')
  assert.deepEqual(api.calls.filter((c) => c[0] === 'update'), [])
})

test('edit: sends only the changed fields to PATCH /businesses/:id, reports it, closes; works on a SUSPENDED business', async () => {
  const api = fakeApi({ fetchBusiness: async (id) => full(id, { active: false }) })
  const store = createBusinessManagementStore({ api })
  const events = collect(store)
  store.openEdit({ ...item(ID_A), active: false })
  await tick()
  await store.submitEdit({ name: 'Brasa Centro', address: 'Calle 1', phone: '', hours: '' })
  assert.deepEqual(api.calls.filter((c) => c[0] === 'update'), [['update', ID_A, { name: 'Brasa Centro' }]])
  assert.equal(store.getState().dialog, null)
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'updated')
  assert.equal(events[0].business.name, 'Brasa Centro')
})

test('edit: a failed save keeps the dialog open (the component keeps the form), shows the reason and allows a retry', async () => {
  let fail = true
  const api = fakeApi({ updateBusiness: async (id, patch) => { if (fail) throw apiError(400); return full(id, patch) } })
  const store = createBusinessManagementStore({ api })
  const events = collect(store)
  store.openEdit(item(ID_A))
  await tick()
  await store.submitEdit({ name: 'Nuevo', address: 'Calle 1', phone: '', hours: '' })
  assert.equal(store.getState().dialog.phase, 'ready')
  assert.equal(store.getState().dialog.error.kind, 'invalid')
  assert.deepEqual(events, [])
  fail = false
  await store.submitEdit({ name: 'Nuevo', address: 'Calle 1', phone: '', hours: '' })
  assert.equal(store.getState().dialog, null)
  assert.equal(events[0].type, 'updated')
})

test('double submit: the second submit while saving sends NOTHING; the dialog cannot be closed meanwhile', async () => {
  const gate = deferred()
  const api = fakeApi({ updateBusiness: (id, patch) => (api.calls.push(['update', id, patch]), gate.promise) })
  const store = createBusinessManagementStore({ api })
  store.openEdit(item(ID_A))
  await tick()
  const first = store.submitEdit({ name: 'Nuevo', address: 'Calle 1', phone: '', hours: '' })
  assert.equal(store.getState().dialog.phase, 'saving', 'flips synchronously, before the request resolves')
  const second = store.submitEdit({ name: 'Nuevo', address: 'Calle 1', phone: '', hours: '' })
  store.close()
  assert.equal(store.getState().dialog.phase, 'saving', 'close is ignored while saving')
  gate.resolve(full(ID_A, { name: 'Nuevo' }))
  await Promise.all([first, second])
  assert.equal(api.calls.filter((c) => c[0] === 'update').length, 1)
})

test('one dialog at a time: opening another while one is open is ignored', async () => {
  const store = createBusinessManagementStore({ api: fakeApi() })
  store.openSuspend(item(ID_A))
  store.openEdit(item(ID_B))
  store.openActivate(item(ID_B))
  assert.equal(store.getState().dialog.kind, 'suspend')
  assert.equal(store.getState().dialog.businessId, ID_A)
})

// ======================================================================================================================
// store: suspend / reactivate
// ======================================================================================================================
test('suspend: POST deactivate with the trimmed reason, reports it, closes; no reason sends none', async () => {
  const api = fakeApi()
  const store = createBusinessManagementStore({ api })
  const events = collect(store)
  store.openSuspend(item(ID_A))
  assert.equal(store.getState().dialog.phase, 'ready', 'no fetch needed: it opens immediately')
  await store.submitSuspend('  Falta de pago  ')
  assert.deepEqual(api.calls, [['deactivate', ID_A, 'Falta de pago']])
  assert.equal(store.getState().dialog, null)
  assert.deepEqual(events.map((e) => [e.type, e.businessId, e.business.active]), [['deactivated', ID_A, false]])

  store.openSuspend(item(ID_B))
  await store.submitSuspend('   ')
  assert.deepEqual(api.calls[1], ['deactivate', ID_B, null])
})

test('suspend: a reason over 200 characters never reaches the API', async () => {
  const api = fakeApi()
  const store = createBusinessManagementStore({ api })
  store.openSuspend(item(ID_A))
  await store.submitSuspend('r'.repeat(201))
  assert.equal(api.calls.length, 0)
  assert.equal(store.getState().dialog.phase, 'ready')
  assert.match(store.getState().dialog.error.fields.reason, /200/)
})

test('suspend: 409 BUSINESS_HAS_PENDING_ORDERS -> "blocked" with the real count, no event, nothing forced, nothing to retry', async () => {
  const api = fakeApi({ deactivateBusiness: async (id, reason) => (api.calls.push(['deactivate', id, reason]), Promise.reject(apiError(409, 'BUSINESS_HAS_PENDING_ORDERS', { count: 4 }))) })
  const store = createBusinessManagementStore({ api })
  const events = collect(store)
  store.openSuspend(item(ID_A))
  await store.submitSuspend('')
  const { dialog } = store.getState()
  assert.equal(dialog.phase, 'blocked')
  assert.equal(dialog.pendingCount, 4)
  assert.match(dialog.error.message, /4 pedidos pendientes/)
  assert.deepEqual(events, [])
  await store.submitSuspend('otra vez') // a blocked dialog accepts no further submit
  assert.equal(api.calls.length, 1, 'exactly one request was ever sent, and there is no force/acknowledge variant of it')
  store.close()
  assert.equal(store.getState().dialog, null)
})

test('suspend/activate: double submit sends one request', async () => {
  const gate = deferred()
  const calls = []
  const store = createBusinessManagementStore({ api: fakeApi({ deactivateBusiness: (id) => (calls.push(id), gate.promise), activateBusiness: (id) => (calls.push(id), gate.promise) }) })
  store.openSuspend(item(ID_A))
  const a = store.submitSuspend('x')
  const b = store.submitSuspend('x')
  gate.resolve(full(ID_A, { active: false }))
  await Promise.all([a, b])
  store.openActivate(item(ID_B))
  const gate2 = deferred()
  const store2 = createBusinessManagementStore({ api: fakeApi({ activateBusiness: (id) => (calls.push(id), gate2.promise) }) })
  store2.openActivate(item(ID_B))
  const c = store2.submitActivate()
  const d = store2.submitActivate()
  gate2.resolve(full(ID_B))
  await Promise.all([c, d])
  assert.deepEqual(calls, [ID_A, ID_B])
})

test('activate: POST activate, reports it, closes — and never selects anything (the store has no selection capability)', async () => {
  const api = fakeApi()
  const store = createBusinessManagementStore({ api })
  const events = collect(store)
  store.openActivate({ ...item(ID_A), active: false })
  await store.submitActivate()
  assert.deepEqual(api.calls, [['activate', ID_A]])
  assert.deepEqual(events.map((e) => e.type), ['activated'])
  assert.equal(store.getState().dialog, null)
  assert.deepEqual(Object.keys(store).sort(), ['close', 'getState', 'onChange', 'openActivate', 'openEdit', 'openSuspend', 'retryLoad', 'submitActivate', 'submitEdit', 'submitSuspend', 'subscribe'])
})

test('errors while managing: 404 reports the business missing; 401/403/network keep the dialog with a clear message', async () => {
  for (const [error, kind] of [[apiError(404, 'BUSINESS_NOT_FOUND'), 'not-found'], [apiError(401), 'unauthorized'], [apiError(403), 'forbidden'], [new Error('offline'), 'network']]) {
    const store = createBusinessManagementStore({ api: fakeApi({ activateBusiness: async () => { throw error } }) })
    const events = collect(store)
    store.openActivate(item(ID_A))
    await store.submitActivate()
    assert.equal(store.getState().dialog.error.kind, kind)
    assert.equal(store.getState().dialog.phase, 'ready', 'can retry or close')
    assert.deepEqual(events.map((e) => e.type), kind === 'not-found' ? ['missing'] : [])
  }
})

test('a late answer after the dialog was replaced never touches the new one (serial ids)', async () => {
  const slow = deferred()
  const store = createBusinessManagementStore({ api: fakeApi({ activateBusiness: (id) => (id === ID_A ? slow.promise : Promise.resolve(full(id))) }) })
  const events = collect(store)
  store.openActivate(item(ID_A))
  const submit = store.submitActivate()
  assert.equal(store.getState().dialog.phase, 'saving')
  slow.reject(apiError(500))
  await submit
  assert.equal(store.getState().dialog.businessId, ID_A)
  assert.equal(store.getState().dialog.error.kind, 'server')
  assert.deepEqual(events, [])
})

// ======================================================================================================================
// list + validator reactions
// ======================================================================================================================
const listOf = async (items, active = 'all') => {
  const store = createBusinessListStore({ fetchPage: async () => ({ items, page: 1, total: items.length, totalPages: 1, hasMore: false }) })
  await store.load()
  if (active !== 'all') await store.setActive(active)
  return store
}

test('list: a change is applied in place (no refetch); under a filter a business that no longer matches leaves it', async () => {
  const store = await listOf([item(ID_A, 'Alfa'), item(ID_B, 'Beta')])
  store.applyChange({ ...full(ID_A, { name: 'Alfa Renovado', active: false }) })
  const [a, b] = store.getState().items
  assert.deepEqual([a.name, a.active, b.name, b.active], ['Alfa Renovado', false, 'Beta', true])
  assert.deepEqual(Object.keys(a).sort(), ['active', 'id', 'logoUrl', 'name', 'slug'], 'list rows keep the list shape (no address/phone/hours)')
  assert.equal(store.getState().total, 2)

  const onlyActive = await listOf([item(ID_A, 'Alfa'), item(ID_B, 'Beta')], 'true')
  onlyActive.applyChange(full(ID_A, { active: false }))
  assert.deepEqual(onlyActive.getState().items.map((x) => x.id), [ID_B])
  assert.equal(onlyActive.getState().total, 1)

  const unknown = await listOf([item(ID_A, 'Alfa')])
  unknown.applyChange(full(ID_B)) // not in the list: ignored
  assert.equal(unknown.getState().items.length, 1)
})

test('list: a missing (404) business is removed', async () => {
  const store = await listOf([item(ID_A, 'Alfa'), item(ID_B, 'Beta')])
  store.removeItem(ID_A)
  assert.deepEqual(store.getState().items.map((x) => x.id), [ID_B])
  assert.equal(store.getState().total, 1)
  store.removeItem(ID_A)
  assert.equal(store.getState().total, 1)
})

test('validator.refresh: updates the shown business of the SAME verified, active business only', async () => {
  const validator = createBusinessValidator({ fetchBusiness: async (id) => full(id) })
  await validator.validate(ID_A)
  validator.refresh(full(ID_A, { name: 'Nuevo Nombre' }))
  assert.equal(validator.getState().business.name, 'Nuevo Nombre')
  assert.equal(validator.getState().status, 'valid', 'no re-check: the mounted panels stay')
  validator.refresh(full(ID_B, { name: 'Otro' }))
  assert.equal(validator.getState().business.name, 'Nuevo Nombre', 'another business is ignored')
  validator.refresh(full(ID_A, { name: 'Suspendido', active: false }))
  assert.equal(validator.getState().business.name, 'Nuevo Nombre', 'a suspended one is never shown as valid')
  validator.reset()
  validator.refresh(full(ID_A, { name: 'Tarde' }))
  assert.equal(validator.getState().business, null, 'nothing is revived after a reset')
})

// ======================================================================================================================
// stale list answers vs management changes (revision mechanism): deterministic, no timers
// ======================================================================================================================
const A = item(ID_A, 'Alfa')
const B = item(ID_B, 'Beta')
const C = item('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Gamma')
const asRows = (store) => store.getState().items.map((b) => [b.name, b.active])
const pageOf = (items, extra = {}) => ({ items, page: 1, total: items.length, totalPages: 1, hasMore: false, ...extra })

test('"Cargar más" in flight: a restaurant suspended meanwhile is NOT shown active when the old page arrives', async () => {
  const second = deferred()
  const calls = []
  const store = createBusinessListStore({
    pageSize: 2,
    fetchPage: async (p) => (calls.push(p.page), p.page === 1 ? pageOf([A, B], { total: 3, totalPages: 2, hasMore: true }) : second.promise),
  })
  await store.load()
  const more = store.loadMore() // page 2 requested while A/B/C are all active
  store.applyChange(full(ID_B, { name: 'Beta', active: false })) // B (already on screen) suspended
  store.applyChange(full(C.id, { name: 'Gamma', active: false })) // C (NOT loaded yet) suspended
  second.resolve(pageOf([C], { page: 2, total: 3, totalPages: 2, hasMore: false })) // the answer still says C is active
  await more
  assert.deepEqual(asRows(store), [['Alfa', true], ['Beta', false], ['Gamma', false]])
  assert.deepEqual(calls, [1, 2], 'no extra request was made to reconcile')
})

test('a replace (search) in flight: the old answer cannot revive a suspended business, and under the "Activos" filter it stays out', async () => {
  const slow = deferred()
  const store = createBusinessListStore({ fetchPage: async (p) => (p.search === 'a' ? slow.promise : pageOf([A, B])) })
  await store.load()
  const search = store.setSearch('a')
  store.applyChange(full(ID_A, { name: 'Alfa', active: false }))
  slow.resolve(pageOf([A, B]))
  await search
  assert.deepEqual(asRows(store), [['Alfa', false], ['Beta', true]])
  assert.equal(store.getState().search, 'a', 'the search is kept')

  const filtered = deferred()
  const store2 = createBusinessListStore({ fetchPage: async (p) => (p.active === 'true' ? filtered.promise : pageOf([A, B])) })
  await store2.load()
  const only = store2.setActive('true')
  store2.applyChange(full(ID_A, { name: 'Alfa', active: false }))
  filtered.resolve(pageOf([A, B], { total: 2 }))
  await only
  assert.deepEqual(asRows(store2), [['Beta', true]], 'a suspended business never appears under the Activos filter')
  assert.equal(store2.getState().total, 1, 'the total follows what is shown')
  assert.equal(store2.getState().active, 'true', 'the filter is kept')
})

test('an edit during a request is not undone by the old answer; the latest of two changes wins', async () => {
  const slow = deferred()
  const store = createBusinessListStore({ pageSize: 2, fetchPage: async (p) => (p.page === 1 ? pageOf([A], { total: 2, totalPages: 2, hasMore: true }) : slow.promise) })
  await store.load()
  const more = store.loadMore()
  store.applyChange(full(ID_B, { name: 'Beta Renovada', active: false }))
  store.applyChange(full(ID_B, { name: 'Beta Final', active: true })) // suspended, then reactivated and renamed
  slow.resolve(pageOf([B], { page: 2, total: 2, totalPages: 2 })) // old answer: "Beta", active
  await more
  assert.deepEqual(asRows(store), [['Alfa', true], ['Beta Final', true]])
})

test('a business that stopped existing is not brought back by an old answer; the total follows', async () => {
  const slow = deferred()
  const store = createBusinessListStore({ pageSize: 2, fetchPage: async (p) => (p.page === 1 ? pageOf([A], { total: 3, totalPages: 2, hasMore: true }) : slow.promise) })
  await store.load()
  const more = store.loadMore()
  store.removeItem(ID_B)
  slow.resolve(pageOf([B, C], { page: 2, total: 3, totalPages: 2 }))
  await more
  assert.deepEqual(asRows(store), [['Alfa', true], ['Gamma', true]])
  assert.equal(store.getState().total, 2)
})

test('an answer to a request that STARTED after the change is trusted as it is (the server wins); old changes are forgotten', async () => {
  let serverSaysActive = false
  const store = createBusinessListStore({ pageSize: 1, fetchPage: async (p) => (p.page === 1 ? pageOf([A], { total: 2, totalPages: 2, hasMore: true }) : pageOf([{ ...B, active: serverSaysActive }], { page: 2, total: 2, totalPages: 2 })) })
  await store.load()
  store.applyChange(full(ID_B, { name: 'Beta', active: false })) // change BEFORE the request starts
  await store.loadMore() // started after the change: its answer already reflects the server's truth
  assert.deepEqual(asRows(store), [['Alfa', true], ['Beta', false]])

  // and the earlier change does not linger: a later reload shows what the server says now
  serverSaysActive = true
  await store.load()
  await store.loadMore()
  assert.deepEqual(asRows(store), [['Alfa', true], ['Beta', true]])
})

test('changes never trigger requests, and search / filter / page survive them', async () => {
  const calls = []
  const store = createBusinessListStore({ pageSize: 2, fetchPage: async (p) => (calls.push({ ...p }), pageOf([A, B], { total: 5, totalPages: 3, hasMore: true })) })
  await store.setSearch('al')
  await store.setActive('true')
  await store.loadMore()
  const before = calls.length
  const snapshot = { search: store.getState().search, active: store.getState().active, page: store.getState().page }
  store.applyChange(full(ID_A, { name: 'Alfa 2', active: true }))
  store.applyChange(full(C.id, { name: 'Gamma', active: false }))
  store.removeItem('dddddddd-dddd-4ddd-8ddd-dddddddddddd')
  assert.equal(calls.length, before)
  assert.deepEqual({ search: store.getState().search, active: store.getState().active, page: store.getState().page }, snapshot)
})

test('validator: a verification started for another business is dropped once the selection was cleared (e.g. after a suspension)', async () => {
  const slow = deferred()
  const validator = createBusinessValidator({ fetchBusiness: () => slow.promise })
  const pending = validator.validate(ID_A)
  validator.refresh(full(ID_A, { name: 'No debe aplicarse' })) // while still checking: ignored
  assert.equal(validator.getState().business, null)
  validator.reset() // the gate cleared the selection
  slow.resolve(full(ID_A, { name: 'Respuesta tardía' }))
  await pending
  assert.deepEqual(validator.getState(), { businessId: null, status: 'idle', business: null })
})

// ======================================================================================================================
// the real API calls and the real components
// ======================================================================================================================
let mod
const saved = { document: globalThis.document }
before(async () => {
  mod = await loadModule(`
    import { renderToStaticMarkup } from 'react-dom/server'
    export { createBusinessManagementApi } from './tenant/management/businessManagementApi.js'
    export { ApiError, apiFetch, setBusinessInactiveHandler, setUnauthorizedHandler } from './services/api.js'
    export { translateApiError } from './services/errorMessages.js'
    export { reactToBusinessInactive, MANAGED_SUSPENDED_MESSAGE, SUSPENDED_MESSAGE } from './context/suspension.js'
    export { suspensionEndsSession } from './tenant/tenantCore.js'
    import { EditDialog, SuspendDialog, ActivateDialog } from './tenant/management/BusinessManagementDialogs.jsx'
    import BusinessPickerView from './tenant/selector/BusinessPickerView.jsx'
    const noop = () => {}
    export const renderEdit = (dialog) => renderToStaticMarkup(<EditDialog dialog={dialog} onClose={noop} onRetry={noop} onSubmit={noop} />)
    export const renderSuspend = (dialog) => renderToStaticMarkup(<SuspendDialog dialog={dialog} onClose={noop} onSubmit={noop} />)
    export const renderActivate = (dialog) => renderToStaticMarkup(<ActivateDialog dialog={dialog} onClose={noop} onSubmit={noop} />)
    export const renderPicker = (state, management) => renderToStaticMarkup(<BusinessPickerView state={state} searchText="" management={management} onSearchText={noop} onActive={noop} onSelect={noop} onLoadMore={noop} onRetry={noop} />)
  `)
})
after(() => {
  globalThis.document = saved.document
})

test('management API: addressed by UUID, never tenant-scoped, never a businessId query, real token only', async () => {
  const seen = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => (seen.push({ url: String(url), init }), { ok: true, status: 200, json: async () => ({ id: ID_A }) })
  try {
    const api = mod.createBusinessManagementApi({ getToken: () => 'real-token' })
    await api.fetchBusiness(ID_A.toUpperCase())
    await api.updateBusiness(ID_A, { name: 'X' })
    await api.deactivateBusiness(ID_A, 'motivo')
    await api.deactivateBusiness(ID_A, null)
    await api.activateBusiness(ID_A)
    await assert.rejects(async () => api.fetchBusiness('../../etc/passwd'), TypeError)
    await assert.rejects(async () => api.activateBusiness('me'), TypeError)
  } finally {
    globalThis.fetch = realFetch
  }
  const rows = seen.map((s) => [s.init.method ?? 'GET', s.url.replace(/^.*?\/businesses/, '/businesses'), s.init.body])
  assert.deepEqual(rows, [
    ['GET', `/businesses/${ID_A}`, undefined],
    ['PATCH', `/businesses/${ID_A}`, '{"name":"X"}'],
    ['POST', `/businesses/${ID_A}/deactivate`, '{"reason":"motivo"}'],
    ['POST', `/businesses/${ID_A}/deactivate`, '{}'],
    ['POST', `/businesses/${ID_A}/activate`, '{}'],
  ])
  for (const s of seen) {
    assert.doesNotMatch(s.url, /businessId|\?/)
    assert.equal(s.init.headers.Authorization, 'Bearer real-token')
  }
})

test('edit dialog: slug is read-only text; the only inputs are name, address, phone and hours, with the backend ceilings', () => {
  const html = mod.renderEdit({ id: 1, kind: 'edit', phase: 'ready', businessId: ID_A, name: 'Brasa 47', slug: 'brasa-47', business: full(ID_A, { phone: '+56 9' }), error: null })
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby=/)
  assert.match(html, /Editar restaurante/)
  assert.match(html, /<code class="business-dialog__slug">brasa-47<\/code>/)
  assert.match(html, /No se puede modificar/)
  const inputs = [...html.matchAll(/<input [^>]*>/g)].map((m) => m[0])
  assert.equal(inputs.length, 4)
  assert.deepEqual(inputs.map((i) => Number(i.match(/maxLength="(\d+)"/)[1])), [120, 200, 40, 200])
  assert.match(html, /value="Brasa 47"/)
  assert.match(html, /value="\+56 9"/)
  assert.doesNotMatch(html, /name="(slug|active|id)"|type="checkbox"|type="file"|type="color"|logo|color/i)
  assert.match(html, /Guardar/)
})

test('edit dialog: loading, load error (retry only when it can help), saving disables everything', () => {
  assert.match(mod.renderEdit({ id: 1, kind: 'edit', phase: 'loading', name: 'X', slug: 'x', business: null, error: null }), /Cargando datos…/)
  const retry = mod.renderEdit({ id: 1, kind: 'edit', phase: 'load-error', name: 'X', slug: 'x', business: null, error: { kind: 'server', message: 'No se pudo completar la acción. Intenta nuevamente.' } })
  assert.match(retry, /role="alert"/)
  assert.match(retry, /Reintentar/)
  const gone = mod.renderEdit({ id: 1, kind: 'edit', phase: 'load-error', name: 'X', slug: 'x', business: null, error: { kind: 'not-found', message: 'Este restaurante ya no existe. Actualiza la lista.' } })
  assert.doesNotMatch(gone, /Reintentar/)
  const saving = mod.renderEdit({ id: 1, kind: 'edit', phase: 'saving', businessId: ID_A, name: 'X', slug: 'x', business: full(ID_A), error: null })
  assert.match(saving, /Guardando…/)
  assert.equal((saving.match(/<input [^>]*disabled/g) ?? []).length, 4)
  assert.match(saving, /<button[^>]*disabled[^>]*>Cancelar/)
  assert.match(saving, /<button type="submit"[^>]*disabled/)
})

test('edit dialog: field errors are tied to their input (aria-invalid / aria-describedby)', () => {
  const html = mod.renderEdit({ id: 1, kind: 'edit', phase: 'ready', businessId: ID_A, name: 'X', slug: 'x', business: full(ID_A), error: { kind: 'validation', message: 'Revisa los campos marcados.', fields: { name: 'El nombre es obligatorio.' } } })
  assert.match(html, /aria-invalid="true"/)
  assert.match(html, /aria-describedby="([^"]+)-error"/)
  assert.match(html, /<span id="[^"]+-name-error" class="business-dialog__field-error" role="alert">El nombre es obligatorio\.<\/span>/)
})

test('suspend dialog: serious confirmation — warnings, optional 200-char reason, explicit checkbox, no force', () => {
  const html = mod.renderSuspend({ id: 1, kind: 'suspend', phase: 'ready', businessId: ID_A, name: 'Casa Olivo', slug: 'casa-olivo', error: null })
  assert.match(html, /Suspender restaurante/)
  assert.match(html, /Casa Olivo/)
  assert.match(html, /Dejará de recibir nuevos pedidos/)
  assert.match(html, /sesiones de mesa abiertas se cerrarán/)
  assert.match(html, /datos, el menú, los pedidos y el historial se conservan/)
  assert.match(html, /Podrás reactivarlo/)
  assert.match(html, /Motivo \(opcional\)/)
  assert.match(html, /<textarea[^>]*maxLength="200"/)
  assert.match(html, /0\/200/)
  assert.match(html, /type="checkbox"/)
  assert.match(html, /<button type="submit" class="btn btn--danger btn--small" disabled="">Suspender restaurante/, 'the button is disabled until the checkbox is ticked')
  assert.doesNotMatch(html, /contraseña|password|forzar|force|acknowledge/i, 'no fake re-authentication and no forced suspension')
  assert.match(mod.renderSuspend({ id: 1, kind: 'suspend', phase: 'saving', businessId: ID_A, name: 'Casa Olivo', slug: 'c', error: null }), /Suspendiendo…/)
})

test('suspend dialog: with pending orders it becomes an explanation with the real count and only "Entendido"', () => {
  const html = mod.renderSuspend({ id: 1, kind: 'suspend', phase: 'blocked', businessId: ID_A, name: 'Casa Olivo', slug: 'c', pendingCount: 3, error: { kind: 'pending-orders', count: 3, message: 'Este restaurante tiene 3 pedidos pendientes. Resuélvelos (entrégalos o cancélalos) antes de suspenderlo.' } })
  assert.match(html, /No se puede suspender todavía/)
  assert.match(html, /3 pedidos pendientes/)
  assert.match(html, /Pedidos pendientes: 3/)
  assert.match(html, /Entendido/)
  assert.doesNotMatch(html, /Suspender restaurante|type="checkbox"|textarea|forzar/i)
})

test('activate dialog: explains access is recovered, data kept, previous table sessions NOT reopened', () => {
  const html = mod.renderActivate({ id: 1, kind: 'activate', phase: 'ready', businessId: ID_A, name: 'Casa Olivo', slug: 'c', error: null })
  assert.match(html, /Reactivar restaurante/)
  assert.match(html, /Se recupera el acceso del restaurante/)
  assert.match(html, /Los datos existentes se conservan/)
  assert.match(html, /sesiones de mesa anteriores no se reabren/)
  assert.match(html, /No se selecciona automáticamente/)
  assert.match(mod.renderActivate({ id: 1, kind: 'activate', phase: 'saving', businessId: ID_A, name: 'C', slug: 'c', error: null }), /Reactivando…/)
})

test('picker rows: management buttons per state, separate from the select button; none without the callbacks', () => {
  const st = (items) => ({ items, page: 1, total: items.length, totalPages: 1, hasMore: false, search: '', active: 'all', status: 'ready', loadingMore: false, error: null })
  const mgmt = { onEdit() {}, onSuspend() {}, onActivate() {} }
  const html = mod.renderPicker(st([item(ID_A, 'Alfa'), { ...item(ID_B, 'Beta'), active: false }]), mgmt)
  assert.match(html, /aria-label="Editar Alfa"/)
  assert.match(html, /aria-label="Suspender Alfa"/)
  assert.doesNotMatch(html, /aria-label="Reactivar Alfa"/)
  assert.match(html, /aria-label="Editar Beta"/)
  assert.match(html, /aria-label="Reactivar Beta"/)
  assert.doesNotMatch(html, /aria-label="Suspender Beta"/)
  assert.match(html, /<div class="business-card business-card--inactive" aria-disabled="true">/, 'a suspended business still cannot be entered')
  assert.equal((html.match(/aria-label="Administrar /g) ?? []).length, 1, 'only the active one can be selected')
  assert.match(html, />Suspendido</)
  // buttons are siblings of the select button, never nested inside it
  assert.doesNotMatch(html, /<button[^>]*class="business-card"[^>]*>(?:(?!<\/button>)[\s\S])*<button/)
  const plain = mod.renderPicker(st([item(ID_A, 'Alfa')]), null)
  assert.doesNotMatch(plain, /Editar|Suspender|Reactivar/)
})

// ======================================================================================================================
// suspended ADMIN (403 BUSINESS_INACTIVE): exact code only, one reaction, SUPER_ADMIN never logged out
// ======================================================================================================================
test('403 BUSINESS_INACTIVE calls the suspension handler; any other 403/401/5xx does not', async () => {
  let suspended = 0
  let unauthorized = 0
  mod.setBusinessInactiveHandler(() => suspended++)
  mod.setUnauthorizedHandler(() => unauthorized++)
  const realFetch = globalThis.fetch
  const respond = (status, body) => (globalThis.fetch = async () => ({ ok: false, status, json: async () => body }))
  try {
    respond(403, { errorCode: 'BUSINESS_INACTIVE', message: 'This business is suspended' })
    await assert.rejects(() => mod.apiFetch('/businesses/me', { token: 't' }), (e) => e.status === 403 && e.code === 'BUSINESS_INACTIVE')
    assert.equal(suspended, 1)
    for (const [status, body] of [[403, { errorCode: 'SOMETHING_ELSE' }], [403, { message: 'Forbidden' }], [403, null], [401, { errorCode: 'BUSINESS_INACTIVE' }], [404, { errorCode: 'BUSINESS_INACTIVE' }], [500, {}]]) {
      respond(status, body)
      await assert.rejects(() => mod.apiFetch('/x', { token: 't' }))
    }
    assert.equal(suspended, 1, 'only the exact status + errorCode counts as a suspension')
    assert.equal(unauthorized, 1, 'a 401 still logs out as before')
  } finally {
    globalThis.fetch = realFetch
    mod.setBusinessInactiveHandler(null)
    mod.setUnauthorizedHandler(null)
  }
})

test('messages: BUSINESS_INACTIVE shows the suspension sentence (login included); other 403s keep the generic one', () => {
  const SUSPENDED = 'Este restaurante se encuentra temporalmente suspendido. Contacta al administrador del servicio para obtener más información.'
  assert.equal(mod.translateApiError(new mod.ApiError(403, 'This business is suspended', { code: 'BUSINESS_INACTIVE' })), SUSPENDED)
  assert.equal(mod.translateApiError(new mod.ApiError(403, 'Forbidden')), 'No tienes permisos para realizar esta acción.')
  assert.equal(mod.translateApiError(new mod.ApiError(403, 'x', { code: 'SOMETHING_ELSE' })), 'No tienes permisos para realizar esta acción.')
  assert.equal(mod.translateApiError(new mod.ApiError(401, 'x')), 'Email o contraseña incorrectos.', 'a wrong password is still the generic 401')
})

test('suspension notice: login screen and AuthProvider are wired once, with the exact message', () => {
  const ctx = code(read('../../context/AuthContext.jsx'))
  assert.match(ctx, /const suspendedRef = useRef\(false\)/)
  assert.match(ctx, /reaction\.endSession && !suspendedRef\.current/, 'the reaction happens once however many requests get the 403')
  assert.match(ctx, /reactToBusinessInactive\(sessionRef\.current\?\.user, endsSessionOnSuspension\)/, 'a SUPER_ADMIN is not logged out by it (the rule is injected)')
  assert.match(ctx, /isBusinessInactiveResponse\(err\?\.status, err\?\.code\)/, 'GET /auth/me with the exact code explains why')
  assert.doesNotMatch(ctx, /tenant\//, 'AuthContext imports nothing from tenant/ (the rule is injected by the app root)')
  assert.match(code(read('../../App.jsx')), /<AuthProvider endsSessionOnSuspension=\{suspensionEndsSession\}>/)
  const login = code(read('../../pages/admin/AdminLogin.jsx'))
  assert.match(login, /suspended && !error/)
  assert.match(login, /SUSPENDED_MESSAGE/)
  const message = read('../../context/suspension.js')
  assert.match(message, /Este restaurante se encuentra temporalmente suspendido\. Contacta al administrador del servicio para obtener más información\./)
  assert.match(code(read('../../services/errorMessages.js')), /BUSINESS_INACTIVE: \(error\) => \(error\.suspensionScope === 'managed' \? MANAGED_SUSPENDED_MESSAGE : SUSPENDED_MESSAGE\)/)
  assert.match(code(read('../../services/api.js')), /isBusinessInactiveResponse\(res\.status, body\?\.errorCode\)/)
})

test('who loses the session on a suspension: every user but a SUPER_ADMIN', async () => {
  const core = await loadModule(`export { suspensionEndsSession } from './tenant/tenantCore.js'`)
  assert.equal(core.suspensionEndsSession({ role: 'ADMIN' }), true)
  assert.equal(core.suspensionEndsSession({ role: 'SUPER_ADMIN' }), false)
  assert.equal(core.suspensionEndsSession({ role: 'SUPER_ADMIN', businessId: ID_A }), false)
  assert.equal(core.suspensionEndsSession(null), false)
  assert.equal(core.suspensionEndsSession(undefined), false)
})

test('reaction to BUSINESS_INACTIVE: ADMIN loses the session; SUPER_ADMIN keeps it and gets the "managed" scope; no session = login attempt', () => {
  const react = (user) => mod.reactToBusinessInactive(user, mod.suspensionEndsSession)
  assert.deepEqual(react({ id: 'u1', role: 'ADMIN' }), { scope: 'own', endSession: true })
  assert.deepEqual(react({ id: 'u2', role: 'SUPER_ADMIN' }), { scope: 'managed', endSession: false })
  assert.deepEqual(react({ id: 'u2', role: 'SUPER_ADMIN', businessId: ID_A }), { scope: 'managed', endSession: false }, 'even with a business on their own row')
  assert.deepEqual(react(null), { scope: 'own', endSession: false }, 'a login attempt: the ADMIN message, there is no session to end')
  assert.deepEqual(react(undefined), { scope: 'own', endSession: false })
})

test('the message fits who reads it: SUPER_ADMIN gets an explanation about the restaurant, never the ADMIN "contacta al administrador" text', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({ errorCode: 'BUSINESS_INACTIVE', message: 'This business is suspended' }) })
  const messageFor = async (handler) => {
    mod.setBusinessInactiveHandler(handler)
    const error = await mod.apiFetch(`/tables/${ID_A}/sessions`, { token: 't', method: 'POST' }).catch((e) => e)
    return { error, message: mod.translateApiError(error) }
  }
  try {
    const managed = await messageFor(() => 'managed')
    assert.equal(managed.error.status, 403, 'it is still an ordinary 403 error for the caller')
    assert.equal(managed.error.suspensionScope, 'managed')
    assert.equal(managed.message, mod.MANAGED_SUSPENDED_MESSAGE)
    assert.match(managed.message, /Este restaurante está suspendido/)
    assert.match(managed.message, /Reactívalo desde la lista de negocios/)
    assert.doesNotMatch(managed.message, /Contacta al administrador/)

    const own = await messageFor(() => 'own')
    assert.equal(own.message, mod.SUSPENDED_MESSAGE)
    const noHandler = await messageFor(null) // e.g. the login screen: no session, nothing registered yet
    assert.equal(noHandler.error.suspensionScope, undefined)
    assert.equal(noHandler.message, mod.SUSPENDED_MESSAGE, 'a suspended ADMIN logging in keeps the ADMIN message')
  } finally {
    globalThis.fetch = realFetch
    mod.setBusinessInactiveHandler(null)
  }
})

test('other 403s are still the generic one and are never tagged as a suspension scope', async () => {
  let called = 0
  mod.setBusinessInactiveHandler(() => (called++, 'own'))
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({ errorCode: 'SOME_OTHER_CODE', message: 'Forbidden' }) })
  try {
    const error = await mod.apiFetch('/x', { token: 't' }).catch((e) => e)
    assert.equal(error.suspensionScope, undefined)
    assert.equal(mod.translateApiError(error), 'No tienes permisos para realizar esta acción.')
    assert.equal(called, 0)
  } finally {
    globalThis.fetch = realFetch
    mod.setBusinessInactiveHandler(null)
  }
})

test('AuthProvider: the session is dropped only when the reaction says so, and it hands the scope back to the API layer', () => {
  const ctx = code(read('../../context/AuthContext.jsx'))
  assert.match(ctx, /reactToBusinessInactive\(sessionRef\.current\?\.user, endsSessionOnSuspension\)/)
  assert.match(ctx, /if \(reaction\.endSession && !suspendedRef\.current\) \{[\s\S]*setSession\(null\)[\s\S]*\}\s*return reaction\.scope/)
  assert.doesNotMatch(ctx, /MANAGED_SUSPENDED_MESSAGE|SUPER_ADMIN/, 'no role or wording here')
})

// ======================================================================================================================
// isolation by source
// ======================================================================================================================
test('management code is SUPER_ADMIN-only by construction: reachable only through the selector gate', () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(new URL(`${e.name}/`, dir)) : [new URL(e.name, dir)]))
  const importers = walk(new URL('../../', import.meta.url))
    .filter((u) => /\.(js|jsx)$/.test(u.pathname) && !u.pathname.endsWith('.test.js'))
    .filter((u) => /management\/(BusinessManagementDialogs|businessManagementApi|managementStore)/.test(code(readFileSync(u, 'utf8'))))
    .map((u) => u.pathname.split('/src/')[1])
    .sort()
  assert.deepEqual(importers, ['tenant/selector/BusinessGate.jsx'])
  // an ADMIN never mounts the gate (8D.2b) and AdminPanel itself knows nothing about management
  assert.doesNotMatch(code(read('../../pages/admin/AdminPanel.jsx')), /management|Suspender|Reactivar/)
})

test('management code never reads roles, the Dev Tools preview, storage or the tenant scoping helpers', () => {
  for (const [name, source] of here) {
    assert.doesNotMatch(source, /devtools|useViewAs|viewAs|effectiveViewRole|ViewAs/, name)
    assert.doesNotMatch(source, /localStorage|sessionStorage/, `${name}: nothing is persisted`)
    assert.doesNotMatch(source, /user\??\.role|SUPER_ADMIN|'ADMIN'|\.role ===/, `${name}: role decisions live in tenant/tenantCore.js only`)
    assert.doesNotMatch(source, /scopePath|scopeBody|useActiveBusiness|setActiveBusiness|confirmActiveBusiness/, `${name}: the target is the id, never the active-business context`)
    assert.doesNotMatch(source, /Authorization|accessToken|jwt|setSession|logout|login\(/i, `${name}: no JWT / AuthContext handling`)
    assert.doesNotMatch(source, /acknowledgePendingOrders|force:|forzar|contraseña|password/i, `${name}: no forced suspension, no fake re-authentication`)
  }
})

test('the gate wires the management events to the selection: suspend drops it, edit refreshes it, reactivate never selects', () => {
  const gate = code(read('../selector/BusinessGate.jsx'))
  assert.match(gate, /event\.type === 'deactivated'[\s\S]*if \(isSelected\) \{[\s\S]*drop\(\)/, 'suspending the chosen restaurant clears the selection -> its panels unmount')
  assert.match(gate, /event\.type === 'updated'[\s\S]*if \(isSelected\) validator\.refresh\(event\.business\)/)
  const activated = gate.match(/event\.type === 'activated'[\s\S]*?\} else if/)[0]
  assert.doesNotMatch(activated, /setActiveBusiness|confirmActiveBusiness|drop\(\)/, 'reactivation never selects the restaurant')
  assert.match(gate, /latest\.current/, 'the selection is read when the answer arrives, not from a stale closure')
})
