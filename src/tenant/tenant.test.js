import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { loadModule } from '../theme/testSupport.js'
import { ACTIVE_BUSINESS_STORAGE_KEY, isBusinessSelectableRole, normalizeBusinessId, readActiveBusiness, resolveActiveBusiness, writeActiveBusiness } from './tenantCore.js'
import { NoActiveBusinessError, appendQuery, scopeBody, scopePath } from './tenantRequest.js'
import { createTenantStore } from './tenantStore.js'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const tenantSources = readdirSync(new URL('.', import.meta.url))
  .filter((f) => /\.(js|jsx)$/.test(f) && !f.endsWith('.test.js'))
  .map((f) => [f, code(read(`./${f}`))])

const OWN = '11111111-1111-4111-8111-111111111111' // an ADMIN's business
const OTHER = '22222222-2222-4222-8222-222222222222'
const CHOSEN = '33333333-3333-4333-8333-333333333333'

function stubStorage(initial = {}) {
  const data = { ...initial }
  const calls = []
  return {
    data,
    calls,
    getItem: (k) => (calls.push(['get', k]), k in data ? data[k] : null),
    setItem: (k, v) => (calls.push(['set', k]), (data[k] = String(v))),
    removeItem: (k) => (calls.push(['remove', k]), delete data[k]),
  }
}

// ---- resolution -----------------------------------------------------------------------------------------------------
test('ADMIN resolves automatically to their own business, and nothing can switch it', () => {
  const base = { role: 'ADMIN', userBusinessId: OWN }
  assert.deepEqual(resolveActiveBusiness({ ...base, selectedBusinessId: null }), { businessId: OWN, requiresBusinessSelection: false, isBusinessSelectable: false })
  // a forged / stale selection is ignored for an ADMIN, valid UUID or not
  for (const selected of [OTHER, CHOSEN, 'x', '../../etc']) assert.equal(resolveActiveBusiness({ ...base, selectedBusinessId: selected }).businessId, OWN)
  assert.equal(isBusinessSelectableRole('ADMIN'), false)
})

test('SUPER_ADMIN without a selection never gets an invented businessId', () => {
  for (const userBusinessId of [null, undefined, OWN]) {
    const r = resolveActiveBusiness({ role: 'SUPER_ADMIN', userBusinessId, selectedBusinessId: null })
    assert.deepEqual(r, { businessId: null, requiresBusinessSelection: true, isBusinessSelectable: true }, `userBusinessId=${userBusinessId}`)
  }
})

test('SUPER_ADMIN with a valid selection gets exactly that business', () => {
  const r = resolveActiveBusiness({ role: 'SUPER_ADMIN', userBusinessId: null, selectedBusinessId: CHOSEN.toUpperCase() })
  assert.deepEqual(r, { businessId: CHOSEN, requiresBusinessSelection: false, isBusinessSelectable: true })
  assert.equal(isBusinessSelectableRole('SUPER_ADMIN'), true)
})

test('unknown roles and no user resolve to nothing (no business, no selection)', () => {
  for (const role of [null, undefined, 'MANAGER', 'CUSTOMER', 'admin', '']) {
    assert.deepEqual(resolveActiveBusiness({ role, userBusinessId: OWN, selectedBusinessId: CHOSEN }), { businessId: null, requiresBusinessSelection: false, isBusinessSelectable: false }, String(role))
  }
  assert.equal(resolveActiveBusiness().businessId, null)
})

test('invalid business ids are discarded', () => {
  for (const bad of [null, undefined, '', ' ', 'abc', 123, {}, [CHOSEN], `${CHOSEN}x`, `x${CHOSEN}`, '../1', `${CHOSEN}/../x`, `${CHOSEN}\n`.replace('\n', '%0a'), '33333333-3333-4333-8333-33333333333']) {
    assert.equal(normalizeBusinessId(bad), null, String(bad))
    assert.equal(resolveActiveBusiness({ role: 'SUPER_ADMIN', selectedBusinessId: bad }).businessId, null)
  }
  assert.equal(normalizeBusinessId(`  ${CHOSEN.toUpperCase()}  `), CHOSEN)
})

