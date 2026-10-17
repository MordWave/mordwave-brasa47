import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import { SUSPENDED_MESSAGE } from '../context/suspension.js'
import { loadModule } from '../theme/testSupport.js'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// The REAL AdminPanel, ForcedPasswordChange, PasswordChangeForm and AdminLogin rendered to static markup, with only the parts
// that need a live session/network stubbed: the AuthContext hook (what the server told the app about the user), the
// tenant hook, the selector gate and the four panels (each just a marker, so "which screen is mounted" is observable).
const STUBS = {
  'context/AuthContext': 'export const useAuth = () => globalThis.__auth',
  'tenant/useActiveBusiness': 'export const useActiveBusiness = () => globalThis.__tenant',
  'tenant/selector/BusinessGate': "export default function BusinessGate({ children }) { return <div id=\"gate\">GATE{children}</div> }",
  AdminApp: "export default function AdminApp() { return <p id=\"panel-pedidos\">PANEL-PEDIDOS</p> }",
  AdminMenu: "export default function AdminMenu() { return <p id=\"panel-menu\">PANEL-MENU</p> }",
  AdminTables: "export default function AdminTables() { return <p id=\"panel-mesas\">PANEL-MESAS</p> }",
  AdminBusiness: "export default function AdminBusiness() { return <p id=\"panel-negocio\">PANEL-NEGOCIO</p> }",
  'components/ThemeToggle': "export default function ThemeToggle() { return <i className=\"theme-toggle-stub\" /> }",
}
const stubPlugin = {
  name: 'stubs',
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      for (const key of Object.keys(STUBS)) {
        if (new RegExp(`(^|/)${key.replace(/\//g, '\\/')}(\\.jsx)?$`).test(args.path)) return { path: key, namespace: 'stub' }
      }
      return null
    })
    build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: STUBS[args.path], loader: 'jsx', resolveDir: fileURLToPath(new URL('..', import.meta.url)) }))
  },
}

let mod
before(async () => {
  mod = await loadModule(
    `
    import { renderToStaticMarkup } from 'react-dom/server'
    import AdminPanel from './pages/admin/AdminPanel.jsx'
    import PasswordChangeForm from './account/PasswordChangeForm.jsx'
    export const renderPanel = () => renderToStaticMarkup(<AdminPanel />)
    export const renderForm = (store, email) => renderToStaticMarkup(<PasswordChangeForm store={store} email={email} onCancel={() => {}} />)
  `,
    { plugins: [stubPlugin] },
  )
})
after(() => {
  delete globalThis.__auth
  delete globalThis.__tenant
})

const ADMIN = { id: 'u1', email: 'admin@brasa47.cl', role: 'ADMIN', businessId: 'b1', active: true, mustChangePassword: false }
const SUPER = { id: 'u2', email: 'root@mordwave.cl', role: 'SUPER_ADMIN', businessId: null, active: true, mustChangePassword: false }
const noop = () => {}
function panelFor(user, { selectable, authenticated = true, checking = false, suspended = false } = {}) {
  globalThis.__auth = { isAuthenticated: authenticated, checking, suspended, user, token: 'tok', logout: noop, login: noop, changePassword: noop }
  globalThis.__tenant = { businessId: selectable ? null : 'b1', isBusinessSelectable: Boolean(selectable), scopePath: (p) => p }
  return mod.renderPanel()
}

test('an ADMIN without the obligation sees the normal panel — tabs, header and the "Cambiar contraseña" option — and no gate', () => {
  const html = panelFor(ADMIN)
  assert.match(html, /Panel administrativo/)
  assert.match(html, />Pedidos</)
  assert.match(html, /PANEL-PEDIDOS/)
  assert.match(html, />Cambiar contraseña</, 'the voluntary option is there')
  assert.match(html, />Cerrar sesión</)
  assert.doesNotMatch(html, /id="gate"|Debes cambiar tu contraseña/)
})

test('a SUPER_ADMIN without the obligation goes through the selector gate, and has the voluntary option too', () => {
  const html = panelFor(SUPER, { selectable: true })
  assert.match(html, /id="gate"/)
  assert.match(html, />Cambiar contraseña</)
  assert.doesNotMatch(html, /Debes cambiar tu contraseña/)
})

test('mustChangePassword = true (ADMIN): ONLY the forced screen is rendered — no panels, no tabs, no header, no gate', () => {
  const html = panelFor({ ...ADMIN, mustChangePassword: true })
  assert.match(html, /Debes cambiar tu contraseña/)
  assert.match(html, /admin@brasa47\.cl/)
  assert.match(html, /Contraseña actual/)
  assert.match(html, /Nueva contraseña/)
  assert.match(html, /Confirma la nueva contraseña/)
  assert.match(html, />Cerrar sesión</, 'logging out is possible from the forced screen')
  for (const forbidden of [/PANEL-/, /id="gate"/, /Panel administrativo/, />Pedidos</, />Menú</, /admin-panel__tabs/, />Cambiar contraseña</]) assert.doesNotMatch(html, forbidden)
  assert.match(html, /theme-toggle-stub/, 'the theme (light / dark / system) toggle is available on this screen too')
})

test('mustChangePassword = true (SUPER_ADMIN): the same forced screen, and the business selector is never mounted', () => {
  const html = panelFor({ ...SUPER, mustChangePassword: true }, { selectable: true })
  assert.match(html, /Debes cambiar tu contraseña/)
  assert.doesNotMatch(html, /id="gate"|PANEL-|Selecciona un negocio|Panel administrativo/)
})

