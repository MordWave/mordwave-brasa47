import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { loadModule } from '../../theme/testSupport.js'
import { ACTIVE_BUSINESS_STORAGE_KEY } from '../tenantCore.js'
import { createBusinessListStore, describeListError, normalizeSearch } from './businessListStore.js'
import { classifyValidationError, createBusinessValidator } from './businessValidation.js'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const selectorSources = readdirSync(new URL('.', import.meta.url))
  .filter((f) => /\.(js|jsx)$/.test(f) && !f.endsWith('.test.js'))
  .map((f) => [f, code(read(`./${f}`))])

const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ID_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const biz = (id, name, extra = {}) => ({ id, name, slug: name.toLowerCase().replace(/\s+/g, '-'), active: true, logoUrl: null, ...extra })
const page = (items, extra = {}) => ({ items, page: 1, limit: 20, total: items.length, totalPages: 1, hasMore: false, ...extra })
const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status })
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

// ======================================================================================================================
// list store: pagination, search, filter, errors, stale answers
// ======================================================================================================================
test('load: loading -> ready with items, total and hasMore; asks page 1 with the page size', async () => {
  const calls = []
  const store = createBusinessListStore({
    fetchPage: async (params) => (calls.push(params), page([biz(ID_A, 'Alfa'), biz(ID_B, 'Beta')], { total: 45, totalPages: 3, hasMore: true })),
  })
  assert.equal(store.getState().status, 'loading')
  const seen = []
  store.subscribe(() => seen.push(store.getState().status))
  await store.load()
  assert.deepEqual(calls, [{ page: 1, limit: 20, search: '', active: 'all' }])
  assert.deepEqual(seen, ['loading', 'ready'])
  assert.deepEqual(store.getState().items.map((b) => b.name), ['Alfa', 'Beta'])
  assert.equal(store.getState().total, 45)
  assert.equal(store.getState().hasMore, true)
})

test('progressive loading: loadMore appends the next page, de-duplicates and never runs concurrently or past the end', async () => {
  const calls = []
  const pages = {
    1: page([biz(ID_A, 'Alfa'), biz(ID_B, 'Beta')], { page: 1, total: 3, totalPages: 2, hasMore: true }),
    2: page([biz(ID_B, 'Beta'), biz(ID_C, 'Gamma')], { page: 2, total: 3, totalPages: 2, hasMore: false }), // Beta repeated (the list shifted)
  }
  const gate2 = deferred()
  const store = createBusinessListStore({
    pageSize: 2,
    fetchPage: async (params) => {
      calls.push(params.page)
      return params.page === 2 ? gate2.promise : pages[params.page]
    },
  })
  await store.loadMore() // nothing loaded yet: no-op
  assert.deepEqual(calls, [])
  await store.load()
  const first = store.loadMore()
  const duplicate = store.loadMore() // while the first is in flight
  assert.equal(store.getState().loadingMore, true)
  gate2.resolve(pages[2])
  await Promise.all([first, duplicate])
  assert.deepEqual(calls, [1, 2], 'one request per page')
  assert.deepEqual(store.getState().items.map((b) => b.name), ['Alfa', 'Beta', 'Gamma'], 'appended, no duplicate')
  assert.equal(store.getState().hasMore, false)
  await store.loadMore()
  assert.deepEqual(calls, [1, 2], 'no request past the last page')
})

test('search is normalised (trim, collapse, 80 chars), restarts at page 1 and is passed to the API; the same text is a no-op', async () => {
  const calls = []
  const store = createBusinessListStore({ fetchPage: async (p) => (calls.push(p), page([])) })
  await store.load()
  await store.setSearch('   brasa    norte  ')
  assert.equal(store.getState().search, 'brasa norte')
  assert.deepEqual(calls.at(-1), { page: 1, limit: 20, search: 'brasa norte', active: 'all' })
  const count = calls.length
  await store.setSearch('brasa norte')
  await store.setSearch('  brasa norte ')
  assert.equal(calls.length, count)
  assert.equal(normalizeSearch('x'.repeat(200)).length, 80)
  assert.equal(normalizeSearch(null), '')
})

