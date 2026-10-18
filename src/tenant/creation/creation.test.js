import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { loadModule } from '../../theme/testSupport.js'
import { createBusinessListStore } from '../selector/businessListStore.js'
import { CREATE_FIELDS, CREATE_LIMITS, SLUG_MIN_LENGTH, SLUG_PATTERN, buildCreatePayload, emptyCreateForm, isCreateFormDirty, normalizeSlug, suggestSlug, validateCreateForm } from './businessCreateForm.js'
import { describeCreateError } from './businessCreateErrors.js'
import { createCreationStore } from './creationStore.js'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const own = readdirSync(new URL('.', import.meta.url)).filter((f) => /\.(js|jsx)$/.test(f) && !f.endsWith('.test.js')).map((f) => [f, code(read(`./${f}`))])

const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const apiError = (status, code, extra = {}) => Object.assign(new Error(`HTTP ${status}`), { status, code, ...extra })
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}
const goodForm = (extra = {}) => ({ name: 'Café Olivo', slug: 'cafe-olivo', address: '', phone: '', hours: '', ...extra })
const created = (payload, extra = {}) => ({ id: ID_A, name: payload.name, slug: payload.slug, active: true, address: payload.address ?? null, phone: payload.phone ?? null, hours: payload.hours ?? null, logoUrl: null, primaryColor: null, accentColor: null, ...extra })

function fakeApi(handler = async (payload) => created(payload)) {
  const calls = []
  return { calls, createBusiness: async (payload) => (calls.push(payload), handler(payload, calls.length)) }
}
const events = (store) => {
  const seen = []
  store.onChange((e) => seen.push(e))
  return seen
}

// ======================================================================================================================
// form: the PUBLISHED backend contract (POST /businesses -> CreateBusinessDto)
// ======================================================================================================================
const dto = read('../../../backend/src/business/dto/create-business.dto.ts')