// ---- persistence (sessionStorage, SUPER_ADMIN only) -----------------------------------------------------------------
test('an invalid value found in sessionStorage is dropped and cleaned up', () => {
  for (const bad of ['nope', '', '{"id":"x"}', '../../x']) {
    const storage = stubStorage({ [ACTIVE_BUSINESS_STORAGE_KEY]: bad })
    assert.equal(readActiveBusiness(storage), null, bad)
    assert.ok(!(ACTIVE_BUSINESS_STORAGE_KEY in storage.data))
  }
  assert.equal(readActiveBusiness(null), null)
  assert.equal(readActiveBusiness({ getItem() { throw new Error('blocked') } }), null)
  assert.equal(writeActiveBusiness({ setItem() { throw new Error('blocked') } }, CHOSEN), false)
})

test('the selection persists only for this tab/session: survives a refresh, a new tab starts empty', () => {
  const tab = stubStorage()
  const a = createTenantStore({ storage: tab })
  assert.equal(a.getState().selectedBusinessId, null)
  assert.equal(a.select(CHOSEN), true)
  assert.equal(tab.data[ACTIVE_BUSINESS_STORAGE_KEY], CHOSEN)
  assert.equal(createTenantStore({ storage: tab }).getState().selectedBusinessId, CHOSEN, 'same tab, new page load')
  assert.equal(createTenantStore({ storage: stubStorage() }).getState().selectedBusinessId, null, 'sessionStorage is per tab')
})

test('clearing (what logout does) drops the selection and notifies subscribers; invalid selects are refused', () => {
  const storage = stubStorage()
  const store = createTenantStore({ storage })
  let notified = 0
  const off = store.subscribe(() => (notified += 1))
  assert.equal(store.select('not-a-uuid'), false)
  assert.equal(store.select(undefined), false)
  assert.deepEqual(storage.calls.filter(([op]) => op !== 'get'), [], 'an invalid id writes nothing')
  store.select(CHOSEN)
  store.clear()
  assert.equal(store.getState().selectedBusinessId, null)
  assert.ok(!(ACTIVE_BUSINESS_STORAGE_KEY in storage.data))
  assert.equal(notified, 2)
  store.clear()
  assert.equal(notified, 2, 'clearing an empty store is a no-op')
  off()
})

test('the provider clears the selection whenever the user is not authenticated (logout / expired session)', () => {
  const provider = code(read('./BusinessContextProvider.jsx'))
  assert.match(provider, /if \(!isAuthenticated\) store\.clear\(\)/)
  assert.match(provider, /\[isAuthenticated, store\]/)
  assert.match(provider, /window\.sessionStorage/)
})

// ---- request helpers ------------------------------------------------------------------------------------------------------
const READ_PATHS = [
  '/orders/admin?status=NEW',
  '/orders/admin?status=DELIVERED&limit=50',
  '/orders/admin/history?page=1&limit=20&status=CANCELLED',
  '/tables/admin',
  '/categories/admin',
  '/products/admin?page=1&limit=20',
  '/products/admin/summary',
  '/businesses/me',
  '/businesses/me/logo',
]

test('appendQuery adds params with ? or &, encodes them and skips empty values', () => {
  assert.equal(appendQuery('/x', { a: 1 }), '/x?a=1')
  assert.equal(appendQuery('/x?b=2', { a: 'c d' }), '/x?b=2&a=c%20d')
  assert.equal(appendQuery('/x', { a: '', b: null, c: undefined }), '/x')
})

test('ADMIN requests are byte-identical to before: scopePath never touches the path', () => {
  const admin = { businessId: OWN, isBusinessSelectable: false }
  for (const path of READ_PATHS) assert.equal(scopePath(path, admin), path)
  assert.equal(scopePath('/tables/admin', { businessId: null, isBusinessSelectable: false }), '/tables/admin')
})