test('the active filter restarts at page 1; only "true"/"false" are sent, anything else means all', async () => {
  const calls = []
  const store = createBusinessListStore({ fetchPage: async (p) => (calls.push(p), page([])) })
  await store.load()
  await store.setActive('false')
  assert.equal(calls.at(-1).active, 'false')
  await store.setActive('true')
  assert.equal(calls.at(-1).active, 'true')
  await store.setActive('bogus')
  assert.equal(calls.at(-1).active, 'all')
  const count = calls.length
  await store.setActive('all')
  assert.equal(calls.length, count)
})

test('an OLD answer never overwrites a newer one, whichever order they arrive in', async () => {
  const slow = deferred()
  const fast = deferred()
  const answers = { brasa: slow, zeta: fast }
  const store = createBusinessListStore({ fetchPage: (p) => answers[p.search]?.promise ?? Promise.resolve(page([])) })
  await store.load()
  const first = store.setSearch('brasa') // slow
  const second = store.setSearch('zeta') // newer
  fast.resolve(page([biz(ID_C, 'Zeta Pizza')]))
  await second
  slow.resolve(page([biz(ID_A, 'Brasa 47')])) // the stale answer arrives last
  await first
  assert.deepEqual(store.getState().items.map((b) => b.name), ['Zeta Pizza'])
  assert.equal(store.getState().search, 'zeta')

  // and the other order: the stale one arrives first
  const s1 = deferred()
  const s2 = deferred()
  const queue = [s1, s2]
  const store2 = createBusinessListStore({ fetchPage: () => queue.shift().promise })
  const a = store2.load()
  const b = store2.setSearch('x')
  s1.resolve(page([biz(ID_A, 'Old')]))
  await a
  assert.equal(store2.getState().items.length, 0, 'the superseded answer is dropped')
  s2.resolve(page([biz(ID_B, 'New')]))
  await b
  assert.deepEqual(store2.getState().items.map((x) => x.name), ['New'])
})

test('a late "load more" cannot contaminate a list that has since been re-filtered', async () => {
  const more = deferred()
  const calls = []
  const store = createBusinessListStore({
    fetchPage: (p) => {
      calls.push(p)
      if (p.page === 2) return more.promise
      return Promise.resolve(p.search === 'q' ? page([biz(ID_C, 'Q only')]) : page([biz(ID_A, 'Alfa')], { hasMore: true, total: 5, totalPages: 2 }))
    },
  })
  await store.load()
  const loading = store.loadMore()
  await store.setSearch('q')
  more.resolve(page([biz(ID_B, 'Page two of the OLD search')], { page: 2 }))
  await loading
  assert.deepEqual(store.getState().items.map((b) => b.name), ['Q only'])
  assert.equal(store.getState().loadingMore, false)
})

test('errors are classified for the UI: 401, 403, server and network (no raw backend text)', () => {
  assert.equal(describeListError(httpError(401)).kind, 'unauthorized')
  assert.equal(describeListError(httpError(403)).kind, 'forbidden')
  assert.equal(describeListError(httpError(500)).kind, 'server')
  assert.equal(describeListError(httpError(503)).kind, 'server')
  assert.equal(describeListError(new TypeError('Failed to fetch')).kind, 'network')
  for (const e of [httpError(401), httpError(403), httpError(500), new TypeError('x')]) {
    assert.match(describeListError(e).message, /^[A-ZÁÉÍÓÚ].*\.$/)
    assert.doesNotMatch(describeListError(e).message, /HTTP|TypeError|fetch/i)
  }
})

test('401 / 403 / 500 while loading: status error, no items, and retry recovers (except where it cannot help)', async () => {
  for (const status of [401, 403, 500]) {
    let fail = true
    const store = createBusinessListStore({ fetchPage: async () => (fail ? Promise.reject(httpError(status)) : page([biz(ID_A, 'Alfa')])) })
    await store.load()
    assert.equal(store.getState().status, 'error', String(status))
    assert.equal(store.getState().items.length, 0)
    assert.equal(store.getState().error.kind, { 401: 'unauthorized', 403: 'forbidden', 500: 'server' }[status])
    fail = false
    await store.retry()
    assert.equal(store.getState().status, 'ready')
    assert.equal(store.getState().error, null)
    assert.equal(store.getState().items.length, 1)
  }
})