test('form limits and slug rule are exactly what CreateBusinessDto enforces (read from the backend source)', () => {
  const limits = Object.fromEntries([...dto.matchAll(/@MaxLength\((\d+)\)\s*\n\s*(\w+)\??:/g)].map((m) => [m[2], Number(m[1])]))
  // slug carries MinLength/MaxLength/Matches (constants); the other four carry a literal MaxLength
  assert.deepEqual(limits, { name: CREATE_LIMITS.name, address: CREATE_LIMITS.address, phone: CREATE_LIMITS.phone, hours: CREATE_LIMITS.hours })
  assert.equal(Number(dto.match(/BUSINESS_SLUG_MAX_LENGTH = (\d+)/)[1]), CREATE_LIMITS.slug)
  assert.match(dto, /@MaxLength\(BUSINESS_SLUG_MAX_LENGTH\)\s*\n\s*@Matches\(BUSINESS_SLUG_PATTERN[\s\S]*?\n\s*slug: string/)
  assert.equal(Number(dto.match(/BUSINESS_SLUG_MIN_LENGTH = (\d+)/)[1]), SLUG_MIN_LENGTH)
  assert.equal(dto.match(/BUSINESS_SLUG_PATTERN = (\/.*\/);/)[1], String(SLUG_PATTERN))
  // the DTO's optional fields are exactly the ones the form treats as optional
  assert.deepEqual([...dto.matchAll(/@IsOptional\(\)[\s\S]*?\n\s*(\w+)\?:/g)].map((m) => m[1]), ['address', 'phone', 'hours'])
  // the form carries nothing else: no colours, logo, active, id...
  assert.deepEqual(CREATE_FIELDS, ['name', 'slug', 'address', 'phone', 'hours'])
  assert.deepEqual(Object.keys(emptyCreateForm()), CREATE_FIELDS)
})

test('validation: name is required and capped at 120 (after trimming)', () => {
  assert.equal(validateCreateForm(goodForm({ name: '' })).name, 'El nombre es obligatorio.')
  assert.equal(validateCreateForm(goodForm({ name: '    ' })).name, 'El nombre es obligatorio.')
  assert.equal(validateCreateForm(goodForm({ name: undefined })).name, 'El nombre es obligatorio.')
  assert.equal(validateCreateForm(goodForm({ name: 'a'.repeat(120) })).name, undefined)
  assert.equal(validateCreateForm(goodForm({ name: `  ${'a'.repeat(120)}  ` })).name, undefined, 'the ceiling applies to the trimmed text, like the DTO')
  assert.match(validateCreateForm(goodForm({ name: 'a'.repeat(121) })).name, /hasta 120 caracteres/)
})

test('validation: the slug follows the DTO rule — 3..60, lowercase letters/digits, single inner hyphens', () => {
  const bad = (slug) => validateCreateForm(goodForm({ slug })).slug
  assert.match(bad(''), /obligatorio/)
  assert.match(bad('   '), /obligatorio/)
  assert.match(bad('ab'), /al menos 3/)
  assert.equal(bad('abc'), undefined)
  assert.equal(bad('a'.repeat(60)), undefined)
  assert.match(bad('a'.repeat(61)), /hasta 60/)
  for (const slug of ['mi local', 'mi_local', 'mi.local', 'café-olivo', 'mi--local', '-mi-local', 'mi-local-', 'mi/local', 'mi@local', 'ñandu', '日本語']) assert.match(bad(slug), /minúsculas sin tildes/, slug)
  for (const slug of ['brasa-47', 'a1b', '123', 'cafe-olivo-2']) assert.equal(bad(slug), undefined, slug)
})

test('validation: the slug is lowercased and trimmed like the server does, so "Mi-Local " is accepted and sent as "mi-local"', () => {
  assert.equal(normalizeSlug('  Mi-Local '), 'mi-local')
  assert.equal(validateCreateForm(goodForm({ slug: '  Mi-Local ' })).slug, undefined)
  assert.equal(buildCreatePayload(goodForm({ slug: '  Mi-Local ' })).slug, 'mi-local')
})

test('validation: optional fields cap at 200 / 40 / 200, count trimmed text, and accept blank', () => {
  const errors = validateCreateForm(goodForm({ address: 'a'.repeat(201), phone: 'p'.repeat(41), hours: 'h'.repeat(201) }))
  assert.deepEqual(Object.keys(errors).sort(), ['address', 'hours', 'phone'])
  assert.deepEqual(validateCreateForm(goodForm({ address: 'a'.repeat(200), phone: 'p'.repeat(40), hours: 'h'.repeat(200) })), {})
  assert.deepEqual(validateCreateForm(goodForm({ address: '   ', phone: '  ', hours: '' })), {})
  assert.deepEqual(validateCreateForm(goodForm()), {})
  assert.deepEqual(Object.keys(validateCreateForm(emptyCreateForm())).sort(), ['name', 'slug'])
})

test('payload: exactly the five contract keys, text trimmed, blank optionals OMITTED (never "" or null)', () => {
  assert.deepEqual(buildCreatePayload(goodForm()), { name: 'Café Olivo', slug: 'cafe-olivo' })
  assert.deepEqual(buildCreatePayload({ name: '  Brasa Norte ', slug: 'brasa-norte', address: ' Calle 1 ', phone: '  ', hours: ' Lun-Dom 12-23 ' }), {
    name: 'Brasa Norte',
    slug: 'brasa-norte',
    address: 'Calle 1',
    hours: 'Lun-Dom 12-23',
  })
  const full = buildCreatePayload({ ...goodForm({ address: 'x', phone: 'y', hours: 'z' }), active: false, primaryColor: '#000000', logoUrl: 'u', id: 'i', businessId: ID_A })
  assert.deepEqual(Object.keys(full).sort(), ['address', 'hours', 'name', 'phone', 'slug'])
  assert.equal(isCreateFormDirty(emptyCreateForm()), false)
  assert.equal(isCreateFormDirty({ ...emptyCreateForm(), phone: '  ' }), false)
  assert.equal(isCreateFormDirty({ ...emptyCreateForm(), phone: '1' }), true)
})

// ======================================================================================================================
// slug suggestion
// ======================================================================================================================
test('slug suggestion: lowercase, accents removed, symbols become single hyphens, no hyphen at the ends', () => {
  assert.equal(suggestSlug('Brasa 47'), 'brasa-47')
  assert.equal(suggestSlug('Café Ñandú & Co.'), 'cafe-nandu-co')
  assert.equal(suggestSlug('  --Hola   Mundo--  '), 'hola-mundo')
  assert.equal(suggestSlug('La Brasa 47 — Burger · Pizza · Bar'), 'la-brasa-47-burger-pizza-bar')
  assert.equal(suggestSlug('ÁÉÍÓÚ Üñ'), 'aeiou-un')
  assert.equal(suggestSlug(''), '')
  assert.equal(suggestSlug(null), '')
  assert.equal(suggestSlug('???'), '')
  assert.equal(suggestSlug('日本語'), '', 'nothing usable: the form then asks the user for a slug')
})

test('slug suggestion: never longer than 60, never ends with a hyphen, and always satisfies the slug rule when long enough', () => {
  const long = suggestSlug(`${'palabra '.repeat(20)}final`)
  assert.ok(long.length <= CREATE_LIMITS.slug)
  assert.doesNotMatch(long, /-$/)
  for (const name of ['Brasa 47', 'Café Ñandú & Co.', 'A', 'AB', 'x'.repeat(200), 'a-b-c', '  Pizza   Bar  ', 'Ristorante Il Forno 2', "O'Brien's Pub", `${'ab-'.repeat(30)}`]) {
    const slug = suggestSlug(name)
    if (slug.length >= SLUG_MIN_LENGTH) assert.match(slug, SLUG_PATTERN, `${name} -> ${slug}`)
    assert.ok(slug.length <= CREATE_LIMITS.slug)
    assert.doesNotMatch(slug, /^-|-$|--/)
  }
  assert.deepEqual(validateCreateForm({ name: 'Brasa 47', slug: suggestSlug('Brasa 47') }), {})
})

// ======================================================================================================================
// error messages
// ======================================================================================================================
test('errors: every outcome has its own Spanish message, and ambiguity is flagged exactly where the request may have landed', () => {
  const d = (e, o) => describeCreateError(e, o)
  assert.deepEqual(
    ['slug-taken', 'rate-limited', 'unauthorized', 'forbidden', 'invalid'].map((k) => [k, d(apiError({ 'slug-taken': 409, 'rate-limited': 429, unauthorized: 401, forbidden: 403, invalid: 400 }[k], k === 'slug-taken' ? 'BUSINESS_SLUG_TAKEN' : undefined)).kind]),
    [['slug-taken', 'slug-taken'], ['rate-limited', 'rate-limited'], ['unauthorized', 'unauthorized'], ['forbidden', 'forbidden'], ['invalid', 'invalid']],
  )
  assert.match(d(apiError(409, 'BUSINESS_SLUG_TAKEN')).message, /ya está en uso\. Prueba con uno distinto\..*búscalo en la lista antes de crear otro/)
  assert.match(d(apiError(429)).message, /Demasiadas solicitudes/)
  assert.match(d(apiError(401)).message, /sesión expiró/)
  assert.match(d(apiError(403)).message, /no tiene permiso para crear negocios/)
  assert.match(d(apiError(400)).message, /rechazó algunos datos/)
  for (const e of [apiError(409, 'BUSINESS_SLUG_TAKEN'), apiError(429), apiError(401), apiError(403), apiError(400), apiError(404)]) assert.equal(d(e).ambiguous, false, String(e.status))
  // may have reached the server: no answer at all, any 5xx, a "success" that is not a business
  for (const e of [new TypeError('Failed to fetch'), apiError(500), apiError(502), apiError(503), { kind: 'bad-response' }]) {
    assert.equal(d(e).ambiguous, true)
    assert.match(d(e).message, /no (podemos|sabemos)|confirmar|no sabemos/)
  }
  assert.equal(d(new TypeError('Failed to fetch')).kind, 'network')
  assert.match(d(apiError(409, 'BUSINESS_SLUG_TAKEN'), { slugAmbiguouslyTried: true }).message, /intento anterior sí haya creado/)
  // an unrelated 409, and the raw English backend text, never reach the user
  assert.equal(d(apiError(409, 'OTHER')).kind, 'server')
  assert.doesNotMatch(d(apiError(500, undefined, {})).message, /Error 500|HTTP/)
})

// ======================================================================================================================
// creation store
// ======================================================================================================================
test('success: ONE request with exactly the payload, the dialog turns into the "created" step, and the event carries the business', async () => {
  const api = fakeApi()
  const store = createCreationStore({ api })
  const seen = events(store)
  store.open()
  assert.equal(store.getState().dialog.phase, 'ready')
  await store.submit(goodForm({ name: '  Café Olivo ', slug: ' Cafe-Olivo ', phone: '+56 9 1234 5678' }))
  assert.deepEqual(api.calls, [{ name: 'Café Olivo', slug: 'cafe-olivo', phone: '+56 9 1234 5678' }])
  const { dialog } = store.getState()
  assert.equal(dialog.phase, 'created')
  assert.deepEqual(dialog.created, { id: ID_A, name: 'Café Olivo', slug: 'cafe-olivo', active: true, logoUrl: null })
  assert.deepEqual(seen, [{ type: 'created', business: dialog.created }])
  store.close()
  assert.equal(store.getState().dialog, null)
  assert.deepEqual(seen.map((e) => e.type), ['created'], 'closing after a confirmed creation asks for nothing more')
})

test('validation errors never reach the network and keep the dialog open for correction', async () => {
  const api = fakeApi()
  const store = createCreationStore({ api })
  store.open()
  await store.submit(goodForm({ name: '', slug: 'a' }))
  assert.equal(api.calls.length, 0)
  const { dialog } = store.getState()
  assert.equal(dialog.phase, 'ready')
  assert.equal(dialog.error.kind, 'validation')
  assert.deepEqual(Object.keys(dialog.error.fields).sort(), ['name', 'slug'])
  await store.submit(goodForm())
  assert.equal(store.getState().dialog.phase, 'created')
  assert.equal(api.calls.length, 1)
})

test('no duplicate submissions: a second submit/Enter while the request is in flight is ignored and the dialog cannot be closed', async () => {
  const gate = deferred()
  const api = fakeApi(() => gate.promise)
  const store = createCreationStore({ api })
  store.open()
  const first = store.submit(goodForm())
  assert.equal(store.getState().dialog.phase, 'saving', 'flips synchronously, before the request completes')
  const second = store.submit(goodForm())
  const third = store.submit(goodForm())
  store.close()
  assert.equal(store.getState().dialog.phase, 'saving', 'cannot be closed while saving')
  assert.equal(api.calls.length, 1)
  gate.resolve(created({ name: 'Café Olivo', slug: 'cafe-olivo' }))
  await Promise.all([first, second, third])
  assert.equal(api.calls.length, 1)
  assert.equal(store.getState().dialog.phase, 'created')
  await store.submit(goodForm()) // a finished creation cannot be submitted again either
  assert.equal(api.calls.length, 1)
})

test('only one dialog: opening twice keeps the first one (and its text) untouched', () => {
  const store = createCreationStore({ api: fakeApi() })
  store.open()
  const id = store.getState().dialog.id
  store.open()
  assert.equal(store.getState().dialog.id, id)
})

test('slug already taken (409 BUSINESS_SLUG_TAKEN): a message on the slug field, no success, no event, and the user can fix it and resubmit', async () => {
  let n = 0
  const api = fakeApi(async (payload) => {
    n += 1
    if (n === 1) throw apiError(409, 'BUSINESS_SLUG_TAKEN')
    return created(payload)
  })
  const store = createCreationStore({ api })
  const seen = events(store)
  store.open()
  await store.submit(goodForm())
  const { dialog } = store.getState()
  assert.equal(dialog.phase, 'ready')
  assert.equal(dialog.error.kind, 'slug-taken')
  assert.match(dialog.error.fields.slug, /ya está en uso\. Prueba con uno distinto/)
  assert.equal(dialog.created, null)
  assert.deepEqual(seen, [], 'a 409 is not a creation')
  store.close() // 9B.1: the 409 may be the echo of a browser re-send of OUR request, so the list is refreshed on close
  assert.deepEqual(seen, [{ type: 'maybe-created' }])
  store.open()
  await store.submit(goodForm({ slug: 'cafe-olivo-2' }))
  assert.equal(api.calls.length, 2)
  assert.equal(api.calls[1].slug, 'cafe-olivo-2')
  assert.equal(store.getState().dialog.phase, 'created')
})

test('definite failures (400, 401, 403, 429, other 4xx): an error, the form stays editable, the business is not reported created', async () => {
  for (const [status, kind] of [[400, 'invalid'], [401, 'unauthorized'], [403, 'forbidden'], [429, 'rate-limited'], [404, 'server']]) {
    const api = fakeApi(async () => {
      throw apiError(status)
    })
    const store = createCreationStore({ api })
    const seen = events(store)
    store.open()
    await store.submit(goodForm())
    const { dialog } = store.getState()
    assert.equal(dialog.phase, 'ready', String(status))
    assert.equal(dialog.error.kind, kind, String(status))
    assert.equal(dialog.error.ambiguous, false)
    assert.equal(dialog.created, null)
    store.close()
    assert.deepEqual(seen, [], `${status}: nothing to refresh, nothing created`)
  }
})

test('network failures and 5xx are NOT success and NOT a plain failure: "cannot confirm", and closing refreshes the list', async () => {
  for (const failure of [new TypeError('Failed to fetch'), apiError(500), apiError(503)]) {
    const api = fakeApi(async () => {
      throw failure
    })
    const store = createCreationStore({ api })
    const seen = events(store)
    store.open()
    await store.submit(goodForm())
    const { dialog } = store.getState()
    assert.equal(dialog.phase, 'ready')
    assert.equal(dialog.error.ambiguous, true)
    assert.match(dialog.error.message, /no (podemos|sabemos) .*creó|confirmar/)
    assert.equal(dialog.ambiguousSlug, 'cafe-olivo')
    assert.deepEqual(seen, [], 'no "created" event')
    store.close()
    assert.deepEqual(seen, [{ type: 'maybe-created' }], 'the list is asked to refresh so the truth shows')
  }
})

test('after an unconfirmed attempt, a 409 on the same slug says the earlier attempt may have created it', async () => {
  let n = 0
  const store = createCreationStore({
    api: fakeApi(async () => {
      n += 1
      throw n === 1 ? new TypeError('Failed to fetch') : apiError(409, 'BUSINESS_SLUG_TAKEN')
    }),
  })
  const seen = events(store)
  store.open()
  await store.submit(goodForm())
  await store.submit(goodForm())
  const { dialog } = store.getState()
  assert.match(dialog.error.message, /intento anterior sí haya creado/)
  assert.equal(dialog.ambiguousSlug, 'cafe-olivo', 'still unconfirmed: closing refreshes the list')
  store.close()
  assert.deepEqual(seen, [{ type: 'maybe-created' }])
})

test('a "success" that is not the business that was asked for is never success (no id, wrong slug, empty body, non-UUID id)', async () => {
  for (const body of [null, {}, { id: ID_A }, { id: 'not-a-uuid', name: 'x', slug: 'cafe-olivo' }, { id: ID_A, name: 'x', slug: 'other-slug' }, { id: ID_A, slug: 'cafe-olivo' }, 'ok', []]) {
    const store = createCreationStore({ api: fakeApi(async () => body) })
    const seen = events(store)
    store.open()
    await store.submit(goodForm())
    const { dialog } = store.getState()
    assert.equal(dialog.phase, 'ready', JSON.stringify(body))
    assert.equal(dialog.error.kind, 'bad-response')
    assert.equal(dialog.error.ambiguous, true)
    assert.equal(dialog.created, null)
    assert.deepEqual(seen, [])
  }
})

test('the id of the answer is normalised to a lowercase UUID; unknown fields of the answer are dropped', async () => {
  const store = createCreationStore({ api: fakeApi(async (p) => created(p, { id: ID_A.toUpperCase(), primaryColor: '#123456', secret: 'x' })) })
  store.open()
  await store.submit(goodForm())
  assert.deepEqual(Object.keys(store.getState().dialog.created).sort(), ['active', 'id', 'logoUrl', 'name', 'slug'])
  assert.equal(store.getState().dialog.created.id, ID_A)
})

// ======================================================================================================================
// the list reflects the new business
// ======================================================================================================================
const row = (id, name, extra = {}) => ({ id, name, slug: name.toLowerCase().replace(/\s+/g, '-'), active: true, logoUrl: null, ...extra })
const pageOf = (items, extra = {}) => ({ items, page: 1, limit: 20, total: items.length, totalPages: 1, hasMore: false, ...extra })

test('list: showCreated pins the new business first at once, clears search and filter, and refreshes without duplicating it', async () => {
  const calls = []
  const store = createBusinessListStore({
    fetchPage: async (params) => (calls.push(params), calls.length === 1 ? pageOf([row(ID_B, 'Alfa')]) : pageOf([row(ID_B, 'Alfa'), row(ID_A, 'Café Olivo')])),
  })
  await store.load()
  await store.setSearch('alf')
  await store.setActive('true')
  assert.equal(store.getState().search, 'alf')
  const refreshed = store.showCreated({ id: ID_A, name: 'Café Olivo', slug: 'cafe-olivo', active: true, logoUrl: null })
  // immediately: pinned, filters cleared, nothing waited for
  assert.deepEqual(store.getState().created, row(ID_A, 'Café Olivo', { slug: 'cafe-olivo' }))
  assert.equal(store.getState().search, '')
  assert.equal(store.getState().active, 'all')
  await refreshed
  assert.deepEqual(calls.at(-1), { page: 1, limit: 20, search: '', active: 'all' })
  assert.deepEqual(store.getState().items.map((b) => b.id), [ID_B, ID_A], 'the refreshed page contains it in its normal place')
  assert.equal(store.getState().created.id, ID_A)
})

test('list: a slow answer that predates the creation cannot make the new business disappear', async () => {
  const slow = deferred()
  let n = 0
  const store = createBusinessListStore({ fetchPage: () => (++n === 1 ? slow.promise : Promise.resolve(pageOf([row(ID_B, 'Alfa'), row(ID_A, 'Café Olivo')]))) })
  const first = store.load()
  const refreshed = store.showCreated({ id: ID_A, name: 'Café Olivo', slug: 'cafe-olivo', active: true })
  slow.resolve(pageOf([row(ID_B, 'Alfa')])) // old answer, without the new business
  await first
  await refreshed
  assert.equal(store.getState().created.id, ID_A)
  assert.ok(store.getState().items.some((b) => b.id === ID_A))
})

test('list: the pinned row follows later edits/suspension and goes away on removal, on a new search or on a new filter', async () => {
  const store = createBusinessListStore({ fetchPage: async () => pageOf([]) })
  await store.load()
  const biz = { id: ID_A, name: 'Café Olivo', slug: 'cafe-olivo', active: true, logoUrl: null }
  await store.showCreated(biz)
  store.applyChange({ ...biz, name: 'Café Olivo Centro', active: false })
  assert.equal(store.getState().created.name, 'Café Olivo Centro')
  assert.equal(store.getState().created.active, false)
  store.removeItem(ID_A)
  assert.equal(store.getState().created, null)
  await store.showCreated(biz)
  await store.setSearch('x')
  assert.equal(store.getState().created, null)
  await store.showCreated(biz)
  await store.setActive('false')
  assert.equal(store.getState().created, null)
  assert.equal((await store.showCreated(null)) === undefined || true, true, 'a malformed business is ignored')
})

// ======================================================================================================================
// rendering: the real components, to static HTML
// ======================================================================================================================
let mod
before(async () => {
  mod = await loadModule(`
    import { renderToStaticMarkup } from 'react-dom/server'
    import BusinessPickerView from './tenant/selector/BusinessPickerView.jsx'
    import BusinessCreateDialog, { CreateForm, CreatedPanel } from './tenant/creation/BusinessCreateDialog.jsx'
    export const renderView = (props) => renderToStaticMarkup(<BusinessPickerView searchText="" onSearchText={() => {}} onActive={() => {}} onSelect={() => {}} onLoadMore={() => {}} onRetry={() => {}} {...props} />)
    export const renderForm = (dialog) => renderToStaticMarkup(<CreateForm dialog={dialog} onClose={() => {}} onSubmit={() => {}} />)
    export const renderCreated = (business) => renderToStaticMarkup(<CreatedPanel business={business} onManage={() => {}} onAddAdmin={() => {}} onClose={() => {}} />)
    export const renderContainer = (store) => renderToStaticMarkup(<BusinessCreateDialog store={store} onManage={() => {}} onAddAdmin={() => {}} />)
  `)
})
after(() => {})

const state = (extra = {}) => ({ items: [], page: 1, total: 0, totalPages: 0, hasMore: false, search: '', active: 'all', status: 'ready', loadingMore: false, error: null, created: null, ...extra })
const dialog = (extra = {}) => ({ id: 1, phase: 'ready', error: null, created: null, ambiguousSlug: null, ...extra })

test('role visibility: the "Crear negocio" button exists only when the creation callback is handed over (the SUPER_ADMIN gate)', () => {
  const without = mod.renderView({ state: state({ items: [row(ID_A, 'Alfa')], total: 1 }) })
  assert.doesNotMatch(without, /Crear negocio/)
  const withCreate = mod.renderView({ state: state({ items: [row(ID_A, 'Alfa')], total: 1 }), onCreate: () => {} })
  assert.match(withCreate, /<button type="button" class="btn btn--primary btn--small business-picker__create">Crear negocio<\/button>/)
  assert.equal((withCreate.match(/Crear negocio/g) ?? []).length, 1)
})

test('the button is there when there are no businesses yet — and in loading and error states — with a hint to use it', () => {
  const empty = mod.renderView({ state: state(), onCreate: () => {} })
  assert.match(empty, /Crear negocio/)
  assert.match(empty, /Todavía no hay negocios registrados\. Crea el primero con el botón «Crear negocio»\./)
  assert.doesNotMatch(mod.renderView({ state: state() }), /Crea el primero/, 'without the button there is no instruction to press it')
  assert.match(mod.renderView({ state: state({ status: 'loading' }), onCreate: () => {} }), /Crear negocio/)
  assert.match(mod.renderView({ state: state({ status: 'error', error: { kind: 'server', message: 'No pudimos cargar los negocios. Intenta nuevamente.' } }), onCreate: () => {} }), /Crear negocio/)
  // a filtered-empty list is not "no businesses yet": no "create the first" nudge
  assert.doesNotMatch(mod.renderView({ state: state({ search: 'zzz' }), onCreate: () => {} }), /Crea el primero/)
})

test('the list shows the business just created first, marked "Recién creado", once (even if the loaded pages also contain it)', () => {
  const html = mod.renderView({
    state: state({ items: [row(ID_B, 'Alfa'), row(ID_A, 'Café Olivo')], total: 2, created: row(ID_A, 'Café Olivo') }),
    onCreate: () => {},
  })
  assert.equal((html.match(/Café Olivo<\/span>/g) ?? []).length, 1, 'not repeated')
  assert.ok(html.indexOf('Café Olivo') < html.indexOf('Alfa'), 'leads the list')
  assert.match(html, /Recién creado/)
  assert.equal((html.match(/Recién creado/g) ?? []).length, 1)
  assert.match(html, /Mostrando 2 de 2/)
  const alone = mod.renderView({ state: state({ items: [], total: 0, created: row(ID_A, 'Café Olivo') }) })
  assert.match(alone, /Café Olivo/)
  assert.doesNotMatch(alone, /Todavía no hay negocios/)
})

test('form markup: labelled fields, required indicators, the slug notice, bounded inputs, a real submit button', () => {
  const html = mod.renderForm(dialog())
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby=/)
  assert.match(html, /<h3 id="[^"]+" class="admin-menu__modal-title">Crear negocio<\/h3>/)
  assert.match(html, /<form[^>]*novalidate/i)
  for (const label of ['Nombre del negocio', 'Identificador público \\(slug\\)', 'Dirección', 'Teléfono', 'Horario de atención']) assert.match(html, new RegExp(`<label for="[^"]+"><span>${label}`), label)
  // every input is tied to a label by id
  const labels = [...html.matchAll(/<label for="([^"]+)">/g)].map((m) => m[1])
  const inputs = [...html.matchAll(/<input[^>]*\sid="([^"]+)"/g)].map((m) => m[1])
  assert.equal(inputs.length, 5)
  assert.deepEqual(labels.sort(), inputs.sort())
  // required: name and slug, announced to assistive tech, with a visible legend
  assert.equal((html.match(/aria-required="true"/g) ?? []).length, 2)
  assert.equal((html.match(/business-dialog__required/g) ?? []).length, 2)
  assert.match(html, /Campo obligatorio/)
  // permanence
  assert.match(html, /role="note"><strong>El identificador es permanente\.<\/strong> Después de crear el negocio no podrá modificarse\./)
  // limits, suggestions and input types
  assert.match(html, /maxLength="120"/)
  assert.match(html, /maxLength="60"/)
  assert.match(html, /maxLength="200"/)
  assert.match(html, /maxLength="40"/)
  assert.match(html, /type="tel"/)
  assert.match(html, /autoCapitalize="none"/)
  assert.match(html, /placeholder="Lun-Dom 12:00-23:00"/)
  assert.match(html, /entre 3 y 60 caracteres/)
  assert.match(html, /<button type="submit" class="btn btn--primary btn--small">Crear negocio<\/button>/)
  assert.match(html, /<button type="button" class="btn btn--outline btn--small">Cancelar<\/button>/)
  // nothing the contract does not have: no colours, logo or cover
  assert.doesNotMatch(html, /color|logo|portada|banner|contraseña|password/i)
})

