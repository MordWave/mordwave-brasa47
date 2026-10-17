import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import ForcedPasswordChange from '../../account/ForcedPasswordChange'
import PasswordChangeDialog from '../../account/PasswordChangeDialog'
import ThemeToggle from '../../components/ThemeToggle'
import { useAuth } from '../../context/AuthContext'
import { ConfirmProvider } from '../../context/ConfirmContext'
import { needsPasswordChange } from '../../context/passwordChange.js'
import { ToastProvider } from '../../context/ToastContext'
import { DEV_TOOLS_BUILD_ENABLED } from '../../devtools/buildFlag.js'
import { apiFetch } from '../../services/api'
import BusinessGate from '../../tenant/selector/BusinessGate'
import { useActiveBusiness } from '../../tenant/useActiveBusiness'
import AdminApp from '../AdminApp'
import AdminBusiness from './AdminBusiness'
import AdminLogin from './AdminLogin'
import AdminMenu from './AdminMenu'
import AdminTables from './AdminTables'

// Developer tools ("Ver como"): with VITE_DEV_TOOLS_ENABLED unset this is the constant `null`, the lazy imports are
// dropped from the bundle and nothing at all is rendered.
const ViewAsSelector = DEV_TOOLS_BUILD_ENABLED
  ? lazy(() => import('../../devtools/DevToolsUi.jsx').then((m) => ({ default: m.ViewAsSelector })))
  : null
const ViewAsBanner = DEV_TOOLS_BUILD_ENABLED
  ? lazy(() => import('../../devtools/DevToolsUi.jsx').then((m) => ({ default: m.ViewAsBanner })))
  : null

const TABS = [
  { key: 'pedidos', label: 'Pedidos' },
  { key: 'menu', label: 'Menú' },
  { key: 'mesas', label: 'Mesas' },
  { key: 'negocio', label: 'Negocio' },
]

// Neutral MordWave branding is the only thing shown before a business is
// resolved (AdminLogin) or while/if this fetch hasn't produced one yet —
// this panel is post-auth, so a tenant DOES exist, this is purely a brief
// loading/error fallback, never a "no tenant known" state.
const FALLBACK_BUSINESS_NAME = 'MordWave'

export default function AdminPanel() {
  const { isAuthenticated, checking, user, token, logout } = useAuth()
  const { businessId, isBusinessSelectable, scopePath } = useActiveBusiness()
  const [tab, setTab] = useState('pedidos')
  const [business, setBusiness] = useState(null)
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false)
  // The backend requires a password change before anything else (user.mustChangePassword, from the server's own answers).
  const mustChangePassword = needsPasswordChange(user)

  // Cosmetic only — used for the header eyebrow and print templates. (For a SUPER_ADMIN the selector gate loads and
  // verifies the chosen business itself and hands it over through onBusiness.)
  // AdminBusiness.jsx keeps its own independent GET/PATCH for actually
  // editing this data; this is just a read for display elsewhere in the
  // panel, refreshed via onBusinessSaved once the admin changes something.
  const loadBusiness = useCallback(async () => {
    try {
      const data = await apiFetch(scopePath('/businesses/me'), { token })
      setBusiness(data)
    } catch {
      // Branding is cosmetic — a failed fetch just keeps the neutral
      // fallback, never blocks the rest of the panel.
    }
  }, [token, scopePath])

  useEffect(() => {
    if (isAuthenticated && !isBusinessSelectable && !mustChangePassword) loadBusiness()
  }, [isAuthenticated, mustChangePassword, isBusinessSelectable, loadBusiness])

  // A different active business (only a SUPER_ADMIN can change it) must never show the previous one's name.
  useEffect(() => {
    setBusiness(null)
  }, [businessId])

  // Without this, a logout followed by a different admin (different
  // business) logging in on the same tab would briefly show the PREVIOUS
  // tenant's name in the header until the new fetch resolves.
  function handleLogout() {
    setBusiness(null)
    logout()
  }

  if (checking) {
    return <div className="admin-panel__loading">Cargando…</div>
  }

  if (!isAuthenticated) {
    return <AdminLogin />
  }

  // While a password change is required this is the ONLY thing rendered: no panels, no business selector, no polling,
  // no administrative request. It is left by changing the password (the session is replaced) or by logging out.
  if (mustChangePassword) {
    return <ForcedPasswordChange />
  }

  // The Admin itself: tabs and panels. Keyed by the active business: switching it remounts them, so nothing from the
  // previous business (lists, pollers, form state, in-flight answers) survives. For an ADMIN the key never changes.
  const panels = (
    <>
      <nav className="admin-panel__tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`admin-panel__tab${tab === t.key ? ' admin-panel__tab--active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'pedidos' && <AdminApp key={businessId} businessName={business?.name || FALLBACK_BUSINESS_NAME} />}
      {tab === 'menu' && <AdminMenu key={businessId} />}
      {tab === 'mesas' && <AdminTables key={businessId} businessName={business?.name || FALLBACK_BUSINESS_NAME} />}
      {tab === 'negocio' && <AdminBusiness key={businessId} onBusinessSaved={setBusiness} />}
    </>
  )

  return (
    <ToastProvider>
      <ConfirmProvider>
        <div className="admin-panel">
          {ViewAsBanner && (
            <Suspense fallback={null}>
              <ViewAsBanner />
            </Suspense>
          )}
          <header className="admin-panel__header">
            <div>
              <p className="admin__eyebrow">{business?.name || FALLBACK_BUSINESS_NAME}</p>
              <h1 className="admin__title">Panel administrativo</h1>
            </div>
            <div className="admin-panel__user">
              {ViewAsSelector && (
                <Suspense fallback={null}>
                  <ViewAsSelector />
                </Suspense>
              )}
              <ThemeToggle />
              <span className="admin-panel__user-email">{user.email}</span>
              <button type="button" className="btn btn--outline btn--small" onClick={() => setPasswordDialogOpen(true)}>
                Cambiar contraseña
              </button>
              <button type="button" className="btn btn--outline btn--small" onClick={handleLogout}>
                Cerrar sesión
              </button>
            </div>
          </header>

          {/* An ADMIN renders the panels directly (no gate, no GET /businesses). A real SUPER_ADMIN goes through the
              selector gate: picker -> verified business -> these same panels, keyed by business. */}
          {isBusinessSelectable ? <BusinessGate onBusiness={setBusiness}>{panels}</BusinessGate> : panels}

          {passwordDialogOpen && <PasswordChangeDialog onClose={() => setPasswordDialogOpen(false)} />}
        </div>
      </ConfirmProvider>
    </ToastProvider>
  )
}