test('a failed search/filter never leaves the previous query\'s results under the error', async () => {
  let failing = false
  const store = createBusinessListStore({
    fetchPage: async () => {
      if (failing) throw httpError(500)
      return page([biz(ID_A, 'Alfa')], { total: 1 })
    },
  })
  await store.load()
  assert.equal(store.getState().items.length, 1)
  failing = true
  await store.setSearch('boom')
  assert.equal(store.getState().status, 'error')
  assert.deepEqual(store.getState().items, [])
  assert.equal(store.getState().total, 0)
  failing = false
  await store.retry()
  assert.deepEqual(store.getState().items.map((b) => b.name), ['Alfa'])
})

test('an error on "load more" keeps what is shown, reports the error and retry appends the same page', async () => {
  let failPage2 = true
  const store = createBusinessListStore({
    fetchPage: async (p) => {
      if (p.page === 1) return page([biz(ID_A, 'Alfa')], { hasMore: true, total: 2, totalPages: 2 })
      if (failPage2) throw httpError(500)
      return page([biz(ID_B, 'Beta')], { page: 2, total: 2, totalPages: 2 })
    },
  })
  await store.load()
  await store.loadMore()
  assert.equal(store.getState().status, 'ready', 'the list stays visible')
  assert.deepEqual(store.getState().items.map((b) => b.name), ['Alfa'])
  assert.equal(store.getState().error.kind, 'server')
  failPage2 = false
  await store.retry()
  assert.deepEqual(store.getState().items.map((b) => b.name), ['Alfa', 'Beta'])
  assert.equal(store.getState().error, null)
})

test('empty result is a ready state with zero items (the view tells filtered from never-created)', async () => {
  const store = createBusinessListStore({ fetchPage: async () => page([], { total: 0, totalPages: 0 }) })
  await store.load()
  assert.equal(store.getState().status, 'ready')
  assert.equal(store.getState().items.length, 0)
  assert.equal(store.getState().total, 0)
})

// ======================================================================================================================
// validator: a restored/chosen selection must exist and be active before any data is loaded
// ======================================================================================================================
test('valid: an active business that answers with the id that was asked for', async () => {
  const v = createBusinessValidator({ fetchBusiness: async (id) => biz(id, 'Alfa') })
  const states = []
  v.subscribe(() => states.push(v.getState().status))
  await v.validate(ID_A)
  assert.deepEqual(states, ['checking', 'valid'])
  assert.equal(v.getState().business.name, 'Alfa')
  assert.equal(v.getState().businessId, ID_A)
})

test('inactive, missing and unverifiable businesses are never "valid"', async () => {
  const cases = [
    [async (id) => biz(id, 'Off', { active: false }), 'inactive'],
    [async (id) => ({ id, name: 'NoFlag' }), 'inactive'], // active must be exactly true
    [async () => Promise.reject(httpError(404)), 'not-found'],
    [async () => Promise.reject(httpError(401)), 'unauthorized'],
    [async () => Promise.reject(httpError(403)), 'error'],
    [async () => Promise.reject(httpError(500)), 'error'],
    [async () => Promise.reject(new TypeError('Failed to fetch')), 'error'],
    [async () => null, 'error'],
  ]
  for (const [fetchBusiness, expected] of cases) {
    const v = createBusinessValidator({ fetchBusiness })
    await v.validate(ID_A)
    assert.equal(v.getState().status, expected)
    assert.notEqual(v.getState().status, 'valid')
    if (expected !== 'inactive') assert.equal(v.getState().business, null)
  }
  assert.equal(classifyValidationError(httpError(404)), 'not-found')
})

test('an answer about a DIFFERENT business than the one asked for is rejected', async () => {
  const v = createBusinessValidator({ fetchBusiness: async () => biz(ID_B, 'Beta') })
  await v.validate(ID_A)
  assert.equal(v.getState().status, 'error')
  assert.equal(v.getState().business, null)
  const same = createBusinessValidator({ fetchBusiness: async () => biz(ID_A.toUpperCase(), 'Alfa') })
  await same.validate(ID_A)
  assert.equal(same.getState().status, 'valid', 'ids compare case-insensitively')
})