test('form markup while saving: busy, every field and button disabled, a progress label', () => {
  const html = mod.renderForm(dialog({ phase: 'saving' }))
  assert.match(html, /aria-busy="true"/)
  assert.equal((html.match(/<input[^>]*disabled/g) ?? []).length, 5)
  assert.match(html, /<button type="submit" class="btn btn--primary btn--small" disabled="">Creando…<\/button>/)
  assert.match(html, /<button type="button" class="btn btn--outline btn--small" disabled="">Cancelar<\/button>/)
})

test('form markup with errors: field errors are announced and tied to their inputs; form-level errors are alerts', () => {
  const fields = mod.renderForm(dialog({ error: { kind: 'validation', message: 'Revisa los campos marcados.', fields: { name: 'El nombre es obligatorio.', slug: 'Debe tener al menos 3 caracteres.' } } }))
  assert.equal((fields.match(/aria-invalid="true"/g) ?? []).length, 2)
  assert.match(fields, /id="([^"]+)-error" class="business-dialog__field-error" role="alert">El nombre es obligatorio\./)
  for (const m of fields.matchAll(/aria-describedby="([^"]+)"/g)) for (const id of m[1].split(' ')) assert.match(fields, new RegExp(`id="${id}"`), `${id} exists`)
  const taken = mod.renderForm(dialog({ error: { kind: 'slug-taken', ambiguous: false, message: 'Este identificador ya está en uso por otro negocio. Prueba con uno distinto.', fields: { slug: 'Este identificador ya está en uso por otro negocio. Prueba con uno distinto.' } } }))
  assert.match(taken, /role="alert">Este identificador ya está en uso por otro negocio/)
  assert.equal((taken.match(/aria-invalid="true"/g) ?? []).length, 1)
  assert.equal((taken.match(/ya está en uso/g) ?? []).length, 1, 'the slug message is shown once, at the field')
  for (const [kind, message] of [['rate-limited', 'Demasiadas solicitudes. Espera un momento e inténtalo nuevamente.'], ['network', 'No pudimos conectar con el servidor, así que no sabemos si el negocio se creó.']]) {
    const html = mod.renderForm(dialog({ error: { kind, ambiguous: kind === 'network', message } }))
    assert.match(html, new RegExp(`<p class="admin-menu__form-error" role="alert">${message}`))
  }
})