test('SUPER_ADMIN reads are scoped to the active business; without one nothing unscoped is ever built', () => {
  const sa = { businessId: CHOSEN, isBusinessSelectable: true }
  assert.equal(scopePath('/tables/admin', sa), `/tables/admin?businessId=${CHOSEN}`)
  assert.equal(scopePath('/orders/admin?status=NEW', sa), `/orders/admin?status=NEW&businessId=${CHOSEN}`)
  assert.throws(() => scopePath('/tables/admin', { businessId: null, isBusinessSelectable: true }), NoActiveBusinessError)
  assert.throws(() => scopePath('/tables/admin', { businessId: null, isBusinessSelectable: true }), /Selecciona un negocio/)
})

test('scopeBody fills businessId for creates, never trusts one already in the payload, and does not mutate it', () => {
  const payload = Object.freeze({ name: 'Mesa 1', businessId: OTHER })
  assert.deepEqual(scopeBody(payload, { businessId: OWN, isBusinessSelectable: false }), { name: 'Mesa 1', businessId: OWN })
  assert.deepEqual(scopeBody({ name: 'x' }, { businessId: CHOSEN, isBusinessSelectable: true }), { name: 'x', businessId: CHOSEN })
  assert.equal(payload.businessId, OTHER)
  assert.throws(() => scopeBody({ name: 'x' }, { businessId: null, isBusinessSelectable: true }), NoActiveBusinessError)
})

// ---- the real provider against the real AuthProvider ---------------------------------------------------------------------
let mod
const saved = { localStorage: globalThis.localStorage, window: globalThis.window }
before(async () => {
  mod = await loadModule(`
    import { renderToStaticMarkup } from 'react-dom/server'
    import { AuthProvider } from './context/AuthContext.jsx'
    import { DevToolsProvider } from './devtools/DevToolsProvider.jsx'
    import { useViewAs } from './devtools/useViewAs.js'
    import { BusinessContextProvider } from './tenant/BusinessContextProvider.jsx'
    import { useActiveBusiness } from './tenant/useActiveBusiness.js'
    let captured
    function Probe() {
      const tenant = useActiveBusiness()
      const view = useViewAs()
      captured = tenant
      let scoped = null
      try { scoped = tenant.scopePath('/tables/admin') } catch (e) { scoped = e.name }
      return <pre id="probe">{JSON.stringify({ businessId: tenant.businessId, requires: tenant.requiresBusinessSelection, selectable: tenant.isBusinessSelectable, scoped, view: { real: view.realRole, as: view.viewAsRole, effective: view.effectiveViewRole } })}</pre>
    }
    export const renderAll = () =>
      renderToStaticMarkup(
        <AuthProvider>
          <BusinessContextProvider>
            <DevToolsProvider enabled={true}>
              <Probe />
            </DevToolsProvider>
          </BusinessContextProvider>
        </AuthProvider>,
      )
    export const actions = () => captured
  `)
})
after(() => {
  globalThis.localStorage = saved.localStorage
  globalThis.window = saved.window
})

function renderWith({ user, selection, viewAs, session = true }) {
  const authSession = session ? { accessToken: 'real-token', user } : null
  globalThis.localStorage = stubStorage(authSession ? { brasa47_admin_session: JSON.stringify(authSession) } : {})
  const sessionStorage = stubStorage({
    ...(selection ? { [ACTIVE_BUSINESS_STORAGE_KEY]: selection } : {}),
    ...(viewAs ? { 'brasa47-dev-view-as': viewAs } : {}),
  })
  globalThis.window = { sessionStorage }
  const html = mod.renderAll()
  const probe = JSON.parse(html.match(/<pre id="probe">([\s\S]*?)<\/pre>/)[1].replace(/&quot;/g, '"'))
  return { ...probe, sessionStorage, actions: mod.actions() }
}
const ADMIN_USER = { id: 'u1', email: 'a@b.test', role: 'ADMIN', businessId: OWN }
const SUPER_USER = { id: 'u2', email: 'root@b.test', role: 'SUPER_ADMIN', businessId: null }