test('switching business: the slow answer for the previous one never applies to the new one (either arrival order)', async () => {
  const slowA = deferred()
  const fastB = deferred()
  const v = createBusinessValidator({ fetchBusiness: (id) => (id === ID_A ? slowA.promise : fastB.promise) })
  const first = v.validate(ID_A)
  const second = v.validate(ID_B)
  fastB.resolve(biz(ID_B, 'Beta'))
  await second
  slowA.resolve(biz(ID_A, 'Alfa'))
  await first
  assert.equal(v.getState().businessId, ID_B)
  assert.equal(v.getState().business.name, 'Beta')

  const lateA = deferred()
  const v2 = createBusinessValidator({ fetchBusiness: () => lateA.promise })
  const pending = v2.validate(ID_A)
  v2.reset() // e.g. "Cambiar negocio" or logout while checking
  lateA.resolve(biz(ID_A, 'Alfa'))
  await pending
  assert.equal(v2.getState().status, 'idle', 'a stale validation cannot resurrect a dropped selection')
  assert.equal(v2.getState().business, null)
})

// ======================================================================================================================
// the real components, rendered with the real providers (initial, effect-free render)
// ======================================================================================================================
let mod
const saved = { localStorage: globalThis.localStorage, window: globalThis.window }
function stubStorage(initial = {}) {
  const data = { ...initial }
  return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => (data[k] = String(v)), removeItem: (k) => delete data[k] }
}
before(async () => {
  mod = await loadModule(`
    import { renderToStaticMarkup } from 'react-dom/server'
    import { AuthProvider } from './context/AuthContext.jsx'
    import { ToastProvider } from './context/ToastContext.jsx'
    import { DevToolsProvider } from './devtools/DevToolsProvider.jsx'
    import { BusinessContextProvider } from './tenant/BusinessContextProvider.jsx'
    import BusinessGate from './tenant/selector/BusinessGate.jsx'
    import BusinessPickerView from './tenant/selector/BusinessPickerView.jsx'
    export const renderView = (props) => renderToStaticMarkup(<BusinessPickerView searchText="" onSearchText={() => {}} onActive={() => {}} onSelect={() => {}} onLoadMore={() => {}} onRetry={() => {}} {...props} />)
    export const renderGate = () =>
      renderToStaticMarkup(
        <AuthProvider>
          <ToastProvider>
            <BusinessContextProvider>
              <DevToolsProvider enabled={true}>
                <BusinessGate onBusiness={() => {}}><div id="panels">PANELS</div></BusinessGate>
              </DevToolsProvider>
            </BusinessContextProvider>
          </ToastProvider>
        </AuthProvider>,
      )
  `)
})
after(() => {
  globalThis.localStorage = saved.localStorage
  globalThis.window = saved.window
})

const state = (extra = {}) => ({ items: [], page: 1, total: 0, totalPages: 0, hasMore: false, search: '', active: 'all', status: 'ready', loadingMore: false, error: null, ...extra })
const SUPER = { id: 'u2', email: 'root@b.test', role: 'SUPER_ADMIN', businessId: null }
function gateHtml({ user, selection, viewAs }) {
  globalThis.localStorage = stubStorage({ brasa47_admin_session: JSON.stringify({ accessToken: 'real-token', user }) })
  globalThis.window = {
    sessionStorage: stubStorage({
      ...(selection ? { [ACTIVE_BUSINESS_STORAGE_KEY]: JSON.stringify(selection) } : {}),
      ...(viewAs ? { 'brasa47-dev-view-as': viewAs } : {}),
    }),
  }
  return mod.renderGate()
}