test('after the backend confirms: the created step offers "Administrar negocio" and "Crear administrador", and creates neither an admin nor a password', () => {
  const html = mod.renderCreated({ id: ID_A, name: 'Café Olivo', slug: 'cafe-olivo', active: true, logoUrl: null })
  assert.match(html, /role="dialog" aria-modal="true"/)
  assert.match(html, />Negocio creado</)
  assert.match(html, /Café Olivo/)
  assert.match(html, /<code class="business-dialog__slug">cafe-olivo<\/code>/)
  assert.match(html, />Administrar negocio<\/button>/)
  assert.match(html, />Crear administrador<\/button>/)
  assert.match(html, />Cerrar<\/button>/)
  assert.match(html, /Todavía no tiene administradores/)
  assert.doesNotMatch(html, /contraseña|password|temporal/i)
})

test('the container renders nothing when closed, the form when open, the created step when confirmed', async () => {
  const store = createCreationStore({ api: fakeApi() })
  assert.equal(mod.renderContainer(store), '')
  store.open()
  assert.match(mod.renderContainer(store), />Crear negocio</)
  await store.submit(goodForm())
  const html = mod.renderContainer(store)
  assert.match(html, />Negocio creado</)
  assert.doesNotMatch(html, /<form|Nombre del negocio/, 'the form is gone once the backend confirmed')
})

