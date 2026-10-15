import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { contrastRatio } from '../theme/color.js'
import { loadModule } from '../theme/testSupport.js'
import { KNOWN_ROLES, VIEW_AS_STORAGE_KEY, effectiveViewRole, isSimulating, normalizeViewAs, readViewAs, writeViewAs } from './viewAsCore.js'
import { createViewAsStore } from './viewAsStore.js'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
// code only: comments may legitimately name the things the code must not touch ("never localStorage")
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const devtoolsDir = new URL('.', import.meta.url)
const devtoolsSources = readdirSync(devtoolsDir)
  .filter((f) => /\.(js|jsx)$/.test(f) && !f.endsWith('.test.js'))
  .map((f) => [f, code(read(`./${f}`))])

// sessionStorage / localStorage stand-in that counts every touch
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

// ---- roles -----------------------------------------------------------------------------------------------------
test('KNOWN_ROLES is exactly the backend UserRole enum (no invented roles)', () => {
  const enumSource = readFileSync(new URL('../../backend/src/user/user-role.enum.ts', import.meta.url), 'utf8')
  const backend = [...enumSource.matchAll(/(\w+)\s*=\s*'(\w+)'/g)].map((m) => m[2])
  assert.deepEqual([...KNOWN_ROLES].sort(), [...backend].sort())
  for (const invented of ['MANAGER', 'WAITER', 'KITCHEN', 'CUSTOMER']) assert.ok(!KNOWN_ROLES.includes(invented), invented)
})

test('normalizeViewAs accepts only known roles; everything else means Real', () => {
  assert.equal(normalizeViewAs('ADMIN'), 'ADMIN')
  assert.equal(normalizeViewAs('SUPER_ADMIN'), 'SUPER_ADMIN')
  for (const bad of ['admin', 'ROOT', '', ' ADMIN', null, undefined, 1, {}, ['ADMIN'], 'CUSTOMER']) assert.equal(normalizeViewAs(bad), null, String(bad))
})

test('effectiveViewRole / isSimulating: the preview never replaces the real role', () => {
  assert.equal(effectiveViewRole('ADMIN', null), 'ADMIN')
  assert.equal(effectiveViewRole('ADMIN', 'SUPER_ADMIN'), 'SUPER_ADMIN')
  assert.equal(effectiveViewRole(null, null), null)
  assert.equal(isSimulating('ADMIN', null), false)
  assert.equal(isSimulating('ADMIN', 'ADMIN'), false, 'previewing your own role is just "Real"')
  assert.equal(isSimulating('ADMIN', 'SUPER_ADMIN'), true)
})

// ---- persistence -------------------------------------------------------------------------------------------------
test('an invalid value in sessionStorage falls back to Real and is cleaned up', () => {
  for (const bad of ['GOD', 'admin', '', '{"role":"ADMIN"}']) {
    const storage = stubStorage({ [VIEW_AS_STORAGE_KEY]: bad })
    assert.equal(readViewAs(storage), null, bad)
    assert.ok(!(VIEW_AS_STORAGE_KEY in storage.data), `${bad} removed`)
  }
  assert.equal(readViewAs(null), null)
  assert.equal(readViewAs({ getItem() { throw new Error('blocked') } }), null)
  assert.equal(writeViewAs({ setItem() { throw new Error('blocked') } }, 'ADMIN'), false)
})

test('the store persists in sessionStorage, survives a refresh, and a new tab starts on Real', () => {
  const tab = stubStorage()
  const a = createViewAsStore({ enabled: true, storage: tab })
  assert.equal(a.getState().viewAsRole, null, 'starts on Real')
  a.setViewAs('SUPER_ADMIN')
  assert.equal(tab.data[VIEW_AS_STORAGE_KEY], 'SUPER_ADMIN')
  const refreshed = createViewAsStore({ enabled: true, storage: tab }) // same tab, new page load
  assert.equal(refreshed.getState().viewAsRole, 'SUPER_ADMIN')
  const newTab = createViewAsStore({ enabled: true, storage: stubStorage() }) // sessionStorage is per tab
  assert.equal(newTab.getState().viewAsRole, null)
  a.setViewAs('nonsense')
  assert.equal(a.getState().viewAsRole, null)
  assert.ok(!(VIEW_AS_STORAGE_KEY in tab.data))
})