test('picker view: loading, error (with and without retry), empty (never created vs filtered)', () => {
  assert.match(mod.renderView({ state: state({ status: 'loading' }) }), /Cargando negocios…/)
  const server = mod.renderView({ state: state({ status: 'error', error: describeListError(httpError(500)) }) })
  assert.match(server, /role="alert"/)
  assert.match(server, /No pudimos cargar los negocios/)
  assert.match(server, /Reintentar/)
  const forbidden = mod.renderView({ state: state({ status: 'error', error: describeListError(httpError(403)) }) })
  assert.match(forbidden, /no tiene permiso para ver los negocios/)
  assert.doesNotMatch(forbidden, /Reintentar/, 'retrying a 403 cannot help')
  assert.match(mod.renderView({ state: state() }), /Todavía no hay negocios registrados/)
  assert.match(mod.renderView({ state: state({ search: 'zzz' }) }), /Ningún negocio coincide/)
  assert.match(mod.renderView({ state: state({ active: 'false' }) }), /Ningún negocio coincide/)
})

test('picker view: shows name, slug, logo (or initials) and Activo/Suspendido; suspended ones cannot be entered', () => {
  const items = [
    biz(ID_A, 'Brasa 47', { logoUrl: 'https://api.example.com/media/x.webp' }),
    biz(ID_B, 'Casa Olivo', { active: false }),
    biz(ID_C, 'Zeta Pizza'),
  ]
  const html = mod.renderView({ state: state({ items, total: 3 }) })
  assert.match(html, /Brasa 47/)
  assert.match(html, /brasa-47/)
  assert.match(html, /<img class="business-card__logo" src="https:\/\/api\.example\.com\/media\/x\.webp"/)
  assert.match(html, />CO</, 'initials when there is no logo')
  assert.equal((html.match(/>Activo</g) ?? []).length, 2)
  assert.equal((html.match(/>Suspendido</g) ?? []).length, 1)
  assert.match(html, /Mostrando 3 de 3/)
  // active = real buttons, inactive = a non-interactive, aria-disabled block with an explanation
  assert.equal((html.match(/<button type="button" class="business-card"/g) ?? []).length, 2)
  assert.match(html, /aria-label="Administrar Brasa 47"/)
  assert.match(html, /<div class="business-card business-card--inactive" aria-disabled="true">/)
  assert.doesNotMatch(html, /Editar|Suspender|Reactivar/, 'without the management callbacks there are no management buttons')
  assert.doesNotMatch(html, /Administrar Casa Olivo/)
  assert.match(html, /Suspendido: no se puede administrar hasta reactivarlo/)
})

test('picker view: pagination controls, notice, labelled filters', () => {
  const more = mod.renderView({ state: state({ items: [biz(ID_A, 'Alfa')], total: 40, totalPages: 2, hasMore: true }) })
  assert.match(more, /Mostrando 1 de 40/)
  assert.match(more, /Cargar más/)
  assert.doesNotMatch(mod.renderView({ state: state({ items: [biz(ID_A, 'Alfa')], total: 1 }) }), /Cargar más/)
  assert.match(mod.renderView({ state: state({ items: [biz(ID_A, 'Alfa')], hasMore: true, loadingMore: true }) }), /<button[^>]*disabled[^>]*>Cargando…<\/button>/)
  assert.match(mod.renderView({ state: state(), notice: 'El negocio que tenías seleccionado ya no existe. Elige otro.' }), /role="status">El negocio que tenías seleccionado ya no existe/)
  const html = mod.renderView({ state: state() })
  assert.match(html, /<label for="([^"]+)">Buscar<\/label>\s*<input id="\1" type="search"/)
  assert.match(html, /<label for="([^"]+)">Estado<\/label>\s*<select id="\1"/)
  assert.match(html, /<option value="all"[^>]*>Todos<\/option><option value="true"[^>]*>Activos<\/option><option value="false"[^>]*>Suspendidos<\/option>/)
  assert.match(html, /maxLength="80"/)
  assert.match(html, /<section class="business-picker" aria-labelledby=/)
})

test('gate, SUPER_ADMIN with no selection: the picker, and none of the Admin panels', () => {
  const html = gateHtml({ user: SUPER })
  assert.match(html, /Selecciona un negocio/)
  assert.match(html, /business-picker/)
  assert.doesNotMatch(html, /PANELS|Administrando|Cambiar negocio/)
})

