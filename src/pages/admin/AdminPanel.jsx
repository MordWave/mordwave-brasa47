import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { apiFetch } from '../../services/api'
import AdminApp from '../AdminApp'
import AdminBusiness from './AdminBusiness'
import AdminLogin from './AdminLogin'
import AdminMenu from './AdminMenu'
import AdminTables from './AdminTables'

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
  const [tab, setTab] = useState('pedidos')
  const [business, setBusiness] = useState(null)

  // Cosmetic only — used for the header eyebrow and print templates.
  // AdminBusiness.jsx keeps its own independent GET/PATCH for actually
  // editing this data; this is just a read for display elsewhere in the
  // panel, refreshed via onBusinessSaved once the admin changes something.
  const loadBusiness = useCallback(async () => {
    try {
      const data = await apiFetch('/businesses/me', { token })
      setBusiness(data)
    } catch {
      // Branding is cosmetic — a failed fetch just keeps the neutral
      // fallback, never blocks the rest of the panel.
    }
  }, [token])

  useEffect(() => {
    if (isAuthenticated) loadBusiness()
  }, [isAuthenticated, loadBusiness])

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
    <div className="admin-panel">
      <header className="admin-panel__header">
        <div>
          <p className="admin__eyebrow">{business?.name || FALLBACK_BUSINESS_NAME}</p>
          <h1 className="admin__title">Panel administrativo</h1>
        </div>
        <div className="admin-panel__user">
          <span className="admin-panel__user-email">{user.email}</span>
          <button type="button" className="btn btn--outline btn--small" onClick={handleLogout}>
            Cerrar sesión
          </button>
        </div>
      </header>

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

      {tab === 'pedidos' && <AdminApp businessName={business?.name || FALLBACK_BUSINESS_NAME} />}
      {tab === 'menu' && <AdminMenu />}
      {tab === 'mesas' && <AdminTables businessName={business?.name || FALLBACK_BUSINESS_NAME} />}
      {tab === 'negocio' && <AdminBusiness onBusinessSaved={setBusiness} />}
    </div>
  )
}