test('reset (logout) drops the preview, clears storage and notifies subscribers', () => {
  const storage = stubStorage()
  const store = createViewAsStore({ enabled: true, storage })
  let notified = 0
  const off = store.subscribe(() => (notified += 1))
  store.setViewAs('ADMIN')
  store.reset()
  assert.equal(store.getState().viewAsRole, null)
  assert.ok(!(VIEW_AS_STORAGE_KEY in storage.data))
  assert.equal(notified, 2)
  store.reset()
  assert.equal(notified, 2, 'resetting an already-Real store is a no-op')
  off()
})

test('the provider resets the preview whenever the user is not authenticated (logout / expired session)', () => {
  const provider = read('./DevToolsProvider.jsx')
  assert.match(provider, /if \(!isAuthenticated\) store\.reset\(\)/)
  assert.match(provider, /\[isAuthenticated, store\]/)
})

test('the preview lives in sessionStorage only, never localStorage', () => {
  for (const [name, source] of devtoolsSources) {
    assert.doesNotMatch(source, /localStorage/, name)
  }
  assert.match(code(read('./DevToolsProvider.jsx')), /window\.sessionStorage/)
})

test('with dev tools OFF the store is completely inert: no storage access, setViewAs ignored', () => {
  const storage = stubStorage({ [VIEW_AS_STORAGE_KEY]: 'SUPER_ADMIN' })
  const store = createViewAsStore({ enabled: false, storage })
  assert.equal(store.getState().viewAsRole, null, 'a stale stored value is ignored')
  store.setViewAs('ADMIN')
  store.reset()
  assert.equal(store.getState().viewAsRole, null)
  assert.deepEqual(storage.calls, [], 'never reads or writes storage')
})

// ---- rendering: provider + hooks against the REAL AuthProvider ---------------------------------------------------
let mod
const realSession = { accessToken: 'real-token-abc', user: { id: 'u1', email: 'a@b.test', role: 'ADMIN', businessId: 'b1' } }
const saved = { localStorage: globalThis.localStorage, window: globalThis.window }
before(async () => {
  mod = await loadModule(`
    import { renderToStaticMarkup } from 'react-dom/server'
    import { AuthProvider, useAuth } from './context/AuthContext.jsx'
    import { DevToolsProvider } from './devtools/DevToolsProvider.jsx'
    import { ViewAsBanner, ViewAsSelector } from './devtools/DevToolsUi.jsx'
    import { useViewAs } from './devtools/useViewAs.js'
    function Probe() {
      const auth = useAuth()
      const view = useViewAs()
      return <pre id="probe">{JSON.stringify({ auth: { user: auth.user, token: auth.token, isAuthenticated: auth.isAuthenticated }, view })}</pre>
    }
    export const renderAll = (enabled) =>
      renderToStaticMarkup(
        <AuthProvider>
          <DevToolsProvider enabled={enabled}>
            <ViewAsBanner />
            <ViewAsSelector />
            <Probe />
          </DevToolsProvider>
        </AuthProvider>,
      )
  `)
})
after(() => {
  globalThis.localStorage = saved.localStorage
  globalThis.window = saved.window
})
function renderWith({ enabled, viewAs, session = realSession }) {
  globalThis.localStorage = stubStorage(session ? { brasa47_admin_session: JSON.stringify(session) } : {})
  globalThis.window = { sessionStorage: stubStorage(viewAs ? { [VIEW_AS_STORAGE_KEY]: viewAs } : {}) }
  const html = mod.renderAll(enabled)
  const probe = JSON.parse(html.match(/<pre id="probe">([\s\S]*?)<\/pre>/)[1].replace(/&quot;/g, '"'))
  return { html, ...probe }
}