test('gate, SUPER_ADMIN with a restored selection: it is verified first, no panel is mounted before that', () => {
  const html = gateHtml({ user: SUPER, selection: { userId: SUPER.id, businessId: ID_A } })
  assert.match(html, /Comprobando negocio…/)
  assert.doesNotMatch(html, /PANELS|Administrando|Cambiar negocio|<section class="business-picker"/)
})

test("gate: another identity's selection is ignored (the picker is shown)", () => {
  const html = gateHtml({ user: SUPER, selection: { userId: 'someone-else', businessId: ID_A } })
  assert.match(html, /business-picker/)
  assert.doesNotMatch(html, /Comprobando negocio|PANELS/)
})

test('gate: a tampered stored value shows the picker, never a business', () => {
  globalThis.localStorage = stubStorage({ brasa47_admin_session: JSON.stringify({ accessToken: 't', user: SUPER }) })
  globalThis.window = { sessionStorage: stubStorage({ [ACTIVE_BUSINESS_STORAGE_KEY]: '{"userId":"u2","businessId":"../../x"}' }) }
  const html = mod.renderGate()
  assert.match(html, /business-picker/)
  assert.doesNotMatch(html, /PANELS|Comprobando/)
})

test('Dev Tools never enables the selector nor changes the tenant: a real SUPER_ADMIN previewing ADMIN still gets the picker', () => {
  const html = gateHtml({ user: SUPER, viewAs: 'ADMIN' })
  assert.match(html, /business-picker/)
  assert.doesNotMatch(html, /PANELS/)
  const restored = gateHtml({ user: SUPER, selection: { userId: SUPER.id, businessId: ID_A }, viewAs: 'ADMIN' })
  assert.match(restored, /Comprobando negocio…/)
})

// ======================================================================================================================
// guarantees by source: who can reach the global listing, what the selector may touch
// ======================================================================================================================
test('an ADMIN never calls GET /businesses: the listing is reachable only through the gate, which only a SUPER_ADMIN mounts', () => {
  const panel = code(read('../../pages/admin/AdminPanel.jsx'))
  assert.match(panel, /isBusinessSelectable \? <BusinessGate/)
  assert.equal((panel.match(/BusinessGate/g) ?? []).length, 4, 'the import (identifier + path), the one conditional use and its closing tag')
  // fetchBusinessPage (the only caller of the listing) is imported by the picker container and nothing else
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(new URL(`${e.name}/`, dir)) : [new URL(e.name, dir)]))
  const users = walk(new URL('../../', import.meta.url))
    .filter((u) => /\.(js|jsx)$/.test(u.pathname) && !u.pathname.endsWith('.test.js'))
    .filter((u) => /fetchBusinessPage/.test(code(readFileSync(u, 'utf8'))))
    .map((u) => u.pathname.split('/src/')[1])
    .sort()
  assert.deepEqual(users, ['tenant/selector/BusinessPicker.jsx', 'tenant/selector/businessApi.js'])
  // the listing URL is exactly /businesses (+ page/limit/search/active), never tenant-scoped and never with businessId
  const api = code(read('./businessApi.js'))
  assert.match(api, /appendQuery\('\/businesses', params\)/)
  assert.doesNotMatch(api, /scopePath|scopeBody|businessId/)
  assert.doesNotMatch(code(read('../../pages/admin/AdminPanel.jsx')), /'\/businesses'/)
})

test('the list request: real token only, page/limit/search/active, no businessId, "all" sends no active param', async () => {
  const api = await loadModule(`export { fetchBusinessPage } from './tenant/selector/businessApi.js'`)
  const seen = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => (seen.push({ url: String(url), headers: init.headers }), { ok: true, status: 200, json: async () => page([]) })
  try {
    await api.fetchBusinessPage({ token: 'real-token', page: 2, limit: 20, search: 'brasa norte', active: 'all' })
    await api.fetchBusinessPage({ token: 'real-token', page: 1, limit: 20, search: '', active: 'false' })
  } finally {
    globalThis.fetch = realFetch
  }
  assert.match(seen[0].url, /\/businesses\?page=2&limit=20&search=brasa%20norte$/)
  assert.match(seen[1].url, /\/businesses\?page=1&limit=20&active=false$/)
  for (const s of seen) {
    assert.doesNotMatch(s.url, /businessId/)
    assert.deepEqual(Object.keys(s.headers).sort(), ['Authorization', 'Content-Type'])
    assert.equal(s.headers.Authorization, 'Bearer real-token')
  }
})