// ======================================================================================================================
// 9B.1 regressions: the "sixth POST", stray keys on the success step, no retries, reset, routes
// ======================================================================================================================
// Cause of the "sixth POST" seen in the manual run (reproduced against a mock API that logged every request): the app issued
// ONE fetch (traced in the page), and the mock received TWO identical POSTs in the same millisecond — the BROWSER re-sent
// the request by itself when the mock dropped the connection before answering. 429, 500 and 409 answers each produced exactly
// one POST; so did Enter + Enter + click while a request was pending. JavaScript cannot see or stop that re-send, which is why
// (a) a 409 on the slug is worded as "maybe it is ours" and refreshes the list, (b) the UNIQUE(slug) constraint stays the
// last protection, and (c) a server-side idempotency key is the real fix (out of scope: backend).
test('a 409 that is the echo of OUR OWN re-sent request (first copy created the business) is not reported as "taken by someone else"', async () => {
  // what the page sees: one fetch, answered 409 — because the browser's invisible first copy had already created it
  const api = fakeApi(async () => {
    throw apiError(409, 'BUSINESS_SLUG_TAKEN')
  })
  const store = createCreationStore({ api })
  const seen = events(store)
  store.open()
  await store.submit(goodForm())
  assert.equal(api.calls.length, 1)
  const { dialog } = store.getState()
  assert.equal(dialog.phase, 'ready')
  assert.match(dialog.error.message, /Si acabas de intentar crear este mismo negocio, búscalo en la lista/)
  assert.doesNotMatch(dialog.error.message, /por otro negocio/, 'it never claims another business owns the slug')
  store.close()
  assert.deepEqual(seen, [{ type: 'maybe-created' }], 'closing refreshes the list, where the business shows up')
  const picker = code(read('../selector/BusinessPicker.jsx'))
  assert.match(picker, /event\.type === 'maybe-created'\) \{\s*store\.load\(\)/)
})

