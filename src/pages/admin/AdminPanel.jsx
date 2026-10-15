import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import ThemeToggle from '../../components/ThemeToggle'
import { useAuth } from '../../context/AuthContext'
import { ConfirmProvider } from '../../context/ConfirmContext'
import { ToastProvider } from '../../context/ToastContext'
import { DEV_TOOLS_BUILD_ENABLED } from '../../devtools/buildFlag.js'
import { apiFetch } from '../../services/api'
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
  const { businessId, requiresBusinessSelection, scopePath } = useActiveBusiness()
  const [tab, setTab] = useState('pedidos')
  const [business, setBusiness] = useState(null)

  // Cosmetic only — used for the header eyebrow and print templates.
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
    if (isAuthenticated && !requiresBusinessSelection) loadBusiness()
  }, [isAuthenticated, requiresBusinessSelection, loadBusiness])

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
              <button type="button" className="btn btn--outline btn--small" onClick={handleLogout}>
                Cerrar sesión
              </button>
            </div>
          </header>

          {requiresBusinessSelection ? (
            // SUPER_ADMIN with no business chosen: nothing is requested, so no unscoped (cross-tenant) list is ever
            // shown. The business selector itself is a later step.
            <section className="admin-panel__no-business" role="status">
              <h2>Selecciona un negocio</h2>
              <p>Tu cuenta no está asociada a un negocio. Elige uno para ver y gestionar sus pedidos, menú y mesas.</p>
            </section>
          ) : (
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

              {/* keyed by the active business: switching it remounts the panels, so nothing from the previous
                  business (lists, pollers, form state) survives. For an ADMIN the key never changes. */}
              {tab === 'pedidos' && <AdminApp key={businessId} businessName={business?.name || FALLBACK_BUSINESS_NAME} />}
              {tab === 'menu' && <AdminMenu key={businessId} />}
              {tab === 'mesas' && <AdminTables key={businessId} businessName={business?.name || FALLBACK_BUSINESS_NAME} />}
              {tab === 'negocio' && <AdminBusiness key={businessId} onBusinessSaved={setBusiness} />}
            </>
          )}
        </div>
      </ConfirmProvider>
    </ToastProvider>
  )
}
