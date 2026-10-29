import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { loadModule } from '../theme/testSupport.js'
import { ACTIVE_BUSINESS_STORAGE_KEY, isBusinessSelectableRole, normalizeBusinessId, normalizeSelection, readActiveBusiness, resolveActiveBusiness, selectionFor, writeActiveBusiness } from './tenantCore.js'
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
const SUPER_ID = 'u2' // the SUPER_ADMIN used by the provider tests below
const SEL = { userId: SUPER_ID, businessId: CHOSEN } // a selection is bound to the user who made it

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
  for (const bad of ['nope', '', '{"id":"x"}', '../../x', CHOSEN /* the old plain-id format */, JSON.stringify({ userId: 'u2', businessId: 'nope' }), JSON.stringify({ userId: '', businessId: CHOSEN }), JSON.stringify({ businessId: CHOSEN }), 'null']) {
    const storage = stubStorage({ [ACTIVE_BUSINESS_STORAGE_KEY]: bad })
    assert.equal(readActiveBusiness(storage), null, bad)
    assert.ok(!(ACTIVE_BUSINESS_STORAGE_KEY in storage.data), `${bad} removed`)
  }
  assert.equal(readActiveBusiness(null), null)
  assert.equal(readActiveBusiness({ getItem() { throw new Error('blocked') } }), null)
  assert.equal(writeActiveBusiness({ setItem() { throw new Error('blocked') } }, SEL), false)
})

test('a selection is bound to the identity that made it: it only applies to that same user', () => {
  assert.deepEqual(normalizeSelection({ userId: ' u2 ', businessId: CHOSEN.toUpperCase() }), SEL)
  assert.equal(selectionFor(SEL, SUPER_ID), CHOSEN)
  for (const other of ['u3', '', null, undefined, 2]) assert.equal(selectionFor(SEL, other), null, String(other))
  assert.equal(selectionFor(null, SUPER_ID), null)
  assert.equal(selectionFor({ userId: SUPER_ID, businessId: 'nope' }, SUPER_ID), null)
})

test('the selection persists only for this tab/session: survives a refresh, a new tab starts empty', () => {
  const tab = stubStorage()
  const a = createTenantStore({ storage: tab })
  assert.equal(a.getState().selection, null)
  assert.equal(a.select(SEL), true)
  assert.equal(tab.data[ACTIVE_BUSINESS_STORAGE_KEY], JSON.stringify(SEL))
  assert.deepEqual(createTenantStore({ storage: tab }).getState().selection, SEL, 'same tab, new page load')
  assert.equal(createTenantStore({ storage: stubStorage() }).getState().selection, null, 'sessionStorage is per tab')
})

test('clearing (what logout does) drops the selection and notifies subscribers; invalid selects are refused', () => {
  const storage = stubStorage()
  const store = createTenantStore({ storage })
  let notified = 0
  const off = store.subscribe(() => (notified += 1))
  for (const bad of ['not-a-uuid', undefined, null, CHOSEN, { userId: SUPER_ID, businessId: 'nope' }, { userId: '', businessId: CHOSEN }]) assert.equal(store.select(bad), false, JSON.stringify(bad))
  assert.deepEqual(storage.calls.filter(([op]) => op !== 'get'), [], 'an invalid selection writes nothing')
  store.select(SEL)
  store.clear()
  assert.equal(store.getState().selection, null)
  assert.ok(!(ACTIVE_BUSINESS_STORAGE_KEY in storage.data))
  assert.equal(notified, 2)
  store.clear()
  assert.equal(notified, 2, 'clearing an empty store is a no-op')
  off()
})