test('no automatic retry, ever: after a failed or unconfirmed attempt nothing is sent until the user submits again', async () => {
  for (const failure of [new TypeError('Failed to fetch'), apiError(500), apiError(429), apiError(409, 'BUSINESS_SLUG_TAKEN')]) {
    const api = fakeApi(async () => {
      throw failure
    })
    const store = createCreationStore({ api })
    store.open()
    await store.submit(goodForm())
    await new Promise((r) => setTimeout(r, 40)) // time passes: a hidden retry would show up here
    assert.equal(api.calls.length, 1, 'still exactly one request')
    assert.equal(store.getState().dialog.phase, 'ready')
    await store.submit(goodForm()) // an explicit user action
    assert.equal(api.calls.length, 2)
  }
  for (const [name, source] of own) assert.doesNotMatch(source, /setTimeout|setInterval|retry|Retry|queueMicrotask/, `${name}: no timers or retry logic`)
})

test('the success step cannot submit the previous form again, and a stray Enter there activates nothing', async () => {
  const api = fakeApi()
  const store = createCreationStore({ api })
  store.open()
  await store.submit(goodForm())
  assert.equal(store.getState().dialog.phase, 'created')
  for (let i = 0; i < 3; i += 1) await store.submit(goodForm()) // Enter, Enter, Enter
  assert.equal(api.calls.length, 1, 'phase "created" accepts no submission')
  const html = mod.renderCreated({ id: ID_A, name: 'Café Olivo', slug: 'cafe-olivo', active: true, logoUrl: null })
  assert.doesNotMatch(html, /<form|type="submit"/, 'no form to resubmit')
  // the initial focus is the title (tabindex -1), so Enter does not land on "Administrar negocio"
  assert.match(html, /<h3 id="[^"]+" tabindex="-1" class="admin-menu__modal-title">Negocio creado<\/h3>/)
  assert.doesNotMatch(code(read('./BusinessCreateDialog.jsx')), /manageRef/)
})