test('provider, ADMIN: own business, unchanged paths, a forged selection is ignored and setActiveBusiness is a no-op', () => {
  const r = renderWith({ user: ADMIN_USER, selection: CHOSEN })
  assert.equal(r.businessId, OWN)
  assert.equal(r.requires, false)
  assert.equal(r.selectable, false)
  assert.equal(r.scoped, '/tables/admin', 'no businessId param is ever added for an ADMIN')
  assert.equal(r.actions.setActiveBusiness(OTHER), false)
  assert.equal(r.actions.scopeBody({ name: 'x', businessId: OTHER }).businessId, OWN, 'a create always carries the ADMIN own business')
  assert.deepEqual(r.sessionStorage.calls.filter(([op]) => op === 'set'), [], 'an ADMIN never persists anything')
  assert.equal(r.sessionStorage.data[ACTIVE_BUSINESS_STORAGE_KEY], CHOSEN, 'and the provider does not even rewrite the stale value')
})

test('provider, SUPER_ADMIN without selection: no business, selection required, nothing scoped is built', () => {
  const r = renderWith({ user: SUPER_USER })
  assert.equal(r.businessId, null)
  assert.equal(r.requires, true)
  assert.equal(r.selectable, true)
  assert.equal(r.scoped, 'NoActiveBusinessError')
  assert.throws(() => r.actions.scopeBody({ name: 'x' }), { name: 'NoActiveBusinessError' }) // (the bundled copy is a different class object)
})

test('provider, SUPER_ADMIN with a stored selection: that business, reads scoped to it', () => {
  const r = renderWith({ user: SUPER_USER, selection: CHOSEN })
  assert.equal(r.businessId, CHOSEN)
  assert.equal(r.requires, false)
  assert.equal(r.scoped, `/tables/admin?businessId=${CHOSEN}`)
  assert.equal(r.actions.scopeBody({ name: 'x' }).businessId, CHOSEN)
})

test('provider, SUPER_ADMIN: an invalid stored value is discarded and cleaned', () => {
  const r = renderWith({ user: SUPER_USER, selection: 'definitely-not-a-uuid' })
  assert.equal(r.businessId, null)
  assert.equal(r.requires, true)
  assert.ok(!(ACTIVE_BUSINESS_STORAGE_KEY in r.sessionStorage.data))
})

test('provider, SUPER_ADMIN can choose a valid business (and only a valid one) and clear it', () => {
  const r = renderWith({ user: SUPER_USER })
  assert.equal(r.actions.setActiveBusiness('nope'), false)
  assert.ok(!(ACTIVE_BUSINESS_STORAGE_KEY in r.sessionStorage.data))
  assert.equal(r.actions.setActiveBusiness(CHOSEN), true)
  assert.equal(r.sessionStorage.data[ACTIVE_BUSINESS_STORAGE_KEY], CHOSEN)
  r.actions.clearActiveBusiness()
  assert.ok(!(ACTIVE_BUSINESS_STORAGE_KEY in r.sessionStorage.data))
})

test('logged out: no role, no business, nothing required', () => {
  const r = renderWith({ user: null, session: false })
  assert.equal(r.businessId, null)
  assert.equal(r.requires, false)
  assert.equal(r.selectable, false)
})