test('the selector touches no JWT, AuthContext state, roles or headers, and never reads the Dev Tools preview', () => {
  for (const [name, source] of selectorSources) {
    assert.doesNotMatch(source, /devtools|useViewAs|viewAs|effectiveViewRole|ViewAs/, name)
    assert.doesNotMatch(source, /localStorage|sessionStorage/, `${name}: storage belongs to the tenant store only`)
    assert.doesNotMatch(source, /setSession|login\(|logout|Authorization|accessToken|jwt/i, name)
    assert.doesNotMatch(source, /user\??\.role|SUPER_ADMIN|'ADMIN'/, `${name}: the role decision lives in tenant/tenantCore.js only`)
  }
  const gate = code(read('./BusinessGate.jsx'))
  assert.match(gate, /apiFetch\(latest\.current\.scopePath\('\/businesses\/me'\)/, 'verification reuses the 8D.1 scoping helper')
  assert.match(gate, /const \{ token \} = useAuth\(\)/)
})

test('the gate verifies before it renders panels, drops stale selections and keeps the user out when it cannot verify', () => {
  const gate = code(read('./BusinessGate.jsx'))
  assert.match(gate, /isBusinessReady && state\.status === 'valid' && state\.businessId === businessId/)
  assert.match(gate, /state\.status === 'not-found'[\s\S]*clearActiveBusiness\(\)/)
  assert.match(gate, /state\.status === 'inactive'[\s\S]*clearActiveBusiness\(\)/)
  assert.match(gate, /confirmActiveBusiness\(businessId\)/)
  assert.match(gate, /Elegir otro negocio/)
  assert.match(gate, /Cambiar negocio/)
  assert.doesNotMatch(gate, /items\[0\]|\[0\]\.id/, 'never auto-selects a business')
  const provider = code(read('../BusinessContextProvider.jsx'))
  assert.match(provider, /if \(isBusinessSelectable && userId && id === businessId\) setValidated/)
  assert.match(provider, /validated\?\.userId === userId && validated\?\.businessId === businessId/)
})

test('the picker only lets an ACTIVE business be chosen; there is no auto-selection; management buttons never select', () => {
  const view = code(read('./BusinessPickerView.jsx'))
  assert.match(view, /business\.active \? \(\s*<button type="button" className="business-card" onClick=\{\(\) => onSelect\(business\.id\)\}[\s\S]*\) : \(\s*<div className="business-card business-card--inactive" aria-disabled="true">/)
  assert.equal((view.match(/onSelect\(/g) ?? []).length, 1, 'the only way to choose a business is the active card button')
  assert.match(view, /management\.onEdit\(business\)/)
  assert.match(view, /management\.onSuspend\(business\)/)
  assert.match(view, /management\.onActivate\(business\)/)
  // the selector folder itself never talks to the management endpoints or sends anything but the listing GET
  for (const [name, source] of selectorSources) assert.doesNotMatch(source, /method: '(POST|PATCH|PUT|DELETE)'|\/businesses\/me\/logo|crear negocio|nuevo negocio|desactivar|impersonar/i, name)
})

test('selector styles use only theme tokens (light and dark): no literal colour', () => {
  const css = code(read('../../styles/index.css'))
  const start = css.indexOf('.business-picker {')
  const end = css.indexOf('@media print', start)
  assert.ok(start > 0 && end > start)
  const block = css.slice(start, end)
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|:\s*(white|black)\b/)
  assert.match(block, /\.business-card--inactive \{[^}]*background:\s*var\(--dimmed-surface\)/)
  assert.match(block, /\.business-card__hint \{[^}]*color:\s*var\(--dimmed-text\)/)
  assert.match(block, /button\.business-card:focus-visible \{[^}]*var\(--focus-ring\)/)
  assert.match(css, /@media print \{[^}]*\.admin-panel__tenant,\s*\.business-picker/)
})