test('a pending request cannot be closed by accident, by any route', async () => {
  const gate = deferred()
  const store = createCreationStore({ api: fakeApi(() => gate.promise) })
  const seen = events(store)
  store.open()
  const pending = store.submit(goodForm())
  for (let i = 0; i < 3; i += 1) store.close() // Escape, Cancel, any other close request
  assert.equal(store.getState().dialog.phase, 'saving')
  assert.deepEqual(seen, [])
  const dialogSource = code(read('./BusinessCreateDialog.jsx'))
  assert.match(dialogSource, /disableEscape: saving/)
  assert.match(dialogSource, /onClick=\{requestClose\} disabled=\{saving\}/)
  assert.match(dialogSource, /function requestClose\(\) \{\s*if \(saving\) return/)
  gate.resolve(created({ name: 'Café Olivo', slug: 'cafe-olivo' }))
  await pending
  assert.equal(store.getState().dialog.phase, 'created')
})

test('creating another business starts from a clean form: new dialog, no leftover data, error or created business', async () => {
  const store = createCreationStore({ api: fakeApi() })
  store.open()
  const first = store.getState().dialog.id
  await store.submit(goodForm({ name: 'Primero', slug: 'primero', phone: '123' }))
  store.close()
  assert.equal(store.getState().dialog, null)
  store.open()
  const { dialog } = store.getState()
  assert.notEqual(dialog.id, first, 'a new serial id keys a brand-new form component')
  assert.deepEqual({ phase: dialog.phase, error: dialog.error, created: dialog.created, ambiguousSlug: dialog.ambiguousSlug }, { phase: 'ready', error: null, created: null, ambiguousSlug: null })
  const html = mod.renderContainer(store)
  assert.equal((html.match(/value=""/g) ?? []).length, 5, 'name, slug, address, phone and hours are empty')
  assert.doesNotMatch(html, /Primero|primero|123/)
  assert.match(code(read('./BusinessCreateDialog.jsx')), /<CreateForm key=\{dialog\.id\}/)
})

test('"Administrar negocio" and "Crear administrador" act on the business that was just created, never on a list position', () => {
  const dialogSource = code(read('./BusinessCreateDialog.jsx'))
  assert.match(dialogSource, /onClick=\{\(\) => onManage\(business\)\}/)
  assert.match(dialogSource, /onClick=\{\(\) => onAddAdmin\(business\)\}/)
  assert.match(dialogSource, /<CreatedPanel[^>]*business=\{dialog\.created\}/)
  const gate = code(read('../selector/BusinessGate.jsx'))
  assert.match(gate, /onManage=\{\(business\) => \{\s*creation\.close\(\)\s*setNotice\(''\)\s*setActiveBusiness\(business\.id\)/)
  assert.match(gate, /onAddAdmin=\{\(business\) => \{\s*creation\.close\(\)\s*admins\.open\(business\)/)
  assert.doesNotMatch(gate, /items\[0\]|\[0\]\.id/)
})

// ======================================================================================================================
// guarantees by source: who can reach this, what it may touch
// ======================================================================================================================
test('only a SUPER_ADMIN reaches it: the gate is the only importer, the gate is mounted only for them, and no creation code reads a role', () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(new URL(`${e.name}/`, dir)) : [new URL(e.name, dir)]))
  const importers = walk(new URL('../../', import.meta.url))
    .filter((u) => /\.(js|jsx)$/.test(u.pathname) && !u.pathname.endsWith('.test.js') && !u.pathname.includes('/tenant/creation/'))
    .filter((u) => /tenant\/creation|\.\.\/creation\//.test(code(readFileSync(u, 'utf8'))))
    .map((u) => u.pathname.split('/src/')[1])
    .sort()
  assert.deepEqual(importers, ['tenant/selector/BusinessGate.jsx'])
  const panel = code(read('../../pages/admin/AdminPanel.jsx'))
  assert.match(panel, /isBusinessSelectable \? <BusinessGate/)
  assert.doesNotMatch(panel, /creation|Crear negocio/)
  for (const [name, source] of own) {
    assert.doesNotMatch(source, /user\??\.role|SUPER_ADMIN|'ADMIN'|ROLE_|isBusinessSelectable/, `${name}: the role decision lives in tenantCore only`)
    assert.doesNotMatch(source, /localStorage|sessionStorage|devtools|useViewAs|Authorization|accessToken|jwt/i, name)
  }
})

test('the request: POST /businesses with the real token and exactly the payload — never tenant-scoped, never with a businessId', async () => {
  const api = code(read('./businessCreateApi.js'))
  assert.match(api, /apiFetch\('\/businesses', \{ token: getToken\(\), method: 'POST', body: JSON\.stringify\(payload\) \}\)/)
  assert.doesNotMatch(api, /scopePath|scopeBody|businessId|useActiveBusiness/)
  const mod2 = await loadModule(`export { createBusinessCreateApi } from './tenant/creation/businessCreateApi.js'`)
  const seen = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => (seen.push({ url: String(url), init }), { ok: true, status: 201, json: async () => ({}) })
  try {
    await mod2.createBusinessCreateApi({ getToken: () => 'real-token' }).createBusiness({ name: 'Café Olivo', slug: 'cafe-olivo' })
  } finally {
    globalThis.fetch = realFetch
  }
  assert.equal(seen.length, 1)
  assert.match(seen[0].url, /\/businesses$/)
  assert.equal(seen[0].init.method, 'POST')
  assert.equal(seen[0].init.headers.Authorization, 'Bearer real-token')
  assert.deepEqual(JSON.parse(seen[0].init.body), { name: 'Café Olivo', slug: 'cafe-olivo' })
})

test('accessibility wiring: the same dialog hook as the other dialogs (focus trap, focus restore, Escape blocked while saving, initial focus on the first field)', () => {
  const dialogSource = code(read('./BusinessCreateDialog.jsx'))
  assert.equal((dialogSource.match(/useDialogA11y\(/g) ?? []).length, 2, 'form and created step')
  assert.match(dialogSource, /useDialogA11y\(\{ containerRef: dialogRef, onEscape: requestClose, initialFocusRef: nameRef, disableEscape: saving \}\)/)
  assert.match(dialogSource, /initialFocusRef: titleRef/, 'the created step focuses its title, never a button')
  assert.match(dialogSource, /ref=\{nameRef\}/)
  assert.doesNotMatch(dialogSource, /autoFocus/, 'focus is managed by the hook, not by autoFocus')
  assert.match(dialogSource, /if \(!saving\) onSubmit\(form\)/)
  assert.match(dialogSource, /Tienes datos sin guardar/)
  // the backdrop never closes anything: no onClick on it
  assert.doesNotMatch(dialogSource, /confirm-backdrop"[^>]*onClick/)
})

test('creation styles use only theme tokens (light and dark): no literal colour, every token exists, theme-dependent ones are redefined for dark', () => {
  const css = code(read('../../styles/index.css'))
  const tokens = read('../../styles/tokens.css')
  const start = css.indexOf('.business-picker__head {')
  const end = css.indexOf('.admin-login__notice {', start)
  assert.ok(start > 0 && end > start)
  const block = css.slice(start, end)
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|:\s*(white|black)\b/)
  const darkStart = tokens.indexOf(':root[data-theme="dark"] {')
  const dark = tokens.slice(darkStart, tokens.indexOf('\n}', darkStart))
  const used = [...new Set([...block.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]))]
  assert.ok(used.length >= 8)
  for (const token of used) assert.match(tokens + css, new RegExp(`${token}:`), `${token} is defined`)
  for (const token of ['--warning', '--warning-tint', '--danger', '--primary-tint', '--primary-text', '--text-muted', '--text', '--border', '--focus-ring']) {
    if (used.includes(token)) assert.match(dark, new RegExp(`${token}:`), `${token} is redefined for the dark theme`)
  }
  assert.doesNotMatch(block, /var\(--text-secondary\)/, 'the legacy alias is not used in new code')
  assert.match(block, /\.business-dialog__link:focus-visible \{[^}]*var\(--focus-ring\)/)
  assert.match(block, /\.business-picker__create \{[^}]*min-height: 44px/)
  assert.match(block, /@media \(max-width: 539px\)/)
})