// ---- relation with Dev Tools ("Ver como" is visual only) ----------------------------------------------------------------
test('"Ver como" never alters the active business: the REAL role decides, whatever the preview says', () => {
  // real ADMIN previewing SUPER_ADMIN: still their own tenant, still not selectable, paths unchanged
  const asAdmin = renderWith({ user: ADMIN_USER, viewAs: 'SUPER_ADMIN' })
  assert.deepEqual(asAdmin.view, { real: 'ADMIN', as: 'SUPER_ADMIN', effective: 'SUPER_ADMIN' }, 'the preview really is active')
  assert.equal(asAdmin.businessId, OWN)
  assert.equal(asAdmin.selectable, false)
  assert.equal(asAdmin.requires, false)
  assert.equal(asAdmin.scoped, '/tables/admin')
  assert.equal(asAdmin.actions.setActiveBusiness(CHOSEN), false)
  // real SUPER_ADMIN previewing ADMIN: still a SUPER_ADMIN that must choose a business
  const asSuper = renderWith({ user: SUPER_USER, viewAs: 'ADMIN' })
  assert.deepEqual(asSuper.view, { real: 'SUPER_ADMIN', as: 'ADMIN', effective: 'ADMIN' })
  assert.equal(asSuper.businessId, null)
  assert.equal(asSuper.requires, true)
  assert.equal(asSuper.selectable, true)
  // with and without a preview the resolved tenant is identical
  const plain = renderWith({ user: SUPER_USER, selection: CHOSEN })
  const previewed = renderWith({ user: SUPER_USER, selection: CHOSEN, viewAs: 'ADMIN' })
  for (const key of ['businessId', 'requires', 'selectable', 'scoped']) assert.equal(previewed[key], plain[key], key)
})

test('no tenant code or API reads the preview role (viewAsRole / effectiveViewRole / useViewAs / devtools)', () => {
  for (const [name, source] of tenantSources) {
    assert.doesNotMatch(source, /devtools|useViewAs|viewAs|effectiveViewRole|ViewAs/, `tenant/${name}`)
  }
  for (const f of ['../services/api.js', '../services/orderApi.js', '../services/menuApi.js', '../services/tableSessionApi.js', '../context/AuthContext.jsx']) {
    assert.doesNotMatch(code(read(f)), /devtools|viewAs|effectiveViewRole|tenant\//, f)
  }
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(new URL(`${e.name}/`, dir)) : [new URL(e.name, dir)]))
  const both = walk(new URL('../', import.meta.url))
    .filter((u) => /\.(js|jsx)$/.test(u.pathname) && !u.pathname.endsWith('.test.js'))
    .filter((u) => {
      const src = code(readFileSync(u, 'utf8'))
      return /useViewAs|effectiveViewRole|viewAsRole/.test(src) && /useActiveBusiness|scopePath|scopeBody/.test(src)
    })
    .map((u) => u.pathname)
  assert.deepEqual(both, [], 'no file may mix the visual preview role with tenant scoping')
})