test('direct access to the admin URL with the flag set changes nothing: the panel decides from the session user, never from the URL', () => {
  const panel = code(read('../pages/admin/AdminPanel.jsx'))
  assert.doesNotMatch(panel, /location|URLSearchParams|history\.|searchParams|hash/, 'no query, hash or path can open the panel')
  const app = code(read('../App.jsx'))
  assert.match(app, /window\.location\.pathname\.replace\(\/\\\/\+\$\/, ''\) === '\/admin'/, 'the single admin route is unchanged')
})

test('after the change succeeds the same panel renders normally (the session user now says false)', () => {
  assert.match(panelFor({ ...ADMIN, mustChangePassword: false }), /Panel administrativo/)
  // a session stored before the flag existed has no flag: it renders normally until GET /auth/me re-reads it (and the backend refuses anything else)
  const { mustChangePassword, ...legacy } = ADMIN
  void mustChangePassword
  assert.match(panelFor(legacy), /Panel administrativo/)
})

test('checking the stored session and being logged out still show their usual screens (no forced screen without a session)', () => {
  assert.match(panelFor(null, { authenticated: false, checking: true }), /Cargando…/)
  assert.match(panelFor(null, { authenticated: false }), /Acceso administrador/)
})

test('BUSINESS_INACTIVE keeps its priority and cannot loop: the suspended ADMIN has no session, so the login screen explains it — never the forced screen', () => {
  const html = panelFor(null, { authenticated: false, suspended: true })
  assert.match(html, /Acceso administrador/)
  assert.ok(html.includes(SUSPENDED_MESSAGE.replace(/'/g, '&#x27;')) || html.includes(SUSPENDED_MESSAGE))
  assert.doesNotMatch(html, /Debes cambiar tu contraseña/)
})

// ---- the form itself -----------------------------------------------------------------------------------------------
const stateStore = (state) => ({ getState: () => state, subscribe: () => () => {}, submit: async () => ({ ok: false }) })
const idle = { phase: 'idle', fieldErrors: {}, error: null }

test('form: three password fields with the right autocomplete hints, the rules, and nothing prefilled', () => {
  const html = mod.renderForm(stateStore(idle), ADMIN.email)
  assert.equal((html.match(/type="password"/g) ?? []).length, 3)
  assert.match(html, /autoComplete="current-password"|autocomplete="current-password"/i)
  assert.equal((html.match(/new-password/g) ?? []).length, 2)
  assert.match(html, /Mínimo 12 caracteres y máximo 72 bytes/)
  assert.doesNotMatch(html, /value="[^"]/, 'no field starts with a value')
  assert.match(html, />Cancelar</)
})

test('form: the backend\'s error shows next to its field (or below), the fields lock while saving, and the button says so', () => {
  const wrong = mod.renderForm(stateStore({ phase: 'idle', fieldErrors: { currentPassword: 'La contraseña actual no es correcta.' }, error: null }), ADMIN.email)
  assert.match(wrong, /La contraseña actual no es correcta\./)
  assert.match(wrong, /aria-invalid="true"/)
  const general = mod.renderForm(stateStore({ phase: 'idle', fieldErrors: {}, error: { kind: 'rate-limited', message: 'Hiciste demasiados intentos. Espera un minuto e inténtalo nuevamente.' } }), ADMIN.email)
  assert.match(general, /role="alert"[^>]*>Hiciste demasiados intentos/)
  const saving = mod.renderForm(stateStore({ phase: 'saving', fieldErrors: {}, error: null }), ADMIN.email)
  assert.match(saving, /Guardando…/)
  assert.equal((saving.match(/disabled=""/g) ?? []).length >= 4, true, 'three inputs and the buttons are disabled while the request is in flight')
})

// ---- wiring --------------------------------------------------------------------------------------------------------------
test('the voluntary option reuses the same form, store and endpoint as the forced screen (no duplicated logic)', () => {
  const dialog = code(read('./PasswordChangeDialog.jsx'))
  const forced = code(read('./ForcedPasswordChange.jsx'))
  for (const source of [dialog, forced]) {
    assert.match(source, /import PasswordChangeForm from '\.\/PasswordChangeForm\.jsx'/)
    assert.match(source, /createPasswordChangeStore\(\{ change: changePassword \}\)/)
  }
  assert.doesNotMatch(dialog + forced, /apiFetch|\/auth\/change-password/, 'only AuthContext talks to the endpoint')
  const panel = code(read('../pages/admin/AdminPanel.jsx'))
  assert.match(panel, /onClick=\{\(\) => setPasswordDialogOpen\(true\)\}/)
  assert.match(panel, /\{passwordDialogOpen && <PasswordChangeDialog onClose=\{\(\) => setPasswordDialogOpen\(false\)\} \/>\}/)
  assert.match(dialog, /disableEscape: phase === 'saving'/, 'Escape cannot close it while the request is in flight')
  assert.match(dialog, /toast\.success\('Contraseña actualizada\./)
  assert.doesNotMatch(dialog.match(/toast\.success\([^\n]*\)/)[0], /\$\{|password|currentPassword|newPassword/, 'the toast is a fixed sentence: nothing interpolated, nothing secret')
})

test('dark mode / themes: the new screens use the shared token classes and tokens only', () => {
  const css = code(read('../styles/index.css'))
  const start = css.indexOf('.password-form {')
  const block = css.slice(start, css.indexOf('@media print', start))
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|:\s*(white|black)\b/)
  assert.match(block, /\.password-form input:focus-visible \{[^}]*var\(--focus-ring\)/)
  const forced = code(read('./ForcedPasswordChange.jsx'))
  assert.match(forced, /<ThemeToggle \/>/)
  assert.match(forced, /className="admin-login"/, 'same look as the login screen')
})