test('changing viewAsRole does not alter the authenticated user, token or claims', () => {
  const real = renderWith({ enabled: true, viewAs: null })
  const previewing = renderWith({ enabled: true, viewAs: 'SUPER_ADMIN' })
  assert.deepEqual(previewing.auth, real.auth, 'AuthContext is byte-for-byte the same')
  assert.equal(previewing.auth.user.role, 'ADMIN', 'the real role is untouched')
  assert.deepEqual(previewing.auth.user, realSession.user)
  assert.equal(previewing.auth.token, realSession.accessToken, 'same token, no new JWT, no rewritten claims')
  assert.equal(previewing.view.realRole, 'ADMIN')
  assert.equal(previewing.view.viewAsRole, 'SUPER_ADMIN')
  assert.equal(previewing.view.effectiveViewRole, 'SUPER_ADMIN')
  assert.equal(previewing.view.isSimulating, true)
  assert.equal(real.view.effectiveViewRole, 'ADMIN')
})

test('API headers are unaffected by the preview: only the real token is ever sent, no role header', async () => {
  const api = await loadModule(`export { apiFetch } from './services/api.js'`)
  const seen = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => (seen.push({ url, headers: init.headers }), { ok: true, status: 200, json: async () => ({}) })
  try {
    renderWith({ enabled: true, viewAs: 'SUPER_ADMIN' }) // a preview is active while the request is made
    await api.apiFetch('/orders/admin', { token: realSession.accessToken })
  } finally {
    globalThis.fetch = realFetch
  }
  assert.deepEqual(Object.keys(seen[0].headers).sort(), ['Authorization', 'Content-Type'])
  assert.equal(seen[0].headers.Authorization, `Bearer ${realSession.accessToken}`)
})