// ---- source-level guarantees -----------------------------------------------------------------------------------------------
test('tenant code touches no network, JWT, token or headers, and never localStorage', () => {
  for (const [name, source] of tenantSources) {
    assert.doesNotMatch(source, /apiFetch|\bfetch\(|XMLHttpRequest|Authorization|accessToken|\btoken\b|\bjwt\b|headers/i, `tenant/${name}`)
    assert.doesNotMatch(source, /localStorage/, `tenant/${name}`)
    assert.doesNotMatch(source, /setSession|SESSION_KEY|brasa47_admin_session/, `tenant/${name}`)
  }
  // it only READS the authenticated user
  const provider = code(read('./BusinessContextProvider.jsx'))
  assert.match(provider, /const \{ user, isAuthenticated \} = useAuth\(\)/)
  assert.doesNotMatch(provider, /setSession|login\(|logout/)
  for (const f of ['../services/api.js', '../context/AuthContext.jsx']) assert.doesNotMatch(code(read(f)), /BusinessContext|activeBusiness|useActiveBusiness/, f)
})

test('the Admin no longer reads user.businessId; only the allowed reads go through scopePath, creates through scopeBody', () => {
  const files = ['../pages/admin/AdminMenu.jsx', '../pages/admin/AdminTables.jsx', '../pages/admin/AdminBusiness.jsx', '../pages/admin/AdminPanel.jsx', '../pages/AdminApp.jsx', '../components/admin/OrderHistoryModal.jsx']
  const allowed = new Set(['/orders/admin', '/orders/admin/history', '/tables/admin', '/categories/admin', '/products/admin', '/products/admin/summary', '/businesses/me', '/businesses/me/logo'])
  let scopedCalls = 0 // AdminApp 3 + OrderHistoryModal 1 + AdminTables 1 + AdminMenu 3 + AdminBusiness 3 + AdminPanel 1
  for (const f of files) {
    const src = code(read(f))
    assert.doesNotMatch(src, /user\??\.businessId|businessId:\s*user/, f)
    for (const m of src.matchAll(/scopePath\((['`])([^'`$?]*)/g)) {
      scopedCalls += 1
      assert.ok(allowed.has(m[2]), `${f}: scopePath on ${m[2]}`)
    }
  }
  assert.equal(scopedCalls, 12, 'orders x3 + history, tables, categories, products x2, business x3 (get, patch, logo)')
  // per-id endpoints and updates are never scoped (the backend derives the tenant from the record; businessId in an
  // update would let a SUPER_ADMIN move a product to another business)
  for (const f of files) assert.doesNotMatch(code(read(f)), /scopePath\([^)]*\$\{(editingId|product\.id|category\.id|table\.id|order\.id|productId)\}/, f)
  assert.equal((code(read('../pages/admin/AdminMenu.jsx')).match(/scopeBody\(payload\)/g) ?? []).length, 2)
  assert.equal((code(read('../pages/admin/AdminTables.jsx')).match(/scopeBody\(payload\)/g) ?? []).length, 1)
  assert.doesNotMatch(code(read('../pages/admin/AdminMenu.jsx') + read('../pages/admin/AdminTables.jsx')), /businessId/, 'no hand-built businessId left in the forms flow')
})

test('AdminPanel: a SUPER_ADMIN without a business sees a notice and no panel requests; panels are keyed by business', () => {
  const panel = code(read('../pages/admin/AdminPanel.jsx'))
  assert.match(panel, /requiresBusinessSelection \?/)
  assert.match(panel, /Selecciona un negocio/)
  assert.match(panel, /isAuthenticated && !requiresBusinessSelection/)
  for (const name of ['AdminApp', 'AdminMenu', 'AdminTables', 'AdminBusiness']) assert.match(panel, new RegExp(`<${name} key=\\{businessId\\}`), name)
  const app = code(read('../App.jsx'))
  assert.match(app, /<BusinessContextProvider>\s*<DevToolsProvider/)
  assert.match(app, /<AuthProvider>\s*<BusinessContextProvider>/)
})

test('the customer app and public API have no tenant context (they resolve the business from the table session)', () => {
  for (const f of ['../pages/CustomerApp.jsx', '../services/menuApi.js', '../services/orderApi.js', '../services/tableSessionApi.js']) {
    assert.doesNotMatch(code(read(f)), /useActiveBusiness|BusinessContext|scopePath|scopeBody/, f)
  }
})

test('no new role, no business management UI: only ADMIN and SUPER_ADMIN exist and nothing creates/deletes businesses', () => {
  const core = code(read('./tenantCore.js'))
  assert.deepEqual([...core.matchAll(/ROLE_[A-Z_]+ = '([A-Z_]+)'/g)].map((m) => m[1]).sort(), ['ADMIN', 'SUPER_ADMIN'])
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(new URL(`${e.name}/`, dir)) : [new URL(e.name, dir)]))
  for (const u of walk(new URL('../', import.meta.url)).filter((x) => /\.(js|jsx)$/.test(x.pathname) && !x.pathname.endsWith('.test.js'))) {
    assert.doesNotMatch(code(readFileSync(u, 'utf8')), /apiFetch\(['`]\/businesses['`]|impersonat|\/users['`/]/i, u.pathname)
  }
})
