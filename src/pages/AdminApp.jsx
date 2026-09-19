import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { apiFetch } from '../services/api'
import { translateApiError } from '../services/errorMessages'
import OrderCard from '../components/admin/OrderCard'
import PrintTicket from '../components/admin/PrintTicket'
import { getActiveSessions, closeTableSession, buildDemoQrUrl } from '../utils/tableSession'

const NEW_POLL_MS = 5000
const DELIVERED_POLL_MS = 60000
const HISTORY_LIMIT = 50

function QrDemoTool() {
  const [tableInput, setTableInput] = useState('1')
  const [copied, setCopied] = useState(false)
  const trimmed = tableInput.trim()
  const url = trimmed ? buildDemoQrUrl(trimmed) : ''

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard API unavailable — the link is still shown below to copy by hand.
    }
  }

  return (
    <section className="admin__qr-tool">
      <p className="admin__qr-tool-title">
        Generar QR de mesa <span>(solo demo)</span>
      </p>
      <div className="admin__qr-tool-row">
        <input
          className="admin__qr-tool-input"
          type="text"
          inputMode="numeric"
          value={tableInput}
          onChange={(e) => setTableInput(e.target.value)}
          aria-label="Número de mesa"
        />
        {url && (
          <a className="admin__qr-tool-link" href={url} target="_blank" rel="noreferrer">
            Abrir
          </a>
        )}
        <button type="button" className="admin__qr-tool-copy" onClick={handleCopy} disabled={!url}>
          {copied ? 'Copiado' : 'Copiar link'}
        </button>
      </div>
      {url && <code className="admin__qr-tool-url">{url}</code>}
    </section>
  )
}

