import { useState } from 'react'
import { useAuth } from '../../context/AuthContext'
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

export default function AdminPanel() {
  const { isAuthenticated, checking, user, logout } = useAuth()
  const [tab, setTab] = useState('pedidos')

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
          <p className="admin__eyebrow">BRASA 47</p>
          <h1 className="admin__title">Panel administrativo</h1>
        </div>
        <div className="admin-panel__user">
          <span className="admin-panel__user-email">{user.email}</span>
          <button type="button" className="btn btn--outline btn--small" onClick={logout}>
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

      {tab === 'pedidos' && <AdminApp />}
      {tab === 'menu' && <AdminMenu />}
      {tab === 'mesas' && <AdminTables />}
      {tab === 'negocio' && <AdminBusiness />}
    </div>
  )
}