test('the network layer and AuthContext know nothing about the preview, and devtools never touch them', () => {
  for (const file of ['../services/api.js', '../context/AuthContext.jsx', '../services/orderApi.js', '../services/menuApi.js']) {
    assert.doesNotMatch(read(file), /devtools|viewAs|ViewAs/, file)
  }
  for (const [name, source] of devtoolsSources) {
    assert.doesNotMatch(source, /apiFetch|\bfetch\(|Authorization|accessToken|setSession|SESSION_KEY|brasa47_admin_session/, name)
  }
  // it only READS the authenticated role
  assert.match(code(read('./DevToolsProvider.jsx')), /const \{ user, isAuthenticated \} = useAuth\(\)/)
  assert.doesNotMatch(code(read('./DevToolsProvider.jsx')), /\btoken\b/)
})

test('nothing is persisted in the backend: no request is ever made from the devtools code', () => {
  for (const [name, source] of devtoolsSources) {
    assert.doesNotMatch(source, /XMLHttpRequest|sendBeacon|WebSocket|axios/, name)
    assert.doesNotMatch(source, /services\//, name)
  }
})

test('dev tools OFF: no selector, no banner, even if a stale preview is stored', () => {
  const off = renderWith({ enabled: false, viewAs: 'SUPER_ADMIN' })
  assert.doesNotMatch(off.html, /Ver como|Vista previa|devtools-/)
  assert.equal(off.view.viewAsRole, null)
  assert.equal(off.view.isSimulating, false)
  assert.equal(off.view.effectiveViewRole, 'ADMIN', 'effective role equals the real role')
})

test('dev tools ON: selector with Real + only the real roles; banner only while simulating', () => {
  const idle = renderWith({ enabled: true, viewAs: null })
  assert.match(idle.html, /Ver como/)
  assert.match(idle.html, /Real \(ADMIN\)/)
  assert.deepEqual([...idle.html.matchAll(/<option value="([A-Z_]*)"/g)].map((m) => m[1]), ['', 'ADMIN', 'SUPER_ADMIN'])
  assert.doesNotMatch(idle.html, /devtools-banner/)
  const preview = renderWith({ enabled: true, viewAs: 'SUPER_ADMIN' })
  assert.match(preview.html, /Vista previa: SUPER_ADMIN/)
  assert.match(preview.html, /Volver a mi vista/)
  assert.match(preview.html, /role="status"/)
  const same = renderWith({ enabled: true, viewAs: 'ADMIN' })
  assert.doesNotMatch(same.html, /devtools-banner/, 'previewing your own role is not a simulation')
})

test('an invalid value in sessionStorage renders as Real', () => {
  const r = renderWith({ enabled: true, viewAs: 'ROOT' })
  assert.equal(r.view.viewAsRole, null)
  assert.doesNotMatch(r.html, /devtools-banner/)
})

test('logged out: no real role, nothing to preview', () => {
  const r = renderWith({ enabled: true, viewAs: null, session: null })
  assert.equal(r.view.realRole, null)
  assert.equal(r.view.effectiveViewRole, null)
  assert.equal(r.auth.isAuthenticated, false)
})

// ---- gate + integration ----------------------------------------------------------------------------------------------
test('the gate is VITE_DEV_TOOLS_ENABLED, off by default, and independent from the dark-mode preview flag', () => {
  const gate = code(read('./buildFlag.js'))
  assert.match(gate, /import\.meta\.env\.VITE_DEV_TOOLS_ENABLED === '1'/)
  for (const [name, source] of devtoolsSources) assert.doesNotMatch(source, /VITE_DARK_MODE_PREVIEW|theme\/flag/, name)
  assert.doesNotMatch(read('../theme/flag.js'), /DEV_TOOLS/)
  assert.match(read('../../.env.example'), /# VITE_DEV_TOOLS_ENABLED=/, 'documented but commented out: off unless someone opts in')
})

test('the Admin only loads the toolbar through the build gate (lazy, so it is dropped when the gate is off)', () => {
  const panel = read('../pages/admin/AdminPanel.jsx')
  assert.match(panel, /const ViewAsSelector = DEV_TOOLS_BUILD_ENABLED\s*\?\s*lazy\(/)
  assert.match(panel, /const ViewAsBanner = DEV_TOOLS_BUILD_ENABLED\s*\?\s*lazy\(/)
  assert.doesNotMatch(panel.replace(/lazy\(\(\) => import\([^)]*DevToolsUi[^)]*\)/g, ''), /DevToolsUi/, 'no static import of the UI')
  assert.match(read('../App.jsx'), /<DevToolsProvider enabled=\{DEV_TOOLS_BUILD_ENABLED\}>/)
  // the customer app has no dev tools at all
  assert.doesNotMatch(read('../pages/CustomerApp.jsx'), /devtools|DevTools|useViewAs/)
})

test('today no UI reads the preview role: the toolbar is infrastructure, differences list is empty and honest', () => {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(new URL(`${e.name}/`, dir)) : [new URL(e.name, dir)]))
  const consumers = walk(new URL('../', import.meta.url))
    .filter((u) => /\.(js|jsx)$/.test(u.pathname) && !u.pathname.endsWith('.test.js') && !u.pathname.includes('/src/devtools/'))
    .filter((u) => /effectiveViewRole|useViewAs/.test(readFileSync(u, 'utf8')))
  assert.deepEqual(consumers, [], 'first real consumer: list it in devtools/roleDifferences.js')
  assert.deepEqual(read('./roleDifferences.js').match(/ROLE_VISUAL_DIFFERENCES = \[\]/) !== null, true)
  // and no component in the app reads user.role yet
  const rolereaders = walk(new URL('../', import.meta.url))
    .filter((u) => /\.(js|jsx)$/.test(u.pathname) && !u.pathname.endsWith('.test.js') && !u.pathname.includes('/src/devtools/'))
    .filter((u) => /user\??\.role|\.role ===|SUPER_ADMIN/.test(readFileSync(u, 'utf8')))
  assert.deepEqual(rolereaders, [])
})

// ---- light / dark -----------------------------------------------------------------------------------------------------
test('devtools styles use only theme tokens; banner and button are AA in both themes', () => {
  const css = readFileSync(new URL('../styles/devtools.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|:\s*(white|black)\b/)
  const tokens = read('../styles/tokens.css')
  const block = (selector) => {
    const start = tokens.indexOf(`${selector} {`)
    const out = {}
    for (const m of tokens.slice(start, tokens.indexOf('}', start)).matchAll(/(--[a-z-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim()
    return out
  }
  const light = block(':root')
  const dark = { ...light, ...block(':root[data-theme="dark"]') }
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    assert.ok(contrastRatio(t['--on-warning'], t['--warning']) >= 4.5, `${name} banner text`)
    assert.ok(contrastRatio(t['--warning'], t['--on-warning']) >= 4.5, `${name} reset button (inverse of the banner)`)
  }
  assert.match(css, /\.devtools-banner \{[^}]*background:\s*var\(--warning\)[^}]*color:\s*var\(--on-warning\)/)
  assert.match(css, /@media print \{[^}]*\.devtools-banner/)
})