export default function AdminApp() {
  const { token } = useAuth()
  const [newOrders, setNewOrders] = useState([])
  const [deliveredOrders, setDeliveredOrders] = useState([])
  const [cancelledOrders, setCancelledOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [cancelledOpen, setCancelledOpen] = useState(false)
  const [cancelTarget, setCancelTarget] = useState(null)
  const [sessions, setSessions] = useState(getActiveSessions)
  const [printOrder, setPrintOrder] = useState(null)
  const [tablesOpen, setTablesOpen] = useState(false)

  const loadNew = useCallback(async () => {
    try {
      const data = await apiFetch('/orders/admin?status=NEW', { token })
      setNewOrders(data)
    } catch (err) {
      setError(translateApiError(err))
    } finally {
      setLoading(false)
    }
  }, [token])

  const loadDelivered = useCallback(async () => {
    try {
      const data = await apiFetch(`/orders/admin?status=DELIVERED&limit=${HISTORY_LIMIT}`, { token })
      setDeliveredOrders(data)
    } catch (err) {
      setError(translateApiError(err))
    }
  }, [token])

  // Nuevos: cola activa, se refresca seguido. Entregados: se carga al
  // montar y se refresca cada bastante más — ya no se borran, así que solo
  // crece, y no hace falta verlo cambiar en tiempo real.
  useEffect(() => {
    loadNew()
    const interval = setInterval(loadNew, NEW_POLL_MS)
    return () => clearInterval(interval)
  }, [loadNew])

  useEffect(() => {
    loadDelivered()
    const interval = setInterval(loadDelivered, DELIVERED_POLL_MS)
    return () => clearInterval(interval)
  }, [loadDelivered])

  // Mesas demo: sigue siendo localStorage, sin cambios.
  useEffect(() => {
    const refresh = () => setSessions(getActiveSessions())
    const interval = setInterval(refresh, 2000)
    window.addEventListener('storage', refresh)
    return () => {
      clearInterval(interval)
      window.removeEventListener('storage', refresh)
    }
  }, [])

  async function handleDeliver(order) {
    setError('')
    try {
      const updated = await apiFetch(`/orders/${order.id}/status`, {
        method: 'PATCH',
        token,
        body: JSON.stringify({ status: 'DELIVERED' }),
      })
      setNewOrders((prev) => prev.filter((o) => o.id !== order.id))
      setDeliveredOrders((prev) => [updated, ...prev])
    } catch (err) {
      setError(translateApiError(err))
    }
  }

  async function handleConfirmCancel() {
    if (!cancelTarget) return
    setError('')
    const target = cancelTarget
    setCancelTarget(null)
    try {
      const updated = await apiFetch(`/orders/${target.id}/status`, {
        method: 'PATCH',
        token,
        body: JSON.stringify({ status: 'CANCELLED' }),
      })
      setNewOrders((prev) => prev.filter((o) => o.id !== target.id))
      setCancelledOrders((prev) => [updated, ...prev])
    } catch (err) {
      setError(translateApiError(err))
    }
  }

  async function handleToggleCancelled() {
    const opening = !cancelledOpen
    setCancelledOpen(opening)
    if (!opening) return
    try {
      const data = await apiFetch(`/orders/admin?status=CANCELLED&limit=${HISTORY_LIMIT}`, { token })
      setCancelledOrders(data)
    } catch (err) {
      setError(translateApiError(err))
    }
  }

  function handlePrint(order) {
    setPrintOrder(order)
    setTimeout(() => {
      window.print()
      setPrintOrder(null)
    }, 50)
  }

  function handleCloseSession(table) {
    setSessions(closeTableSession(table))
  }

  const COLUMNS = [
    { status: 'nuevo', label: 'Nuevos', orders: newOrders },
    { status: 'entregado', label: 'Entregados', orders: deliveredOrders },
  ]

  return (
    <div className="admin">
      <header className="admin__header">
        <div>
          <p className="admin__eyebrow">BRASA 47</p>
          <h1 className="admin__title">Panel de pedidos</h1>
        </div>
        <span className="admin__badge">{newOrders.length} nuevos</span>
      </header>

      {error && <p className="admin-menu__error">{error}</p>}

      <section className="admin__tables">
        <button
          type="button"
          className="admin__tables-toggle"
          onClick={() => setTablesOpen((open) => !open)}
          aria-expanded={tablesOpen}
        >
          <span>Gestión de mesas</span>
          <span className="admin__tables-toggle-meta">
            {sessions.length > 0 && (
              <span className="admin__tables-count">
                {sessions.length} activa{sessions.length !== 1 ? 's' : ''}
              </span>
            )}
            <span
              className={`admin__tables-chevron${tablesOpen ? ' admin__tables-chevron--open' : ''}`}
              aria-hidden="true"
            >
              ⌄
            </span>
          </span>
        </button>

        {tablesOpen && (
          <div className="admin__tables-body">
            {sessions.length > 0 ? (
              <div className="admin__sessions">
                <h3 className="admin__sessions-title">Mesas activas</h3>
                <div className="admin__sessions-list">
                  {sessions.map((s) => (
                    <div key={s.table} className="session-chip">
                      <div className="session-chip__info">
                        <span className="session-chip__table">Mesa {s.table}</span>
                        <span className="session-chip__meta">
                          {s.mode === 'qr' ? 'QR' : 'Demo manual'} · Código {s.sessionCode}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="session-chip__close"
                        onClick={() => handleCloseSession(s.table)}
                      >
                        Cerrar mesa
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="empty-state">No hay mesas activas en este momento.</p>
            )}

            <QrDemoTool />
          </div>
        )}
      </section>

      <div className="admin__board">
        {loading ? (
          <p className="empty-state">Cargando pedidos…</p>
        ) : (
          COLUMNS.map(({ status, label, orders }) => (
            <section key={status} className={`admin__column admin__column--${status}`}>
              <div className="admin__column-head">
                <h2 className="admin__column-title">
                  {label} <span>{orders.length}</span>
                </h2>
              </div>
              <div className="admin__column-list">
                {orders.length === 0 && <p className="empty-state">Sin pedidos</p>}
                {orders.map((order) => (
                  <OrderCard
                    key={order.id}
                    order={order}
                    onDeliver={handleDeliver}
                    onCancel={setCancelTarget}
                    onPrint={handlePrint}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </div>

      <section className="admin__cancelled">
        <button
          type="button"
          className="admin__cancelled-toggle"
          onClick={handleToggleCancelled}
          aria-expanded={cancelledOpen}
        >
          <span>Cancelados ({cancelledOrders.length})</span>
          <span
            className={`admin__cancelled-chevron${cancelledOpen ? ' admin__cancelled-chevron--open' : ''}`}
            aria-hidden="true"
          >
            ⌄
          </span>
        </button>

        {cancelledOpen && (
          <div className="admin__cancelled-body">
            {cancelledOrders.length === 0 ? (
              <p className="empty-state">No hay pedidos cancelados.</p>
            ) : (
              <div className="admin__cancelled-list">
                {cancelledOrders.map((order) => (
                  <OrderCard key={order.id} order={order} onPrint={handlePrint} />
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      <PrintTicket order={printOrder} />

      {cancelTarget && (
        <div className="confirm-backdrop" onClick={() => setCancelTarget(null)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <p className="confirm-dialog__text">¿Cancelar el pedido #{cancelTarget.orderNumber}?</p>
            <p className="confirm-dialog__subtext">Esta acción no se puede deshacer.</p>
            <div className="confirm-dialog__actions">
              <button
                type="button"
                className="btn btn--outline btn--small"
                onClick={() => setCancelTarget(null)}
              >
                Volver
              </button>
              <button
                type="button"
                className="btn btn--primary btn--small"
                onClick={handleConfirmCancel}
              >
                Cancelar pedido
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