test('the provider clears the selection whenever the user is not authenticated (logout / expired session)', () => {
  const provider = code(read('./BusinessContextProvider.jsx'))
  assert.match(provider, /if \(!isAuthenticated\) \{\s*store\.clear\(\)/)
  assert.match(provider, /\[isAuthenticated, selection, selectedBusinessId, store\]/)
  assert.match(provider, /window\.sessionStorage/)
  // and a selection made by another identity is dropped, never reused
  assert.match(provider, /selection !== null && selectedBusinessId === null/)
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
      return <pre id="probe">{JSON.stringify({ businessId: tenant.businessId, requires: tenant.requiresBusinessSelection, selectable: tenant.isBusinessSelectable, ready: tenant.isBusinessReady, scoped, view: { real: view.realRole, as: view.viewAsRole, effective: view.effectiveViewRole } })}</pre>
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

// `selection`: an object (stored as JSON, as the app does) or a raw string (to test tampered values)
function renderWith({ user, selection, viewAs, session = true }) {
  const authSession = session ? { accessToken: 'real-token', user } : null
  globalThis.localStorage = stubStorage(authSession ? { brasa47_admin_session: JSON.stringify(authSession) } : {})
  const sessionStorage = stubStorage({
    ...(selection ? { [ACTIVE_BUSINESS_STORAGE_KEY]: typeof selection === 'string' ? selection : JSON.stringify(selection) } : {}),
    ...(viewAs ? { 'brasa47-dev-view-as': viewAs } : {}),
  })
  globalThis.window = { sessionStorage }
  const html = mod.renderAll()
  const probe = JSON.parse(html.match(/<pre id="probe">([\s\S]*?)<\/pre>/)[1].replace(/&quot;/g, '"'))
  return { ...probe, sessionStorage, actions: mod.actions() }
}
const ADMIN_USER = { id: 'u1', email: 'a@b.test', role: 'ADMIN', businessId: OWN }
const SUPER_USER = { id: SUPER_ID, email: 'root@b.test', role: 'SUPER_ADMIN', businessId: null }

test('provider, ADMIN: own business, unchanged paths, a forged selection is ignored and setActiveBusiness is a no-op', () => {
  const forged = { userId: ADMIN_USER.id, businessId: CHOSEN } // even one 'made by' the ADMIN
  const r = renderWith({ user: ADMIN_USER, selection: forged })
  assert.equal(r.businessId, OWN)
  assert.equal(r.requires, false)
  assert.equal(r.selectable, false)
  assert.equal(r.ready, true, 'an ADMIN business is always ready: no extra step, no extra request')
  assert.equal(r.scoped, '/tables/admin', 'no businessId param is ever added for an ADMIN')
  assert.equal(r.actions.setActiveBusiness(OTHER), false)
  assert.equal(r.actions.scopeBody({ name: 'x', businessId: OTHER }).businessId, OWN, 'a create always carries the ADMIN own business')
  assert.deepEqual(r.sessionStorage.calls.filter(([op]) => op === 'set'), [], 'an ADMIN never persists anything')
  assert.equal(r.sessionStorage.data[ACTIVE_BUSINESS_STORAGE_KEY], JSON.stringify(forged), 'and the provider does not even rewrite the stale value')
})

test('provider, SUPER_ADMIN without selection: no business, selection required, nothing scoped is built', () => {
  const r = renderWith({ user: SUPER_USER })
  assert.equal(r.businessId, null)
  assert.equal(r.requires, true)
  assert.equal(r.selectable, true)
  assert.equal(r.ready, false)
  assert.equal(r.scoped, 'NoActiveBusinessError')
  assert.throws(() => r.actions.scopeBody({ name: 'x' }), { name: 'NoActiveBusinessError' }) // (the bundled copy is a different class object)
})

test('provider, SUPER_ADMIN with a stored selection: that business, reads scoped to it, but NOT ready until verified', () => {
  const r = renderWith({ user: SUPER_USER, selection: SEL })
  assert.equal(r.businessId, CHOSEN)
  assert.equal(r.requires, false)
  assert.equal(r.ready, false, 'a restored selection must be verified (exists + active) before any panel loads data')
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
  assert.equal(r.sessionStorage.data[ACTIVE_BUSINESS_STORAGE_KEY], JSON.stringify(SEL), 'stored together with the identity that made it')
  r.actions.clearActiveBusiness()
  assert.ok(!(ACTIVE_BUSINESS_STORAGE_KEY in r.sessionStorage.data))
})

test('provider, SUPER_ADMIN: a selection made by ANOTHER identity is never reused', () => {
  const r = renderWith({ user: SUPER_USER, selection: { userId: 'someone-else', businessId: CHOSEN } })
  assert.equal(r.businessId, null)
  assert.equal(r.requires, true)
  assert.equal(r.ready, false)
  assert.equal(r.scoped, 'NoActiveBusinessError')
})

test('confirmActiveBusiness only validates the CURRENT selection of a SUPER_ADMIN: another id, an ADMIN or no user change nothing', () => {
  const provider = code(read('./BusinessContextProvider.jsx'))
  assert.match(provider, /if \(isBusinessSelectable && userId && id === businessId\) setValidated\(\{ userId, businessId: id \}\)/)
  // ready = verified for THIS user and THIS business; an ADMIN's own business is always ready
  assert.match(provider, /validated\?\.userId === userId && validated\?\.businessId === businessId/)
  assert.match(provider, /: businessId !== null\n/)
  const admin = renderWith({ user: ADMIN_USER })
  admin.actions.confirmActiveBusiness(OWN) // a no-op for an ADMIN
  assert.equal(admin.ready, true)
  const sa = renderWith({ user: SUPER_USER, selection: SEL })
  assert.equal(sa.ready, false, 'a restored selection is not ready until the gate verifies it')
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
  const plain = renderWith({ user: SUPER_USER, selection: SEL })
  const previewed = renderWith({ user: SUPER_USER, selection: SEL, viewAs: 'ADMIN' })
  for (const key of ['businessId', 'requires', 'selectable', 'ready', 'scoped']) assert.equal(previewed[key], plain[key], key)
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
  const allowed = new Set(['/orders/admin', '/orders/admin/history', '/tables/admin', '/categories/admin', '/categories/order', '/products/admin', '/products/admin/summary', '/businesses/me', '/businesses/me/logo', '/businesses/me/cover'])
  let scopedCalls = 0 // AdminApp 3 + OrderHistoryModal 1 + AdminTables 2 (tables, my business for the public link) + AdminMenu 4 (categories, categories order, products x2) + AdminBusiness 2 (get, patch) + AdminPanel 1
  for (const f of files) {
    const src = code(read(f))
    assert.doesNotMatch(src, /user\??\.businessId|businessId:\s*user/, f)
    for (const m of src.matchAll(/scopePath\((['`])([^'`$?]*)/g)) {
      scopedCalls += 1
      assert.ok(allowed.has(m[2]), `${f}: scopePath on ${m[2]}`)
    }
  }
  assert.equal(scopedCalls, 13, 'orders x3 + history, tables, categories, categories order, products x2, business x3 (tables link, get, patch)')
  // the business IMAGES (logo / cover) go through ONE scoped request function (AdminBusiness: scopePath(path)), and the only paths
  // the images store ever asks for are these (all of them "my business" routes that accept ?businessId= for a SUPER_ADMIN)
  assert.match(code(read('../pages/admin/AdminBusiness.jsx')), /apiFetch\(scopePath\(path\), \{ token, \.\.\.options \}\)/)
  const imagePaths = [...code(read('../branding/imageOpsStore.js')).matchAll(/path: '([^']+)'/g)].map((m) => m[1])
  assert.deepEqual([...new Set(imagePaths)].sort(), ['/businesses/me/cover', '/businesses/me/logo'])
  for (const p of imagePaths) assert.ok(allowed.has(p), p)
  // per-id endpoints and updates are never scoped (the backend derives the tenant from the record; businessId in an
  // update would let a SUPER_ADMIN move a product to another business)
  for (const f of files) assert.doesNotMatch(code(read(f)), /scopePath\([^)]*\$\{(editingId|product\.id|category\.id|table\.id|order\.id|productId)\}/, f)
  assert.equal((code(read('../pages/admin/AdminMenu.jsx')).match(/scopeBody\(payload\)/g) ?? []).length, 2)
  assert.equal((code(read('../pages/admin/AdminTables.jsx')).match(/scopeBody\(payload\)/g) ?? []).length, 1)
  assert.doesNotMatch(code(read('../pages/admin/AdminMenu.jsx') + read('../pages/admin/AdminTables.jsx')), /businessId/, 'no hand-built businessId left in the forms flow')
})

test('AdminPanel: only a SUPER_ADMIN goes through the selector gate; an ADMIN renders the panels directly; panels are keyed by business', () => {
  const panel = code(read('../pages/admin/AdminPanel.jsx'))
  assert.match(panel, /isBusinessSelectable \? <BusinessGate onBusiness=\{setBusiness\}>\{panels\}<\/BusinessGate> : panels/)
  // an ADMIN keeps loading the business for the header exactly as before; for a SUPER_ADMIN the gate verifies + loads it
  assert.match(panel, /isAuthenticated && !isBusinessSelectable/)
  for (const name of ['AdminApp', 'AdminMenu', 'AdminTables', 'AdminBusiness']) assert.match(panel, new RegExp(`<${name} key=\\{businessId\\}`), name)
  const app = code(read('../App.jsx'))
  assert.match(app, /<BusinessContextProvider>\s*<DevToolsProvider/)
  assert.match(app, /<AuthProvider endsSessionOnSuspension=\{suspensionEndsSession\}>\s*<BusinessContextProvider>/)
})

test('the customer app and public API have no tenant context (they resolve the business from the table session)', () => {
  for (const f of ['../pages/CustomerApp.jsx', '../services/menuApi.js', '../services/orderApi.js', '../services/tableSessionApi.js']) {
    assert.doesNotMatch(code(read(f)), /useActiveBusiness|BusinessContext|scopePath|scopeBody/, f)
  }
})

test('no new role, no impersonation: only ADMIN and SUPER_ADMIN exist and exactly ONE module creates businesses (POST /businesses, 9B)', () => {
  const core = code(read('./tenantCore.js'))
  assert.deepEqual([...core.matchAll(/ROLE_[A-Z_]+ = '([A-Z_]+)'/g)].map((m) => m[1]).sort(), ['ADMIN', 'SUPER_ADMIN'])
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(new URL(`${e.name}/`, dir)) : [new URL(e.name, dir)]))
  const creators = []
  for (const u of walk(new URL('../', import.meta.url)).filter((x) => /\.(js|jsx)$/.test(x.pathname) && !x.pathname.endsWith('.test.js'))) {
    const source = code(readFileSync(u, 'utf8'))
    // impersonation and the /users endpoints stay absent EVERYWHERE, the creation module included
    assert.doesNotMatch(source, /impersonat|\/users['`/]/i, u.pathname)
    if (/apiFetch\(['`]\/businesses['`]/.test(source)) creators.push(u.pathname.split('/src/')[1])
  }
  assert.deepEqual(creators, ['tenant/creation/businessCreateApi.js'], 'the only caller of POST /businesses')
})
